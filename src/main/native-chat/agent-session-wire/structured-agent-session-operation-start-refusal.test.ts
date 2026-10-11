// What an operation that needs the agent is told when it cannot have one: a typed refusal in
// words a person can read, never Orca's own error text.

import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import { prepareReadyStructuredAgentSessionOperation } from './structured-agent-session-ready-operation'
import { recordStructuredAgentSessionOptionIntent } from './structured-agent-session-options-read'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const SESSION = 'session-1'

describe('an operation whose agent start throws', () => {
  it('is refused as a failed restart, with the error only in the log', async () => {
    const log = recordingStructuredAgentSessionLogger()
    const cause = new Error('EACCES: permission denied, open /Users/me/.orca/leases.json')
    const context = {
      deps: {
        logger: log.logger,
        store: { evaluateMutationOperation: () => ({ decision: { decision: 'admit' } }) }
      },
      conversation: async () => ({}),
      ensureAgent: () => Promise.reject(cause),
      now: () => 1
    }
    const refused = await prepareReadyStructuredAgentSessionOperation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preparation reads only admission, conversation, ensureAgent, clock and logger before this start throws.
      context as unknown as StructuredAgentSessionMutationContext,
      'desktop',
      {
        sessionId: SESSION,
        clientOperationId: 'operation',
        expectedRuntimeFence: 1,
        payloadFingerprint: 'fingerprint'
      },
      'agentSession.rewind',
      { itemId: 'item' }
    )

    expect(refused).toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_owner_restart_failed',
        message: "The agent couldn't restart."
      }
    })
    expect(log.entries.map((entry) => entry.fields)).toEqual([
      { scope: 'operation-agent-start', sessionId: SESSION, error: cause }
    ])
  })
})

describe('an option picked while the chat is at rest', () => {
  it('refuses a key the provider would not accept as a rejected option', async () => {
    const refused = await recordStructuredAgentSessionOptionIntent(
      {
        store: {
          getRecord: () =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the intent reads only the record's provider and options.
            ({ provider: 'codex', options: {} }) as unknown as AgentSessionRecord
        },
        agents: claudeAndCodexAgents()
      },
      { sessionId: SESSION, publish: () => {}, persistOptions: async () => {} },
      { key: 'notAnOption', value: 'x' }
    )

    expect(refused).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'optionRejected' }
      }
    })
  })
})
