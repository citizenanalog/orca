// The provider work a session has in flight, shared by concurrent users outside admission. A
// close, Stop, quit, or startup limit aborts it without waiting behind provider I/O.

export class StructuredAgentSessionAcquireAborts {
  private readonly inFlight = new Map<string, { controller: AbortController; users: number }>()
  /** Set by quit: the host is going away, so an attach that begins after it starts aborted. */
  private quitReason: Error | null = null

  /** For the attach about to run; `end` once it settles. */
  begin(sessionId: string): { signal: AbortSignal; end: () => void } {
    let held = this.inFlight.get(sessionId)
    if (!held || held.controller.signal.aborted) {
      const controller = new AbortController()
      if (this.quitReason) {
        controller.abort(this.quitReason)
      }
      held = { controller, users: 0 }
      this.inFlight.set(sessionId, held)
    }
    held.users += 1
    const current = held
    let ended = false
    return {
      signal: current.controller.signal,
      end: () => {
        if (ended) {
          return
        }
        ended = true
        current.users -= 1
        if (current.users === 0 && this.inFlight.get(sessionId) === current) {
          this.inFlight.delete(sessionId)
        }
      }
    }
  }

  /** A no-op when the session has nothing in flight. */
  abort(sessionId: string, reason: string | Error): void {
    this.inFlight
      .get(sessionId)
      ?.controller.abort(typeof reason === 'string' ? new Error(reason) : reason)
  }

  /** Quit: every start under way stops, and so does any the attach drain still runs. */
  abortAll(reason: string): void {
    this.quitReason ??= new Error(reason)
    for (const held of this.inFlight.values()) {
      held.controller.abort(this.quitReason)
    }
  }
}
