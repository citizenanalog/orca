import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  attachTurnBoundedSocketReader,
  STREAM_INGEST_TURN_BYTES
} from './daemon-stream-ingest-turn-bound'

const CHUNK_BYTES = STREAM_INGEST_TURN_BYTES / 2
const CHUNK_COUNT = 8

function bufferedSocket(): Socket {
  const socket = new Socket()
  for (let index = 0; index < CHUNK_COUNT; index++) {
    socket.push(Buffer.alloc(CHUNK_BYTES, index))
  }
  socket.push(null)
  return socket
}

const nextTick = (): Promise<void> => new Promise((resolve) => process.nextTick(resolve))

describe('attachTurnBoundedSocketReader', () => {
  it('reads one turn budget, yields, then delivers the rest in order before end', async () => {
    const socket = bufferedSocket()
    const seen: number[] = []
    socket.on('end', () => seen.push(-1))
    attachTurnBoundedSocketReader(socket, (chunk) => seen.push(chunk[0]), Buffer.alloc(0))

    await nextTick()
    expect(seen).toEqual([0, 1])
    expect(socket.isPaused()).toBe(true)

    await vi.waitFor(() => expect(seen).toContain(-1))
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, -1])
    socket.destroy()
  })

  it('consumes the hello remainder first and counts it toward the turn', async () => {
    const socket = bufferedSocket()
    const seen: number[] = []
    attachTurnBoundedSocketReader(
      socket,
      (chunk) => seen.push(chunk[0]),
      Buffer.alloc(STREAM_INGEST_TURN_BYTES, 0xff)
    )

    await nextTick()
    expect(seen).toEqual([0xff])
    expect(socket.isPaused()).toBe(true)

    await vi.waitFor(() => expect(seen).toHaveLength(CHUNK_COUNT + 1))
    expect(seen).toEqual([0xff, 0, 1, 2, 3, 4, 5, 6, 7])
    socket.destroy()
  })

  it('stays paused after detach so no bytes are read without a consumer', async () => {
    const socket = bufferedSocket()
    const seen: number[] = []
    const detach = attachTurnBoundedSocketReader(
      socket,
      (chunk) => seen.push(chunk[0]),
      Buffer.alloc(0)
    )
    await nextTick()
    detach()

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toEqual([0, 1])
    expect(socket.isPaused()).toBe(true)
    expect(socket.readableLength).toBe((CHUNK_COUNT - 2) * CHUNK_BYTES)
    socket.destroy()
  })
})
