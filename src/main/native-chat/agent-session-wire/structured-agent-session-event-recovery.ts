import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type {
  StructuredAgentSessionLifecycleEvent,
  StructuredAgentSessionStartedEvent,
  StructuredAgentSessionEndedEvent,
  StructuredAgentSessionOptionsReportedEvent,
  StructuredAgentSessionOptionsSkippedEvent
} from './structured-agent-session-adapter'
import { holdUnsentSends } from '../agent-session-journal/journal-unsent-send-hold'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import {
  settleStructuredAgentSessionOptionsReported,
  settleStructuredAgentSessionOptionsSkipped,
  settleStructuredAgentSessionProviderStarted
} from './structured-agent-session-provider-started'
import {
  endExitedStructuredAgentSessionChildUnderSerialize,
  settleStructuredAgentSessionChildExit,
  type StructuredAgentSessionChildExit,
  type StructuredAgentSessionChildExitContext
} from './structured-agent-session-child-exit'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { sameProviderChild } from './structured-agent-session-provider-child'

export class StructuredAgentSessionEventRecovery {
  private readonly sinkFailures = new Set<string>()
  private readonly earlyStarted = new Map<string, StructuredAgentSessionStartedEvent>()
  private readonly earlyEnded = new Map<string, StructuredAgentSessionEndedEvent>()

  constructor(
    private readonly context: {
      deps: StructuredAgentSessionHostDeps
      store: StructuredAgentSessionHostDeps['store']
      sessions: Map<string, StructuredAgentSessionHostSession>
      flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
      publishFence: (sessionId: string, session: StructuredAgentSessionHostSession) => void
      publishStatus?: (sessionId: string) => void
      serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
      now: () => number
      runtimeState: StructuredAgentSessionHostRuntimeState
      wakeDelivery: (sessionId: string) => Promise<void>
      stopStartingChild: (
        sessionId: string,
        child: StructuredAgentSessionProviderChildIdentity
      ) => void
    }
  ) {}

  private get exitContext(): StructuredAgentSessionChildExitContext {
    const { deps, runtimeState } = this.context
    return {
      ...this.context,
      logger: deps.logger,
      startupAttempts: runtimeState.startupAttempts,
      holdUnrunSends: async (sessionId, fence, cause) => {
        const journal = this.context.sessions.get(sessionId)?.journal
        if (journal) {
          await holdUnsentSends(journal, {
            fence,
            hostInstance: structuredAgentSessionHostInstance(),
            hold: { cause },
            unrun: true
          })
        }
      },
      route: {
        runtimeState,
        acknowledgeRelease: (sessionId) => deps.adapter.acknowledgeSessionRelease?.(sessionId)
      }
    }
  }

  /** The one exit handler, for a caller inside the session's serialize that proved the exit. */
  endExitedChildUnderSerialize = (
    sessionId: string,
    child: StructuredAgentSessionProviderChild,
    exit: StructuredAgentSessionChildExit
  ): Promise<void> =>
    endExitedStructuredAgentSessionChildUnderSerialize(this.exitContext, sessionId, child, exit)

  childPublished(sessionId: string): void {
    const event = this.earlyStarted.get(sessionId)
    this.earlyStarted.delete(sessionId)
    const ended = this.earlyEnded.get(sessionId)
    this.earlyEnded.delete(sessionId)
    const child = this.context.sessions.get(sessionId)?.child
    if (!child) {
      return
    }
    if (
      ended &&
      sameProviderChild(child, {
        generation: ended.acquisitionGeneration,
        fence: ended.fence
      })
    ) {
      void settleStructuredAgentSessionChildExit(
        this.exitContext,
        ended,
        !!event && event.acquisitionGeneration === ended.acquisitionGeneration
      ).catch((error: unknown) =>
        this.context.deps.logger.warn('settling a provider exit reported during acquire failed', {
          scope: 'provider-ended',
          sessionId,
          error
        })
      )
      return
    }
    if (!event) {
      return
    }
    if (
      !sameProviderChild(child, {
        generation: event.acquisitionGeneration,
        fence: event.fence
      })
    ) {
      return
    }
    void settleStructuredAgentSessionProviderStarted(this.context, event).catch((error: unknown) =>
      this.context.deps.logger.warn('settling a provider start reported during acquire failed', {
        scope: 'provider-started',
        sessionId,
        error
      })
    )
  }

  discardUnpublished(sessionId: string): void {
    this.earlyStarted.delete(sessionId)
    this.earlyEnded.delete(sessionId)
  }

  private async settleReport(
    event: StructuredAgentSessionOptionsReportedEvent | StructuredAgentSessionOptionsSkippedEvent
  ): Promise<void> {
    const identity = { generation: event.acquisitionGeneration, fence: event.fence }
    const child = this.context.sessions.get(event.sessionId)?.child
    if (child?.phase !== 'ready' || !sameProviderChild(child, identity)) {
      const joined = this.context.runtimeState.startupAttempts.reportReady(
        event.sessionId,
        identity
      )
      if (joined) {
        void joined
          .then(async (ready) => {
            if (!ready) {
              return
            }
            await this.context.wakeDelivery(event.sessionId)
            const current = this.context.sessions.get(event.sessionId)?.child
            if (current?.phase === 'ready' && sameProviderChild(current, identity)) {
              await this.settleReport(event)
            }
          })
          .catch((error: unknown) =>
            this.context.deps.logger.warn('settling a report after provider start failed', {
              scope: 'provider-options-report',
              sessionId: event.sessionId,
              error
            })
          )
      }
      return
    }
    return event.type === 'options-reported'
      ? settleStructuredAgentSessionOptionsReported(this.context, event)
      : settleStructuredAgentSessionOptionsSkipped(this.context, event)
  }

  recoverAfterSinkFailure(sessionId: string, error: unknown): void {
    if (this.sinkFailures.has(sessionId)) {
      return
    }
    this.sinkFailures.add(sessionId)
    void this.context
      .serialize(sessionId, async () => {
        const child = this.context.sessions.get(sessionId)?.child
        const stop =
          this.context.deps.adapter.forceCloseSession ?? this.context.deps.adapter.closeSession
        if (!child || !stop || !(await stopAgentSessionProviderRoot(() => stop(sessionId)))) {
          return
        }
        // Ended in the same step as the stop, so no report of that close can end it first as a
        // quiet rest: Orca stopped the provider because its own journal failed.
        await this.endExitedChildUnderSerialize(sessionId, child, {
          expected: false,
          reason: `journal sink failure: ${error instanceof Error ? error.message : String(error)}`,
          failure: agentSessionFailureFact('hostFault')
        })
      })
      .catch((error: unknown) =>
        this.context.deps.logger.warn(
          'stopping a provider after its journal failed did not finish',
          {
            scope: 'sink-failure-recovery',
            sessionId,
            error
          }
        )
      )
      .finally(() => this.sinkFailures.delete(sessionId))
  }

  /** Every child's exit ends its record here, expected or not. An exit is settled and shown;
   *  nothing restarts the child. The next send does, through the delivery loop, which also owns any
   *  message still queued. */
  async handle(event: StructuredAgentSessionLifecycleEvent): Promise<void> {
    const child = this.context.sessions.get(event.sessionId)?.child
    const notPublished =
      (!child ||
        !sameProviderChild(child, {
          generation: event.acquisitionGeneration,
          fence: event.fence
        })) &&
      this.context.runtimeState.startupAttempts.hasUnpublished(event.sessionId, event.fence)
    if (notPublished && event.type === 'ended') {
      this.earlyEnded.set(event.sessionId, event)
      return
    }
    if (event.type === 'started') {
      if (notPublished) {
        this.earlyStarted.set(event.sessionId, event)
        return
      }
      return settleStructuredAgentSessionProviderStarted(this.context, event)
    }
    if (event.type === 'options-reported' || event.type === 'options-skipped') {
      return this.settleReport(event)
    }
    if (
      !child ||
      !sameProviderChild(child, {
        generation: event.acquisitionGeneration,
        fence: event.fence
      })
    ) {
      return
    }
    await settleStructuredAgentSessionChildExit(this.exitContext, event)
  }
}
