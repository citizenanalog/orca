import type { Socket } from 'node:net'
import { yieldToEventLoop } from '../../shared/event-loop-yield'

/** Stream bytes one event-loop turn parses and dispatches before the reader yields. */
export const STREAM_INGEST_TURN_BYTES = 64 * 1024

/**
 * Reads `socket` into `consume`, pausing it once a turn has taken STREAM_INGEST_TURN_BYTES so
 * commands and IPC run between slices of an output flood. Unread bytes stay in the socket, so
 * ordering, end-of-stream after the last event, and daemon backpressure are unchanged.
 */
export function attachTurnBoundedSocketReader(
  socket: Socket,
  consume: (chunk: Buffer) => void,
  remainder: Buffer
): () => void {
  let turnBytes = 0
  let turnEndPending = false
  let paused = false
  let detached = false

  const endTurn = (): void => {
    turnEndPending = false
    turnBytes = 0
    if (paused && !detached) {
      paused = false
      socket.resume()
    }
  }

  const onData = (chunk: Buffer): void => {
    turnBytes += chunk.length
    if (!turnEndPending) {
      turnEndPending = true
      void yieldToEventLoop().then(endTurn)
    }
    if (turnBytes >= STREAM_INGEST_TURN_BYTES && !paused) {
      paused = true
      socket.pause()
    }
    consume(chunk)
  }

  socket.on('data', onData)
  // Why resume before the remainder: a remainder that fills the turn must leave the socket paused.
  socket.resume()
  if (remainder.length > 0) {
    onData(remainder)
  }
  return () => {
    detached = true
    socket.off('data', onData)
  }
}
