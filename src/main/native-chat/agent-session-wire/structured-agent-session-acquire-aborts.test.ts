import { expect, it } from 'vitest'
import { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'

it('gives a new start a fresh signal after Stop while an older user is unresolved', () => {
  const aborts = new StructuredAgentSessionAcquireAborts()
  const old = aborts.begin('session')
  aborts.abort('session', 'stopped')
  expect(old.signal.aborted).toBe(true)

  const next = aborts.begin('session')
  expect(next.signal.aborted).toBe(false)
  old.end()
  aborts.abort('session', 'stopped again')
  expect(next.signal.aborted).toBe(true)
  next.end()
})
