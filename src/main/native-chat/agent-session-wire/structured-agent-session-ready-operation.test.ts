import { expect, it, vi } from 'vitest'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import { prepareReadyStructuredAgentSessionOperation } from './structured-agent-session-ready-operation'

it('ends one caller budget while a shared acquire can still make a later operation ready', async () => {
  const start = Promise.withResolvers<{ ok: true }>()
  const ensureAgent = vi.fn(() => start.promise)
  const sessions = new Map<
    string,
    { child: { generation: string; fence: number; phase: string } }
  >()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this path reads only admission, conversation, ensureAgent, and the selected child; the stub supplies each.
  const context = {
    deps: { store: { evaluateMutationOperation: () => ({ decision: { decision: 'admit' } }) } },
    conversation: async () => ({}),
    ensureAgent,
    sessions,
    now: () => Date.now()
  } as unknown as StructuredAgentSessionMutationContext
  const envelope = {
    sessionId: 'session',
    clientOperationId: 'operation',
    expectedRuntimeFence: 1,
    payloadFingerprint: 'fingerprint'
  }
  const first = prepareReadyStructuredAgentSessionOperation(
    context,
    'caller',
    envelope,
    'agentSession.rewind',
    { itemId: 'item' },
    10
  )
  expect(await first).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(ensureAgent).toHaveBeenCalledTimes(1)

  sessions.set('session', { child: { generation: 'generation', fence: 1, phase: 'ready' } })
  start.resolve({ ok: true })
  expect(
    await prepareReadyStructuredAgentSessionOperation(
      context,
      'caller',
      envelope,
      'agentSession.rewind',
      { itemId: 'item' }
    )
  ).toEqual({ ok: true, child: { generation: 'generation', fence: 1 } })
  expect(ensureAgent).toHaveBeenCalledTimes(2)
})
