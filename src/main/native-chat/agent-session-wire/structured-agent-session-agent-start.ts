// Giving a session its provider child back.
//
// Only work starts one: the delivery loop for a queued message, and the few operations that need
// the provider itself — never a view, and never the app launching. The attach still serializes
// its short ownership transitions while the provider handshake runs outside that lane.

import {
  providerDiagnosticOf,
  type AgentSessionArgumentProblem,
  type ProviderDiagnostic
} from '../../../shared/agent-session-failure'
import { argumentProblemOf } from '../structured-agent-arguments-error'
import {
  agentSessionRefusalFromReference,
  readAgentSessionRefusalReference,
  refuse,
  type AgentSessionRefusalDetailsByCode,
  type AgentSessionWireRefusalCode
} from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { terminalOwnerRefusalMessage } from '../../../shared/agent-session-legacy-handoff-lease'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { attachStructuredAgentSessionUnderSerialize } from './structured-agent-session-attach-orchestration'
import { failedCreateRefusal } from './structured-agent-session-failed-create-refusal'
import { hostCanStartRecord } from './structured-agent-session-provider-support'
import {
  joinClosingStructuredAgentSessionChild,
  releaseLeaseOfEndedStructuredAgentSessionChild
} from './structured-agent-session-child-close'
export { joinClosingStructuredAgentSessionChild }
import {
  structuredAgentSessionResumeOperationId,
  structuredAgentSessionResumeParams
} from './structured-agent-session-resume-eligibility'

/** A resume answers with the attach's own refusal, verdict and all, so the asker can tell a lease
 *  someone else is settling from an owner that will not come back. */
export type StructuredAgentSessionResumeOutcome =
  | { ok: true }
  | {
      ok: false
      refusal: AgentSessionWireRefusal
      /** What the provider said about the failed start, for the chat's own record; host-side
       *  only, never on the refusal. */
      diagnostic?: ProviderDiagnostic
      /** The host's own close, Stop or quit aborted the start, so it failed nothing it was for. */
      aborted?: true
      /** The start went silent or hit its ceiling before it proved itself: Orca stopped it. */
      expired?: true
      argumentProblem?: AgentSessionArgumentProblem
    }

/** Concurrent callers join one start; a later call may retry after it settles. */
export function memoizedEnsureStructuredAgentSessionAgent(
  starts: Map<string, Promise<StructuredAgentSessionResumeOutcome>>,
  acquireAborts: StructuredAgentSessionAttachContext['runtimeState']['acquireAborts'],
  context: () => StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor?: string
): Promise<StructuredAgentSessionResumeOutcome> {
  const pending = starts.get(sessionId)
  if (pending) {
    return pending
  }
  const reservation = acquireAborts.begin(sessionId)
  const start = ensureStructuredAgentSessionAgent(context(), sessionId, startedFor)
  starts.set(sessionId, start)
  void start
    .finally(() => {
      reservation.end()
      if (starts.get(sessionId) === start) {
        starts.delete(sessionId)
      }
    })
    .catch(() => undefined)
  return start
}

/** The attach's caller key: the ledger row a start settles is Orca's own. */
const AGENT_START_CALLER_KEY = 'trusted-local:agent-start'

/**
 * Gives the session a provider child if it has none. The host coalesces concurrent calls; a
 * failed start leaves the next asker to make its own.
 */
export async function ensureStructuredAgentSessionAgent(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor?: string
): Promise<StructuredAgentSessionResumeOutcome> {
  // A child a stop began closing takes no input, and none may start beside it: the start waits on
  // that close, and is refused while its exit stays unverifiable.
  const closed = await joinClosingStructuredAgentSessionChild(context, sessionId)
  if (!closed.ok) {
    return closed
  }
  if (context.sessions.get(sessionId)?.child) {
    return { ok: true }
  }
  const started = await startStructuredAgentSessionAgent(context, sessionId, startedFor)
  if (!started.ok || context.sessions.get(sessionId)?.child) {
    return started
  }
  return refuseResume(
    'agent_session_ownership_unknown',
    { reason: 'noProviderChild' },
    'The session attached without a provider child to write to.'
  )
}

async function startStructuredAgentSessionAgent(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor: string | undefined
): Promise<StructuredAgentSessionResumeOutcome> {
  const callerKey = AGENT_START_CALLER_KEY
  // The record is read only once this host has adjudicated it and recovery resolution has
  // concluded about any owner a failed attempt left in `recovering`, so the eligibility below sees
  // the lease the resolver handed back.
  const unreconciled = await context.reconcileLeases(sessionId)
  if (unreconciled) {
    return { ok: false, refusal: unreconciled }
  }
  await context.runtimeState.resolveRecovery(sessionId)
  // A start needs the lease released; a release the exit's own wind-down could not write is
  // re-derived from this host's proof of that exit, never refused on.
  await releaseLeaseOfEndedStructuredAgentSessionChild(context, sessionId)
  const record = context.deps.store.getRecord(sessionId)
  if (!record) {
    return refuseResume(
      'agent_session_identity_required',
      { reason: 'recordMissing' },
      'No structured session exists by that id.'
    )
  }
  if (!hostCanStartRecord(context.deps, record)) {
    return refuseResume(
      'structured_agent_session_unsupported',
      { reason: 'hostUnsupported' },
      'This execution host cannot resume the requested structured agent session.'
    )
  }
  const params = structuredAgentSessionResumeParams(
    record,
    structuredAgentSessionResumeOperationId(context.now())
  )
  if (!params) {
    return record.lease.unreconciled
      ? refuseResume(
          'execution_owner_reconciling',
          { reason: 'hostReconciling' },
          'This host has not yet adjudicated the session lease.'
        )
      : record.lease.claimStatus === 'conflicted'
        ? refuseResume(
            'agent_session_conflict',
            { reason: 'claimConflicted' },
            terminalOwnerRefusalMessage(record.lease)
          )
        : refuseResume(
            'agent_session_ownership_unknown',
            { reason: 'notResumable' },
            'The session lease is not one this host may resume.'
          )
  }
  let attached: AgentSessionMutationResult<AgentSessionAttachResult>
  let acquisitionError: unknown
  let aborted = false
  let expired = false
  try {
    attached = await attachStructuredAgentSessionUnderSerialize(context, callerKey, params, {
      ...(startedFor === undefined ? {} : { startedFor }),
      onAcquisitionFailed: (error) => {
        acquisitionError = error
      },
      onAborted: () => {
        aborted = true
      },
      onStartupExpired: () => {
        expired = true
      }
    })
  } catch (error) {
    // The attach settles an acquisition that failed — the ledger row, the released lease — before
    // it rethrows the cause. That row is the answer: a failure it recorded is this resume's
    // refusal, verdict and all. Only an error it did not record is a fault for the caller.
    const settled = settledResumeRefusal(
      context,
      callerKey,
      params.envelope.clientOperationId,
      sessionId,
      error
    )
    if (settled) {
      return withDiagnostic(settled.refusal, error, { aborted, expired })
    }
    throw error
  }
  return attached.ok
    ? { ok: true }
    : withDiagnostic(attached.refusal, acquisitionError, { aborted, expired })
}

function withDiagnostic(
  refusal: AgentSessionWireRefusal,
  error: unknown,
  { aborted, expired }: { aborted: boolean; expired: boolean }
): StructuredAgentSessionResumeOutcome {
  const diagnostic = providerDiagnosticOf(error)
  const argumentProblem = argumentProblemOf(error)
  return {
    ok: false,
    refusal,
    ...(diagnostic ? { diagnostic } : {}),
    ...(aborted ? { aborted: true as const } : {}),
    ...(expired ? { expired: true as const } : {}),
    ...(argumentProblem ? { argumentProblem } : {})
  }
}

function settledResumeRefusal(
  context: Pick<StructuredAgentSessionAttachContext, 'deps'>,
  callerKey: string,
  operationId: string,
  sessionId: string,
  error: unknown
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  const outcome = context.deps.store.getOperationRow(callerKey, operationId)?.outcome
  const reference =
    outcome?.status === 'failed'
      ? readAgentSessionRefusalReference({ code: outcome.code, details: outcome.details })
      : undefined
  if (outcome?.status !== 'failed' || !reference) {
    return null
  }
  return failedCreateRefusal(
    agentSessionRefusalFromReference(
      reference,
      outcome.message ?? (error instanceof Error ? error.message : String(error))
    ),
    outcome.status,
    context.deps.store.getRecord(sessionId)
  )
}

function refuseResume<C extends AgentSessionWireRefusalCode>(
  code: C,
  details: NoInfer<AgentSessionRefusalDetailsByCode[C]>,
  message: string
): StructuredAgentSessionResumeOutcome {
  return { ok: false, refusal: refuse(code, details, message) }
}
