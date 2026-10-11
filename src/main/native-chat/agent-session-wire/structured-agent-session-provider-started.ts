// The host's half of a provider child proving its start.
//
// Every acquire hands the host a child that has answered nothing yet, so the record keeps only the
// saved options the reservation carried, and the delivery loop hands it nothing. This is where the
// host learns the start landed: the provider handle the child answered with is recorded (a resume
// needs it), picks made meanwhile are applied, a rewind left in doubt is settled, the child turns
// `ready`, its startup attempt ends, and the loop wakes to hand over what was queued. A handle that
// cannot be recorded, or a rewind that stays in doubt, fails the start; a start whose limit passed
// first is never accepted.
// Only once that handover is done is what the child reports persisted, in a step of its own, so
// bookkeeping never sits between a ready child and the user's first message; a failed write is
// reported, never thrown. Every report is persisted only if no pick or later report came after its
// read (`option-revisions`).
//
// Provider calls run outside the session's serialized steps. Each short commit rechecks the
// child and the option revision before readiness becomes visible.

import type { StructuredAgentSessionStartedEvent } from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  markProviderChildStarted,
  sameProviderChild,
  structuredAgentSessionConversationFence
} from './structured-agent-session-provider-child'
import type { StructuredAgentSessionOptionRevisions } from './structured-agent-session-option-revisions'
import { saveStructuredAgentSessionStartListing } from './structured-agent-session-start-listing'
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'
import { recordAgentSessionProviderHandle } from '../../runtime/agent-session-provider-handle-transition'
import {
  applyStructuredAgentSessionStartupIntent,
  revertRefusedStartupIntent
} from './structured-agent-session-startup-intent'
import { recoverStructuredRewind } from './structured-rewind-recovery'
import { noteSignedOutStructuredAgentSessionChild } from './structured-agent-session-signed-out-child'
import {
  admitStructuredAgentSessionReportedOptions,
  persistStructuredAgentSessionReportedOptions
} from './structured-agent-session-provider-option-reports'
export {
  settleStructuredAgentSessionOptionsReported,
  settleStructuredAgentSessionOptionsSkipped
} from './structured-agent-session-provider-option-reports'

export type StructuredAgentSessionProviderStartedContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  publishStatus?: (sessionId: string) => void
  runtimeState: {
    startupAttempts: Pick<StructuredAgentSessionStartupAttempts, 'ready' | 'onClock' | 'signal'>
    optionRevisions: Pick<
      StructuredAgentSessionOptionRevisions,
      'admitReport' | 'advance' | 'isNewest' | 'current'
    >
  }
  /** The barrier lifts: what was accepted while the child started is handed over now. Settles once
   *  the loop has handed over all it can. */
  wakeDelivery: (sessionId: string) => Promise<void>
  /** Ends a starting child whose start cannot be completed, as its startup limit would. */
  stopStartingChild: (sessionId: string, child: StructuredAgentSessionProviderChildIdentity) => void
}

export async function settleStructuredAgentSessionProviderStarted(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionStartedEvent
): Promise<void> {
  const admitted = admitStructuredAgentSessionReportedOptions(context, event)
  const identity = { generation: event.acquisitionGeneration, fence: event.fence }
  const child = await context.serialize(event.sessionId, async () => {
    const session = context.sessions.get(event.sessionId)
    if (
      !session?.child ||
      session.child.phase !== 'starting' ||
      session.child.settlingStart ||
      !sameProviderChild(session.child, identity) ||
      !context.runtimeState.startupAttempts.onClock(event.sessionId, identity)
    ) {
      return null
    }
    session.child.settlingStart = true
    return session.child
  })
  if (!child) {
    return
  }
  if (!(await recordStartedHandle(context, event))) {
    context.stopStartingChild(event.sessionId, identity)
    return
  }
  let recovered = false
  for (;;) {
    if (!context.runtimeState.startupAttempts.onClock(event.sessionId, identity)) {
      return
    }
    const consumedRevision = await applyPicksMadeWhileStarting(context, event, child)
    if (consumedRevision === null) {
      return
    }
    if (!recovered) {
      const session = context.sessions.get(event.sessionId)
      if (!session || !(await recoverRewindAtStart(context, event.sessionId, session))) {
        context.stopStartingChild(event.sessionId, identity)
        return
      }
      recovered = true
    }
    const started = await context.serialize(event.sessionId, async () => {
      const session = context.sessions.get(event.sessionId)
      if (
        !session?.child ||
        !sameProviderChild(session.child, identity) ||
        !context.runtimeState.startupAttempts.onClock(event.sessionId, identity)
      ) {
        return null
      }
      if (context.runtimeState.optionRevisions.current(event.sessionId) !== consumedRevision) {
        return 'retry' as const
      }
      if (!markProviderChildStarted(session, identity)) {
        return null
      }
      noteSignedOutStructuredAgentSessionChild(
        session,
        context.deps.adapter.startUnavailable?.(event.sessionId)
      )
      context.runtimeState.startupAttempts.ready(event.sessionId, identity)
      const delivered = context.wakeDelivery(event.sessionId)
      noteStructuredAgentSessionProviderStarted(context.deps, event.sessionId)
      if (event.catalogListing) {
        saveStructuredAgentSessionStartListing(context, event.sessionId, event.catalogListing)
      }
      context.publishStatus?.(event.sessionId)
      return { delivered }
    })
    if (started === 'retry') {
      continue
    }
    if (started) {
      void started.delivered.then(() =>
        persistStructuredAgentSessionReportedOptions(context, event, admitted)
      )
    }
    return
  }
}

/** Picks made while the child started reach it before it is accepted, under its startup clock.
 *  False when a close, Stop, quit or the limit cut them short: whoever did ends the child, which
 *  never runs a value the chat does not show. A pick it refused is shown as what it runs. */
async function applyPicksMadeWhileStarting(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionStartedEvent,
  child: StructuredAgentSessionProviderChild
): Promise<number | null> {
  const launched = child.launchedOptions ?? {}
  const applied = await applyStructuredAgentSessionStartupIntent(
    {
      deps: context.deps,
      signal:
        context.runtimeState.startupAttempts.signal(event.sessionId, child) ?? AbortSignal.abort(),
      optionRevisions: context.runtimeState.optionRevisions
    },
    event.sessionId,
    child,
    launched
  )
  if (applied.aborted) {
    return null
  }
  if (applied.failed.length === 0) {
    return applied.consumedRevision
  }
  const reverted = await context.serialize(event.sessionId, async () => {
    if (
      context.runtimeState.optionRevisions.current(event.sessionId) !== applied.consumedRevision
    ) {
      return false
    }
    await revertRefusedStartupIntent(context, {
      sessionId: event.sessionId,
      fence: child.fence,
      refused: applied.failed,
      launched,
      reported: event.reportedOptions
    })
    context.runtimeState.optionRevisions.advance(event.sessionId)
    return true
  })
  return reverted ? applied.consumedRevision + 1 : applied.consumedRevision
}

/** A rewind left in doubt is settled by the first child that can read the provider's history:
 *  this one, now that its protocol session is open, before it is handed anything a recovered
 *  rewind would move. One that stays in doubt fails the start, as it would refuse every send. */
async function recoverRewindAtStart(
  context: StructuredAgentSessionProviderStartedContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession
): Promise<boolean> {
  try {
    await recoverStructuredRewind(
      context.deps,
      sessionId,
      session.journal,
      structuredAgentSessionConversationFence(context.deps.store, sessionId),
      context.deps.adapter,
      context.now
    )
    return true
  } catch (error) {
    context.deps.logger.warn('settling a rewind in doubt at the start failed', {
      scope: 'rewind-recovery',
      sessionId,
      error
    })
    return false
  }
}

/** The handle the child's protocol session answered with, recorded before it is handed anything:
 *  without it a later start could not resume what this child ran. False when there is none. */
async function recordStartedHandle(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionStartedEvent
): Promise<boolean> {
  const { store, logger } = context.deps
  const { link } = event
  if (!link) {
    // Only an acquisition that already held its handle may prove its start without one.
    return store.getRecord(event.sessionId)?.lease.provenHandleLinkId != null
  }
  try {
    await store.transitionHandoff(event.sessionId, (record) =>
      recordAgentSessionProviderHandle({ record, fence: event.fence, link, now: context.now() })
    )
    return true
  } catch (error) {
    logger.warn('recording the handle a started provider answered with failed', {
      scope: 'provider-started-handle',
      sessionId: event.sessionId,
      error
    })
    return false
  }
}

/** A proven start shows the agent's program exists and may mean a sign-in was fixed, so the
 *  catalog's held reason is re-checked by the next read's probe sooner; the probe decides. */
export function noteStructuredAgentSessionProviderStarted(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'modelCatalog'>,
  sessionId: string
): void {
  const record = deps.store.getRecord(sessionId)
  if (record) {
    deps.modelCatalog?.providerStarted(record)
  }
}
