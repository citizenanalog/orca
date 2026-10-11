import type { AttachedOwner } from './structured-agent-session-attach-flow'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type { StructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-contract'

/** A held reattach keeps the current child's lifecycle facts. */
export function buildAttachedProviderChild(input: {
  owner: AttachedOwner
  current: StructuredAgentSessionProviderChild | null
  startup: StructuredAgentSessionStartupAttempt | null
  acquisitionGeneration: string | null
  fence: number
  startedFor?: string
}): StructuredAgentSessionProviderChild {
  const { owner, current, startup, acquisitionGeneration, fence, startedFor } = input
  return {
    ...(owner === 'acquired' ? {} : (current ?? {})),
    generation: acquisitionGeneration ?? current?.generation ?? null,
    fence,
    phase: owner === 'acquired' ? 'starting' : (current?.phase ?? 'ready'),
    ...(owner === 'acquired' && startup ? { startAttemptId: startup.attemptId } : {}),
    ...(startedFor === undefined ? {} : { startedFor }),
    ...(owner === 'acquired' ? { launchedOptions: startup?.options ?? {} } : {})
  }
}
