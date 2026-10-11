// One start of a conversation's provider child, minted by the host before any adapter acquires.
//
// Whatever a start means as policy belongs to the host and is the same for every agent: which
// conversation and lease it is for, what cancels it, when it gives up, and when its child may take
// input. An adapter only runs its protocol inside the attempt it is handed.
//
// The clock starts when the process exists, never before (resolving a launch is not starting it).
// A start that says nothing for a minute is wedged; one still talking is given up only at the
// ceiling, so a slow migration or history replay is not killed mid-way while every start still
// ends. Expiry re-derives what to end from the host's own state, so a timer that outlives its
// attempt ends nothing.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'
import {
  STRUCTURED_AGENT_SESSION_STARTUP_LIMITS,
  type StructuredAgentSessionStartupAttempt,
  type StructuredAgentSessionStartupLimits
} from './structured-agent-session-startup-attempt-contract'
export { mintStructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-mint'

type StartupChild = StructuredAgentSessionProviderChildIdentity

/** The startup limit's own reason, so an expired start is told from a close, Stop or quit. */
export class StructuredAgentSessionStartupExpiredError extends Error {
  constructor() {
    super('the agent stopped making progress before it finished starting')
    this.name = 'StructuredAgentSessionStartupExpiredError'
  }
}

export class StructuredAgentSessionStartEndedError extends Error {
  constructor(readonly attemptId: string) {
    super('the agent ended before it finished starting')
    this.name = 'StructuredAgentSessionStartEndedError'
  }
}

export class StructuredAgentSessionStartWaitExpiredError extends Error {
  constructor() {
    super('the caller stopped waiting for the agent to start')
    this.name = 'StructuredAgentSessionStartWaitExpiredError'
  }
}

export function isStructuredAgentSessionStartupExpired(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'StructuredAgentSessionStartupExpiredError'
}

/** Where an expired attempt stood: still inside its acquire, or published as a starting child. */
export type StructuredAgentSessionExpiredStartup = {
  sessionId: string
  attemptId: string
  /** Null while the acquire has not returned. */
  child: StructuredAgentSessionProviderChildIdentity | null
}

/** How one spawned start ended, for tuning the limits from what agents really take. */
export type StructuredAgentSessionStartupSettled = {
  agent: AgentSessionJournalIdentity['agent']
  outcome: 'ready' | 'silent' | 'ceiling' | 'ended'
  /** From spawn to the outcome. */
  durationMs: number
}

/** What the host learns about a start while its acquire runs. */
export type StructuredAgentSessionStartupProgress = {
  /** The process exists: the clock starts. */
  spawned: () => void
  /** Any output; output before a spawn report also starts the clock. */
  output: () => void
}

type Tracked = {
  attempt: StructuredAgentSessionStartupAttempt
  readiness: PromiseWithResolvers<StructuredAgentSessionProviderChildIdentity>
  child: StructuredAgentSessionProviderChildIdentity | null
  spawnedAt: number | null
  lastOutputAt: number
  timer: ReturnType<typeof setTimeout> | null
  expired: boolean
  /** The limit's measure, held until an acquire it aborted settles: one that is ready anyway
   *  reports that instead. */
  expiry: StructuredAgentSessionStartupSettled | null
}

/** Each session's open attempt and its startup clock. A session starts one child at a time, so a
 *  new attempt replaces any older one. */
export class StructuredAgentSessionStartupAttempts {
  private readonly open = new Map<string, Tracked>()
  private disposed = false
  private readonly limits: StructuredAgentSessionStartupLimits
  private readonly now: () => number

  constructor(
    private readonly deps: {
      /** Runs outside the session's queue: an acquire may hold it for the whole handshake. */
      expire: (expired: StructuredAgentSessionExpiredStartup) => void
      /** Never throws back into the clock. */
      settled?: (settled: StructuredAgentSessionStartupSettled) => void
      limits?: Partial<StructuredAgentSessionStartupLimits>
      /** Real elapsed time: the host's own `now` may be pinned. */
      now?: () => number
    }
  ) {
    this.limits = { ...STRUCTURED_AGENT_SESSION_STARTUP_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
  }

  track(
    sessionId: string,
    attempt: StructuredAgentSessionStartupAttempt
  ): StructuredAgentSessionStartupProgress {
    this.end(sessionId)
    const readiness = Promise.withResolvers<StructuredAgentSessionProviderChildIdentity>()
    // An adapter may fail before a caller joins the start.
    void readiness.promise.catch(() => undefined)
    const tracked: Tracked = {
      attempt,
      readiness,
      child: null,
      spawnedAt: null,
      lastOutputAt: 0,
      timer: null,
      expired: false,
      expiry: null
    }
    this.open.set(sessionId, tracked)
    const current = (): boolean => this.open.get(sessionId) === tracked && !this.disposed
    return {
      spawned: () => {
        if (current()) {
          this.startClock(sessionId, tracked)
        }
      },
      output: () => {
        if (!current()) {
          return
        }
        if (tracked.spawnedAt === null) {
          this.startClock(sessionId, tracked)
          return
        }
        // Read when the timer fires, so a chatty child costs no timer churn.
        tracked.lastOutputAt = this.now()
      }
    }
  }

  /** One attempt owns readiness even when reattachment rebuilds its child record. */
  wait(
    sessionId: string,
    attemptId: string,
    child: StructuredAgentSessionProviderChildIdentity,
    budgetMs?: number
  ): Promise<StructuredAgentSessionProviderChildIdentity> {
    const tracked = this.open.get(sessionId)
    if (
      !tracked ||
      tracked.attempt.attemptId !== attemptId ||
      (tracked.child && !sameProviderChild(tracked.child, child))
    ) {
      return Promise.reject(new StructuredAgentSessionStartEndedError(attemptId))
    }
    if (budgetMs === undefined) {
      return tracked.readiness.promise
    }
    let timer: ReturnType<typeof setTimeout>
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StructuredAgentSessionStartWaitExpiredError()), budgetMs)
      timer.unref?.()
    })
    return Promise.race([tracked.readiness.promise, timedOut]).finally(() => clearTimeout(timer))
  }

  /** A report emitted before publication joins this attempt, then verifies its actual child. */
  reportReady(sessionId: string, child: StartupChild): Promise<boolean> | null {
    const tracked = this.open.get(sessionId)
    return tracked?.attempt.fence === child.fence &&
      (!tracked.child || sameProviderChild(tracked.child, child))
      ? tracked.readiness.promise
          .then((ready) => sameProviderChild(ready, child))
          .catch(() => false)
      : null
  }

  /** The acquire returned: its `starting` child stays on the clock until it proves its start, and
   *  one published after the limit passed is expired now. */
  published(sessionId: string, attemptId: string, child: StartupChild): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.attempt.attemptId !== attemptId) {
      return
    }
    tracked.child = { generation: child.generation, fence: child.fence }
    if (tracked.expired) {
      this.expire(sessionId, tracked, null)
      return
    }
    // A child published without a spawn report has existed since at least now.
    if (tracked.spawnedAt === null && !this.disposed) {
      this.startClock(sessionId, tracked)
    }
  }

  /** A provider may answer before acquire has returned its child to the host. */
  hasUnpublished(sessionId: string, fence: number): boolean {
    const tracked = this.open.get(sessionId)
    return !this.disposed && !!tracked && !tracked.child && tracked.attempt.fence === fence
  }

  /** Whether `child`'s start is still on its clock: false once its limit passed, so a `started`
   *  that lost the race to the limit is never accepted. */
  onClock(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): boolean {
    const tracked = this.open.get(sessionId)
    return (
      !this.disposed &&
      !!tracked?.child &&
      !tracked.expired &&
      sameProviderChild(tracked.child, child)
    )
  }

  signal(sessionId: string, child: StartupChild): AbortSignal | undefined {
    const tracked = this.open.get(sessionId)
    return tracked?.child && sameProviderChild(tracked.child, child)
      ? tracked.attempt.signal
      : undefined
  }

  /** The child proved its start: its attempt is over. A stale child's proof ends nothing. */
  ready(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.child && sameProviderChild(tracked.child, child)) {
      tracked.readiness.resolve(child)
      this.settle(sessionId, tracked, 'ready')
    }
  }

  /** The child ended (exit, crash, Stop, close): nothing is left for its attempt to time. */
  childEnded(sessionId: string, child: StructuredAgentSessionProviderChildIdentity): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.child && sameProviderChild(tracked.child, child)) {
      tracked.readiness.reject(new StructuredAgentSessionStartEndedError(tracked.attempt.attemptId))
      this.settle(sessionId, tracked, 'ended')
    }
  }

  /** The attempt failed, or its attach did: nothing it started is left to time out. */
  abandon(sessionId: string, attemptId: string): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.attempt.attemptId === attemptId) {
      tracked.readiness.reject(new StructuredAgentSessionStartEndedError(attemptId))
      this.settle(sessionId, tracked, 'ended')
    }
  }

  /** Whether the session still has an attempt open; for tests and diagnostics. */
  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId)
  }

  /** Quit: no limit fires after this. */
  dispose(): void {
    this.disposed = true
    for (const tracked of this.open.values()) {
      tracked.readiness.reject(new StructuredAgentSessionStartEndedError(tracked.attempt.attemptId))
      if (tracked.timer) {
        clearTimeout(tracked.timer)
      }
    }
    this.open.clear()
  }

  private startClock(sessionId: string, tracked: Tracked): void {
    if (tracked.spawnedAt !== null) {
      return
    }
    tracked.spawnedAt = this.now()
    tracked.lastOutputAt = tracked.spawnedAt
    this.schedule(sessionId, tracked)
  }

  private schedule(sessionId: string, tracked: Tracked): void {
    if (tracked.spawnedAt === null) {
      return
    }
    const due = Math.min(
      tracked.lastOutputAt + this.limits.silenceMs,
      tracked.spawnedAt + this.limits.ceilingMs
    )
    tracked.timer = setTimeout(() => this.check(sessionId, tracked), Math.max(0, due - this.now()))
    // A start's clock must never be the reason a process stays alive at quit.
    tracked.timer.unref?.()
  }

  private check(sessionId: string, tracked: Tracked): void {
    tracked.timer = null
    if (this.open.get(sessionId) !== tracked || this.disposed || tracked.spawnedAt === null) {
      return
    }
    const now = this.now()
    if (now - tracked.spawnedAt >= this.limits.ceilingMs) {
      this.expire(sessionId, tracked, 'ceiling')
    } else if (now - tracked.lastOutputAt >= this.limits.silenceMs) {
      this.expire(sessionId, tracked, 'silent')
    } else {
      this.schedule(sessionId, tracked)
    }
  }

  /** `reason` null: a start whose limit already passed inside its acquire was published now. */
  private expire(sessionId: string, tracked: Tracked, reason: 'silent' | 'ceiling' | null): void {
    if (this.open.get(sessionId) !== tracked || this.disposed) {
      return
    }
    if (reason) {
      tracked.expiry = this.measure(tracked, reason)
    }
    tracked.expired = true
    tracked.readiness.reject(new StructuredAgentSessionStartupExpiredError())
    const { child } = tracked
    // A published child's stop is under way and ends nothing a newer attempt owns; one still
    // acquiring stays tracked until its aborted acquire is abandoned or published.
    if (child) {
      this.report(tracked.expiry)
      this.end(sessionId)
    }
    this.deps.expire({ sessionId, attemptId: tracked.attempt.attemptId, child })
  }

  private settle(sessionId: string, tracked: Tracked, outcome: 'ready' | 'ended'): void {
    this.report(
      tracked.expired && outcome === 'ended' ? tracked.expiry : this.measure(tracked, outcome)
    )
    this.end(sessionId)
  }

  private measure(
    tracked: Tracked,
    outcome: StructuredAgentSessionStartupSettled['outcome']
  ): StructuredAgentSessionStartupSettled | null {
    return tracked.spawnedAt === null
      ? null
      : {
          agent: tracked.attempt.identity.agent,
          outcome,
          durationMs: Math.max(0, this.now() - tracked.spawnedAt)
        }
  }

  private report(settled: StructuredAgentSessionStartupSettled | null): void {
    if (!settled || this.disposed) {
      return
    }
    try {
      this.deps.settled?.(settled)
    } catch {
      // Measurement is bookkeeping: it never decides a start.
    }
  }

  private end(sessionId: string): void {
    const tracked = this.open.get(sessionId)
    if (tracked?.timer) {
      clearTimeout(tracked.timer)
    }
    tracked?.readiness.reject(new StructuredAgentSessionStartEndedError(tracked.attempt.attemptId))
    this.open.delete(sessionId)
  }
}
