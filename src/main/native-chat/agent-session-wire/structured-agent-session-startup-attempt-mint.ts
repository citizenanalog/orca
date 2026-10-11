import { randomUUID } from 'node:crypto'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-contract'

/** The launch values and explicit desired intent captured for one child start. */
export function mintStructuredAgentSessionStartupAttempt(input: {
  record: AgentSessionRecord
  identity: AgentSessionJournalIdentity
  spawnToken: string
  events?: StructuredAgentSessionEventSink
  signal?: AbortSignal
  optionRevision: () => number
}): StructuredAgentSessionStartupAttempt {
  const { record } = input
  return {
    attemptId: randomUUID(),
    identity: input.identity,
    fence: record.lease.runtimeFence,
    spawnToken: input.spawnToken,
    launch: {
      location: record.location,
      accountHome: record.accountHome,
      ...(record.launchDirectory === undefined ? {} : { launchDirectory: record.launchDirectory })
    },
    ...(record.options ? { options: record.options } : {}),
    ...(input.events ? { events: input.events } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    optionRevision: input.optionRevision
  }
}
