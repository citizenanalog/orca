import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import { refuseUnclassified } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'
import { openForProviderWrite } from './structured-agent-session-send-preparation'
import type { AgentSessionMutationSessionPreparation } from './structured-agent-session-mutation-admission'

export type ReadyOperationChild = StructuredAgentSessionProviderChildIdentity | null

async function observeWithin<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, budgetMs))
    timer.unref?.()
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/** A new protocol operation joins its host start outside the session's mutation lane. */
export async function prepareReadyStructuredAgentSessionOperation(
  context: StructuredAgentSessionMutationContext,
  callerKey: string,
  envelope: AgentSessionMutationEnvelope,
  method: string,
  fields: Record<string, unknown>,
  budgetMs = STRUCTURED_AGENT_SESSION_START_WAIT_MS
): Promise<
  { ok: true; child: ReadyOperationChild } | { ok: false; refusal: AgentSessionWireRefusal }
> {
  const evaluated = context.deps.store.evaluateMutationOperation({
    callerKey,
    envelope,
    hostFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: envelope.sessionId,
      fields
    }),
    now: context.now()
  })
  if (!evaluated || evaluated.decision.decision !== 'admit') {
    // A replay or refusal is answered by the ordinary ledger path without starting an agent.
    return { ok: true, child: null }
  }
  try {
    await context.conversation(envelope.sessionId)
  } catch {
    // The ordinary mutation path gives the conversation's precise open refusal.
    return { ok: true, child: null }
  }
  const deadline = Date.now() + budgetMs
  let started: Awaited<ReturnType<typeof context.ensureAgent>> | null
  try {
    started = await observeWithin(context.ensureAgent(envelope.sessionId), budgetMs)
  } catch (error) {
    context.deps.logger.warn('starting the agent for an operation failed', {
      scope: 'operation-agent-start',
      sessionId: envelope.sessionId,
      error
    })
    return {
      ok: false,
      refusal: refuseUnclassified(
        'agent_session_owner_restart_failed',
        agentSessionWriteNoticeEnglish(['restartFailed'])
      )
    }
  }
  if (!started) {
    return { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
  }
  if (!started.ok) {
    return started
  }
  const child = context.sessions.get(envelope.sessionId)?.child
  if (!child || child.close) {
    return { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
  }
  const selected = { generation: child.generation, fence: child.fence }
  if (child.phase === 'starting') {
    if (!child.startAttemptId) {
      return { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
    }
    try {
      await context.startupAttempts.wait(
        envelope.sessionId,
        child.startAttemptId,
        selected,
        Math.max(0, deadline - Date.now())
      )
    } catch {
      return { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
    }
  }
  return { ok: true, child: selected }
}

/** The second serialized step uses only the child selected before its wait. */
export function readyStructuredAgentSessionChildStillHeld(
  context: Pick<StructuredAgentSessionMutationContext, 'sessions'>,
  sessionId: string,
  selected: ReadyOperationChild
): boolean {
  const child = context.sessions.get(sessionId)?.child
  return (
    !!selected &&
    !!child &&
    child.phase === 'ready' &&
    !child.close &&
    sameProviderChild(child, selected)
  )
}

export function openWithReadyStructuredAgentSessionChild(
  context: StructuredAgentSessionMutationContext,
  envelope: AgentSessionMutationEnvelope,
  selected: ReadyOperationChild
): (ledger: 'admit' | 'replay') => Promise<AgentSessionMutationSessionPreparation> {
  return async (ledger) => {
    const opened = await openForProviderWrite(context, envelope)()
    if (!opened.ok || ledger === 'replay') {
      return opened
    }
    return readyStructuredAgentSessionChildStillHeld(context, envelope.sessionId, selected)
      ? opened
      : { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
  }
}
