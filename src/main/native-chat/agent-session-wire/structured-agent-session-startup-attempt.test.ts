import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS as CEILING_MS,
  STRUCTURED_AGENT_SESSION_STARTUP_SILENCE_MS as SILENCE_MS
} from './structured-agent-session-startup-attempt-contract'
import {
  StructuredAgentSessionStartupAttempts,
  mintStructuredAgentSessionStartupAttempt,
  type StructuredAgentSessionExpiredStartup,
  type StructuredAgentSessionStartupSettled
} from './structured-agent-session-startup-attempt'

const SESSION = 'session-alpha'
const CHILD = { generation: 'generation-1', fence: 3 }

let expired: StructuredAgentSessionExpiredStartup[]
let settled: StructuredAgentSessionStartupSettled[]
let attempts: StructuredAgentSessionStartupAttempts

function mint(optionFields: Pick<AgentSessionRecord, 'options'> = {}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mint reads only the lease fence, location, account home and option fields this literal sets.
  const record = {
    lease: { runtimeFence: CHILD.fence },
    location: { executionHostId: 'local', workspaceId: 'workspace-1' },
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    ...optionFields
  } as unknown as AgentSessionRecord
  return mintStructuredAgentSessionStartupAttempt({
    record,
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: null
    },
    spawnToken: 'spawn-1',
    optionRevision: () => 0
  })
}

/** Output every `everyMs` for `forMs`. */
function chatter(output: () => void, forMs: number, everyMs = 10_000): void {
  for (let elapsed = 0; elapsed < forMs; elapsed += everyMs) {
    vi.advanceTimersByTime(everyMs)
    output()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  expired = []
  settled = []
  attempts = new StructuredAgentSessionStartupAttempts({
    expire: (startup) => expired.push(startup),
    settled: (startup) => settled.push(startup)
  })
})

describe('attempt-owned readiness', () => {
  it('shares one result across callers and a rebuilt child record', async () => {
    const attempt = mint()
    attempts.track(SESSION, attempt)
    attempts.published(SESSION, attempt.attemptId, CHILD)
    const first = attempts.wait(SESSION, attempt.attemptId, CHILD)
    const second = attempts.wait(SESSION, attempt.attemptId, { ...CHILD })

    expect(first).toBe(second)
    attempts.ready(SESSION, CHILD)
    await expect(first).resolves.toEqual(CHILD)
    await expect(second).resolves.toEqual(CHILD)
  })

  it('rejects the ended attempt and never lets its late proof resolve a replacement', async () => {
    const first = mint()
    attempts.track(SESSION, first)
    attempts.published(SESSION, first.attemptId, CHILD)
    const waiting = attempts.wait(SESSION, first.attemptId, CHILD)
    attempts.childEnded(SESSION, CHILD)
    await expect(waiting).rejects.toMatchObject({ attemptId: first.attemptId })

    const next = mint()
    const nextChild = { generation: 'generation-2', fence: CHILD.fence }
    attempts.track(SESSION, next)
    attempts.published(SESSION, next.attemptId, nextChild)
    const nextWaiting = attempts.wait(SESSION, next.attemptId, nextChild)
    attempts.ready(SESSION, CHILD)
    expect(attempts.isOpen(SESSION)).toBe(true)
    attempts.ready(SESSION, nextChild)
    await expect(nextWaiting).resolves.toEqual(nextChild)
  })

  it('lets the caller stop waiting without ending the host attempt', async () => {
    const attempt = mint()
    attempts.track(SESSION, attempt)
    attempts.published(SESSION, attempt.attemptId, CHILD)
    const waiting = attempts.wait(SESSION, attempt.attemptId, CHILD, 25)
    vi.advanceTimersByTime(25)

    await expect(waiting).rejects.toMatchObject({
      name: 'StructuredAgentSessionStartWaitExpiredError'
    })
    expect(attempts.isOpen(SESSION)).toBe(true)
    attempts.ready(SESSION, CHILD)
    expect(attempts.isOpen(SESSION)).toBe(false)
  })

  it('retains a prepublication report only for the child this attempt publishes', async () => {
    const attempt = mint()
    attempts.track(SESSION, attempt)
    const matching = attempts.reportReady(SESSION, CHILD)
    const stale = attempts.reportReady(SESSION, { ...CHILD, generation: 'old' })
    expect(matching).not.toBeNull()
    expect(stale).not.toBeNull()
    attempts.published(SESSION, attempt.attemptId, CHILD)
    attempts.ready(SESSION, CHILD)
    await expect(matching).resolves.toBe(true)
    await expect(stale).resolves.toBe(false)
  })

  it('drops a joined report when its child ends before readiness', async () => {
    const attempt = mint()
    attempts.track(SESSION, attempt)
    const report = attempts.reportReady(SESSION, CHILD)
    attempts.published(SESSION, attempt.attemptId, CHILD)
    attempts.childEnded(SESSION, CHILD)
    await expect(report).resolves.toBe(false)
  })
})

afterEach(() => {
  attempts.dispose()
  vi.useRealTimers()
})

describe('the startup clock', () => {
  it('does not run before the spawn: resolving a launch is not starting', () => {
    attempts.track(SESSION, mint())

    vi.advanceTimersByTime(CEILING_MS * 2)

    expect(expired).toEqual([])
  })

  it('fails a spawned agent that says nothing for the silence limit, naming the acquire', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt).spawned()

    vi.advanceTimersByTime(SILENCE_MS - 1)
    expect(expired).toEqual([])
    vi.advanceTimersByTime(1)

    expect(expired).toEqual([{ sessionId: SESSION, attemptId: attempt.attemptId, child: null }])
    vi.advanceTimersByTime(CEILING_MS)
    expect(expired).toHaveLength(1)
    // Measured at the limit, recorded once the aborted acquire settles.
    expect(settled).toEqual([])
    attempts.abandon(SESSION, attempt.attemptId)
    expect(settled).toEqual([{ agent: 'codex', outcome: 'silent', durationMs: SILENCE_MS }])
  })

  it('keeps a slow start that is still talking past the silence limit', () => {
    const attempt = mint()
    const progress = attempts.track(SESSION, attempt)
    progress.spawned()
    attempts.published(SESSION, attempt.attemptId, CHILD)

    chatter(progress.output, SILENCE_MS * 3)
    attempts.ready(SESSION, CHILD)

    expect(expired).toEqual([])
    expect(settled).toEqual([{ agent: 'codex', outcome: 'ready', durationMs: SILENCE_MS * 3 }])
    expect(attempts.isOpen(SESSION)).toBe(false)
  })

  it('times silence from the last output, not the spawn', () => {
    const progress = attempts.track(SESSION, mint())
    progress.spawned()
    vi.advanceTimersByTime(SILENCE_MS - 1_000)
    progress.output()

    vi.advanceTimersByTime(SILENCE_MS - 1)
    expect(expired).toEqual([])
    vi.advanceTimersByTime(1)

    expect(expired).toHaveLength(1)
  })

  it('fails a chatty agent that never becomes ready at the ceiling', () => {
    const attempt = mint()
    const progress = attempts.track(SESSION, attempt)
    progress.spawned()
    attempts.published(SESSION, attempt.attemptId, CHILD)

    chatter(progress.output, CEILING_MS - 10_000)
    expect(expired).toEqual([])
    chatter(progress.output, 10_000)

    expect(expired).toEqual([{ sessionId: SESSION, attemptId: attempt.attemptId, child: CHILD }])
    expect(settled).toEqual([{ agent: 'codex', outcome: 'ceiling', durationMs: CEILING_MS }])
  })

  it('starts on output or publication when no spawn was reported', () => {
    const byOutput = mint()
    attempts.track(SESSION, byOutput).output()
    const byPublish = mint()
    attempts.track('session-beta', byPublish)
    attempts.published('session-beta', byPublish.attemptId, CHILD)

    vi.advanceTimersByTime(SILENCE_MS)

    expect(expired.map((startup) => startup.attemptId).sort()).toEqual(
      [byOutput.attemptId, byPublish.attemptId].sort()
    )
  })
})

describe('an attempt ends', () => {
  it('with the start its child proved, and ignores a stale child’s proof', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt).spawned()
    attempts.published(SESSION, attempt.attemptId, CHILD)

    attempts.ready(SESSION, { ...CHILD, generation: 'generation-0' })
    expect(attempts.isOpen(SESSION)).toBe(true)
    attempts.ready(SESSION, CHILD)
    vi.advanceTimersByTime(CEILING_MS)

    expect(expired).toEqual([])
    expect(attempts.isOpen(SESSION)).toBe(false)
  })

  it('with its child, however the child ended, leaving no entry or timer', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt).spawned()
    attempts.published(SESSION, attempt.attemptId, CHILD)

    attempts.childEnded(SESSION, { ...CHILD, generation: 'generation-0' })
    expect(attempts.isOpen(SESSION)).toBe(true)
    attempts.childEnded(SESSION, CHILD)

    expect(attempts.isOpen(SESSION)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(settled.map((startup) => startup.outcome)).toEqual(['ended'])
  })

  it('once an expiry has stopped its published child', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt).spawned()
    attempts.published(SESSION, attempt.attemptId, CHILD)

    vi.advanceTimersByTime(SILENCE_MS)

    expect(expired).toHaveLength(1)
    expect(attempts.isOpen(SESSION)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('when an acquire the expiry aborted is abandoned, or publishes late and is expired then', () => {
    const abandoned = mint()
    attempts.track(SESSION, abandoned).spawned()
    vi.advanceTimersByTime(SILENCE_MS)
    expect(attempts.isOpen(SESSION)).toBe(true)
    attempts.abandon(SESSION, abandoned.attemptId)
    expect(attempts.isOpen(SESSION)).toBe(false)

    const late = mint()
    attempts.track(SESSION, late).spawned()
    vi.advanceTimersByTime(SILENCE_MS)
    attempts.published(SESSION, late.attemptId, CHILD)

    expect(expired.map((startup) => startup.child)).toEqual([null, null, CHILD])
    expect(attempts.isOpen(SESSION)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    // Each start is measured once, at the limit that ended it.
    expect(settled.map((startup) => startup.outcome)).toEqual(['silent', 'silent'])
  })

  it('with a child that proved its start, or an attach that failed', () => {
    const ready = mint()
    attempts.track(SESSION, ready).spawned()
    attempts.published(SESSION, ready.attemptId, CHILD)
    attempts.ready(SESSION, CHILD)
    const failed = mint()
    attempts.track('session-beta', failed).spawned()
    attempts.abandon('session-beta', failed.attemptId)

    vi.advanceTimersByTime(CEILING_MS)

    expect(expired).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('when the next attempt replaces it, and every clock stops at quit', () => {
    const first = mint()
    const firstProgress = attempts.track(SESSION, first)
    firstProgress.spawned()
    const second = mint()
    attempts.track(SESSION, second).spawned()
    // The replaced attempt's reports reach nothing.
    firstProgress.output()
    attempts.abandon(SESSION, first.attemptId)
    expect(attempts.isOpen(SESSION)).toBe(true)

    attempts.dispose()
    vi.advanceTimersByTime(CEILING_MS)

    expect(expired).toEqual([])
    expect(attempts.isOpen(SESSION)).toBe(false)
  })
})
