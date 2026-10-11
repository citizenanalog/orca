// The one thing that starts a provider child for a send, the one thing that hands a message to
// it, and the one thing that settles a queued message because of a start, a child or a leftover.
//
// A send is accepted on its own serialized step and returns; this loop does the rest. It exists
// for a session exactly while a message is queued there — accepted, not yet handed over — and no
// child is running a conversation command: a command's turn takes no input, and the commit that
// ends it wakes the loop again. Each step re-reads the journal and the conversation's child
// record to decide. Starting and readiness run outside the serialized admission steps, so Stop
// may withdraw queued messages before handover. Stop and the conversation's close are the other writers of a
// queued message: a child's exit only ends the child, and this loop reads why. A message an
// earlier host process left queued is never handed over: the open, or this loop's first step,
// settles it first (`journal-unsent-send-hold.ts`).

import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import { oldestQueuedSubmission } from './structured-agent-session-start-failure-row'
import { handOverSubmission } from './structured-agent-session-turns'
import { structuredAgentSessionNextHandover } from './structured-agent-session-opening-send'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { holdRestartedStructuredAgentSessionSends } from './structured-agent-session-host-lifetime'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import {
  closeWhatTheUserClosed,
  recordFailedQueuedDelivery,
  refusedQueuedStart,
  startThatFailedWhileQueued,
  type StartFailure
} from './structured-agent-session-delivery-settlement'

export type StructuredAgentSessionDeliveryLoopDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  agents: StructuredAgentRegistry
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** A start step, tracked from enqueue so quit waits for the child it may produce. */
  trackStart: <T>(start: Promise<T>) => Promise<T>
  startupAttempts: Pick<StructuredAgentSessionStartupAttempts, 'wait'>
  recoverRewind: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ) => Promise<boolean>
  /** Starts a child for `startedFor`, the queued message at the head, if the session has none. */
  ensureProviderChild: (
    sessionId: string,
    startedFor: string
  ) => Promise<StructuredAgentSessionResumeOutcome>
  /** The fence the conversation's own writes carry; see `structuredAgentSessionConversationFence`. */
  conversationFence: (sessionId: string) => number
  /** Settles queued messages as a completed close of the chat does; false when that failed. */
  holdClosed: (
    sessionId: string,
    which: (submission: AgentJournalSubmission) => boolean
  ) => Promise<boolean>
  /** Who the chat's failure sentences name. */
  failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  logger: StructuredAgentSessionLogger
  record: (sessionId: string) => AgentSessionRecord | null
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  /** A person's Stop is still ending the session's work: the status feed's own reading. */
  stopping: (sessionId: string) => boolean
  now: () => number
}

type Step = 'continue' | 'stop'

type Prepared = 'stop' | { ok: true; startedFor: string }

export class StructuredAgentSessionDeliveryLoop {
  private readonly running = new Set<string>()
  private readonly runs = new Map<string, Promise<void>>()
  private disposed = false

  constructor(private readonly deps: StructuredAgentSessionDeliveryLoopDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Quit: no step after this one starts a child or hands a message over. */
  dispose(): void {
    this.disposed = true
  }

  /** From inside the session's serialize, after a message was accepted or the conversation
   *  opened. A loop already running re-reads the journal on its next step. Settles once the loop
   *  has handed over all it can; never rejects. */
  wake(sessionId: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    if (this.running.has(sessionId)) {
      return this.runs.get(sessionId) ?? Promise.resolve()
    }
    this.running.add(sessionId)
    const run = this.run(sessionId).finally(() => {
      if (this.runs.get(sessionId) === run) {
        this.runs.delete(sessionId)
      }
    })
    this.runs.set(sessionId, run)
    return run
  }

  private async run(sessionId: string): Promise<void> {
    try {
      for (;;) {
        const prepared = await this.deps.serialize(sessionId, () => this.prepare(sessionId))
        if (prepared === 'stop') {
          return
        }
        const started = await this.deps.trackStart(
          this.deps.ensureProviderChild(sessionId, prepared.startedFor)
        )
        if (!started.ok) {
          if (started.aborted) {
            // A close, Stop or quit stopped this start on purpose, and settled what it was for; a
            // message accepted since gets its own start, and quit's next step stops the loop.
            continue
          }
          const through = this.deps.sessions.get(sessionId)?.journal.cursor()
          await this.deps.serialize(sessionId, () =>
            this.fail(sessionId, refusedQueuedStart(this.deps, sessionId, started), through)
          )
          return
        }
        const child = this.deps.sessions.get(sessionId)?.child
        const awaited = child ? { generation: child.generation, fence: child.fence } : null
        if (child?.phase === 'starting' && child.startAttemptId) {
          try {
            await this.deps.startupAttempts.wait(sessionId, child.startAttemptId, child)
          } catch {
            // The resumed serialized step reads the end and its journal order.
          }
        }
        if (awaited && this.deps.sessions.get(sessionId)?.child?.phase === 'ready') {
          const recovered = await this.deps.recoverRewind(sessionId, awaited)
          const current = this.deps.sessions.get(sessionId)?.child
          if (
            !recovered &&
            current?.phase === 'ready' &&
            !current.close &&
            current.generation === awaited.generation &&
            current.fence === awaited.fence
          ) {
            const through = this.deps.sessions.get(sessionId)?.journal.cursor()
            await this.deps.serialize(sessionId, () =>
              this.fail(
                sessionId,
                {
                  startKey: awaited.generation,
                  cause: { failure: agentSessionFailureFact('notDelivered') }
                },
                through
              )
            )
            return
          }
        }
        const handed = await this.deps.serialize(sessionId, () => this.handOver(sessionId, awaited))
        if (handed === 'stop') {
          return
        }
      }
    } catch (error) {
      // The error is Orca's own and goes to the log; the chat says only that Orca failed.
      this.deps.logger.warn('delivering a queued message failed', {
        scope: 'delivery-loop',
        sessionId,
        error
      })
      const cause = { hostFault: true } as const
      await this.deps
        .serialize(sessionId, () => this.fail(sessionId, { startKey: null, cause }))
        .catch((failure: unknown) => {
          // Rows left queued go to the next loop an accept wakes, or the next open settles them.
          this.running.delete(sessionId)
          this.deps.logger.warn('recording a failed delivery failed', {
            scope: 'delivery-loop-fail',
            sessionId,
            error: failure
          })
        })
    }
  }

  /** Settles what an earlier host process left queued, then makes the session ready. */
  private async prepare(sessionId: string): Promise<Prepared> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // The open already did, unless its write failed: a row an earlier handle wrote is never handed
    // over, whether it outlived a quit or a crash. A failure here throws, so none is: this run then
    // fails, which rejects every queued send, this process's own too.
    await holdRestartedStructuredAgentSessionSends(
      this.deps.logger,
      sessionId,
      session.journal,
      this.deps.conversationFence(sessionId)
    )
    if (!(await closeWhatTheUserClosed(this.deps, sessionId, session))) {
      // Never start an agent for a message the user closed; the next wake re-derives and retries.
      return this.stop(sessionId)
    }
    const oldest = oldestQueuedSubmission(session)
    // A running command takes no input while its child carries it; its end is a commit, which
    // wakes the loop again. With no child it is a gone generation's, which the start below settles.
    if (!oldest || (session.child && structuredAgentSessionCommandRunning(session.journal))) {
      return this.stop(sessionId)
    }
    const failedStart = startThatFailedWhileQueued(session, oldest)
    if (failedStart) {
      return this.fail(sessionId, failedStart)
    }
    return { ok: true, startedFor: oldest.clientMessageId }
  }

  private async handOver(
    sessionId: string,
    awaited: StructuredAgentSessionProviderChildIdentity | null
  ): Promise<Step> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // Re-derived here, not carried from the start: the child may have ended, or another may have
    // taken its place, since.
    const { child } = session
    const awaitedChild =
      child && awaited && child.generation === awaited.generation && child.fence === awaited.fence
        ? child
        : null
    if (!awaitedChild) {
      // The child started for this message is gone or replaced by another.
      const ended = awaitedChild ? undefined : session.lastEndedChild
      const endedFailure = ended ? structuredAgentSessionEndedChildFailure(ended) : undefined
      // A user's Stop or close is not a failure: the next step starts, or waits on, a child for
      // what is queued, after closing what a close of the chat closed.
      if (endedFailure === null) {
        return 'continue'
      }
      return this.fail(sessionId, {
        startKey: awaited?.generation ?? null,
        ...(ended ? { through: ended.endedAt } : {}),
        cause: endedFailure ??
          // Gone with no end observed: nothing says the provider stopped.
          { failure: agentSessionFailureFact('startFailed') }
      })
    }
    // Never steer into a turn a person's Stop is ending: the message runs after it, as its own
    // turn, and the turn's end is a commit that wakes the loop again. Read here, at the handover,
    // because a Stop can take the lane between the step that judged the send and this one.
    // Nor hand anything to a child still proving its start: nothing is written until it is
    // `ready`, whose settlement wakes the loop, so a start that fails leaves the message unsent.
    if (this.deps.stopping(sessionId) || awaitedChild.phase === 'starting') {
      return this.stop(sessionId)
    }
    // None while a turn is still opening: joining it would record the message ahead of it.
    const next = structuredAgentSessionNextHandover(session, awaitedChild.fence)
    if (!next) {
      return this.stop(sessionId)
    }
    await handOverSubmission(
      {
        sessionId,
        journal: session.journal,
        fence: awaitedChild.fence,
        adapter: this.deps.adapter,
        agents: this.deps.agents,
        failureTextContext: this.deps.failureTextContext(sessionId),
        record: () => this.deps.record(sessionId),
        childWork: () => this.deps.readChildWork(sessionId),
        now: this.deps.now
      },
      next
    )
    return 'continue'
  }

  private async fail(
    sessionId: string,
    failure: StartFailure,
    through?: AgentJournalCursor
  ): Promise<'stop'> {
    const wake = await recordFailedQueuedDelivery(this.deps, sessionId, failure, through)
    const stopped = this.stop(sessionId)
    if (wake) {
      queueMicrotask(() => {
        void this.wake(sessionId)
      })
    }
    return stopped
  }

  /** Inside the serialized step that found nothing to do, so an accept after it wakes anew. */
  private stop(sessionId: string): 'stop' {
    this.running.delete(sessionId)
    return 'stop'
  }
}
