import { afterEach, describe, expect, it, vi } from 'vitest'
import { openConversationForWrite } from './structured-agent-session-send-preparation'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

describe('a write whose conversation the host could not open', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const ENVELOPE = {
    sessionId: 'session-1',
    clientOperationId: 'operation-1',
    expectedRuntimeFence: 1,
    payloadFingerprint: ''
  }

  function refusedBy(error: unknown) {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    return openConversationForWrite(
      async () => {
        throw error
      },
      ENVELOPE,
      createStructuredAgentSessionLogger()
    )
  }

  it('says a corrupt history is final, in words and not the error', async () => {
    const corrupt = Object.assign(new Error('/Users/me/journal.db: file is not a database'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 26
    })

    expect(await refusedBy(corrupt)).toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalCorrupt' },
        message: 'Unable to load this chat.'
      }
    })
  })

  it('says any other failed open can clear', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied, open /Users/me'), {
      code: 'EACCES',
      errno: -13
    })

    expect(await refusedBy(denied)).toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' },
        message: "Orca couldn't open this chat's history right now. Try again."
      }
    })
  })
})
