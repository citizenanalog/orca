import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import {
  structuredAgentSessionStartFailure,
  type StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import { failedProviderChildStart } from './structured-agent-session-provider-child'

export type StartFailure = {
  startKey: string | null
  cause: StructuredAgentSessionStartFailureCause
  through?: AgentJournalCursor
}

type RefusedStart = Extract<StructuredAgentSessionResumeOutcome, { ok: false }>

/** Word a refused provider start from the conversation's actual prior handle state. */
export function refusedQueuedStart(
  deps: StructuredAgentSessionDeliveryLoopDeps,
  sessionId: string,
  { refusal, diagnostic, argumentProblem, expired }: RefusedStart
): StartFailure {
  if (expired) {
    return { startKey: null, cause: { failure: agentSessionFailureFact('hostStopped') } }
  }
  const newSession = deps.record(sessionId)?.providerHandleChain.length === 0
  return {
    startKey: null,
    cause: {
      refusal,
      ...(diagnostic ? { diagnostic } : {}),
      ...(argumentProblem ? { argumentProblem } : {}),
      ...(newSession ? { newSession: true as const } : {})
    }
  }
}

/** Record the failure through the current cursor; a later accepted send wakes another start. */
export async function recordFailedQueuedDelivery(
  deps: StructuredAgentSessionDeliveryLoopDeps,
  sessionId: string,
  failure: StartFailure,
  through?: AgentJournalCursor
): Promise<boolean> {
  const session = deps.sessions.get(sessionId)
  const bound = through ?? failure.through ?? session?.journal.cursor()
  if (session) {
    await recordStructuredAgentSessionStartFailure(
      { journal: session.journal, fence: deps.conversationFence(sessionId) },
      {
        startKey: failure.startKey,
        ...structuredAgentSessionStartFailure(failure.cause, deps.failureTextContext(sessionId))
      },
      bound
    )
  }
  if (!session || !bound) {
    return false
  }
  const next = oldestQueuedSubmission(session)
  return (
    next?.acceptedSequence !== undefined &&
    session.journal.cursor().epoch === bound.epoch &&
    next.acceptedSequence > bound.sequence
  )
}

/** A chat close settles only sends accepted through its own journal cursor. */
export function closeWhatTheUserClosed(
  deps: StructuredAgentSessionDeliveryLoopDeps,
  sessionId: string,
  session: StructuredAgentSessionHostSession
): Promise<boolean> {
  const ended = session.lastEndedChild
  if (session.child || ended?.cause !== 'user-close') {
    return Promise.resolve(true)
  }
  const { epoch } = session.journal.cursor()
  return deps.holdClosed(
    sessionId,
    (submission) =>
      ended.endedAt.epoch === epoch &&
      submission.acceptedSequence !== undefined &&
      submission.acceptedSequence <= ended.endedAt.sequence
  )
}

/** A child that died while a message waited settles that message under its start key. */
export function startThatFailedWhileQueued(
  session: StructuredAgentSessionHostSession,
  oldest: NonNullable<ReturnType<typeof oldestQueuedSubmission>>
): StartFailure | null {
  const ended = failedProviderChildStart(session)
  if (
    !ended ||
    oldest.acceptedSequence === undefined ||
    ended.endedAt.epoch !== session.journal.cursor().epoch ||
    ended.endedAt.sequence < oldest.acceptedSequence
  ) {
    return null
  }
  const cause = structuredAgentSessionEndedChildFailure(ended)
  return cause ? { startKey: ended.generation, cause, through: ended.endedAt } : null
}
