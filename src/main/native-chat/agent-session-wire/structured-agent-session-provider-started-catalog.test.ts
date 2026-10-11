// A chat that proves its start shows its account can start one, so the model catalog's held
// "can't start" reason is made due for the probe instead of trusted until its TTL runs out.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
const providerStarted = vi.fn()
const recordLiveListing = vi.fn()

function startHost(
  setOption: StructuredAgentSessionAdapter['setOption'] = async () => {},
  beforeAcquireReturns?: (fence: number) => Promise<void>,
  dispatch: StructuredAgentSessionAdapter['dispatch'] = async () => ({ state: 'admitted' })
): void {
  const acquire: StructuredAgentSessionAdapter['acquire'] = async ({ fence, spawnToken }) => {
    await beforeAcquireReturns?.(fence)
    return {
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      link: {
        linkId: `link-${fence}`,
        handle: codexProviderHandle(THREAD),
        origin: 'created' as const,
        mintedAtFence: fence,
        observedAt: NOW
      },
      acquisitionGeneration: 'generation-1'
    }
  }
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      closeSession: vi.fn(async () => true),
      dispatch,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption
    },
    modelCatalog: {
      read: vi.fn(),
      recordLiveListing,
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-started-catalog-'))
  resetHostTestOperationIds()
  providerStarted.mockReset()
  recordLiveListing.mockReset()
  store = await openTestAgentSessionRecordStore(root)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

/** The adapter's report that the child's protocol session exists. */
function proveStart(): Promise<void> {
  return host.handleAdapterEvent({
    type: 'started',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: 'generation-1',
    reportedOptions: { model: 'sonnet' },
    restoreSkippedOptions: [],
    optionRevision: 0
  })
}

it('a published child tells the catalog only once its start is proven, with its record', async () => {
  startHost()
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({ ok: true })
  expect(providerStarted).not.toHaveBeenCalled()
  await proveStart()
  expect(providerStarted).toHaveBeenCalledTimes(1)
  expect(providerStarted.mock.calls[0]?.[0]).toMatchObject({ sessionId: SESSION })
})

it('a re-attach to the live child proves nothing new and tells the catalog nothing', async () => {
  startHost()
  const params = hostTestAttachParams(null)
  await expect(host.attach(CALLER, params)).resolves.toMatchObject({ ok: true })
  await proveStart()
  const fence = store.getRecord(SESSION)?.lease.runtimeFence
  const held = host.collaboratorsForTests().sessions.get(SESSION)
  if (!held?.child) {
    throw new Error('the ready child was not published')
  }
  const signedOutAt = held.journal.cursor()
  held.child.signedOutAt = signedOutAt
  // A reconnecting client replays its attach; the same operation re-attaches the live child.
  await expect(host.attach(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
  expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence)
  expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.signedOutAt).toEqual(
    signedOutAt
  )
  expect(providerStarted).toHaveBeenCalledTimes(1)
})

it('keeps one start and its catalog readback across reattach, a held pick, and first handover', async () => {
  const pick = Promise.withResolvers<void>()
  const handover = Promise.withResolvers<void>()
  const setOption = vi.fn(async () => pick.promise)
  const dispatch = vi.fn(async () => {
    await handover.promise
    return { state: 'admitted' as const }
  })
  startHost(setOption, undefined, dispatch)
  const params = hostTestAttachParams(null)
  await expect(host.attach(CALLER, params)).resolves.toMatchObject({ ok: true })
  const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
  await store.replaceSessionOptions({
    sessionId: SESSION,
    fence,
    options: { model: 'opus' },
    now: NOW
  })
  const body = hostTestMessage('hello')
  await expect(
    host.send(CALLER, {
      body,
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      }
    })
  ).resolves.toMatchObject({ ok: true })

  try {
    const started = proveStart()
    await vi.waitFor(() => expect(setOption).toHaveBeenCalledOnce())
    await expect(host.attach(CALLER, params)).resolves.toMatchObject({
      ok: true
    })
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.settlingStart).toBe(true)
    await proveStart()
    expect(setOption).toHaveBeenCalledOnce()
    await host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence,
      acquisitionGeneration: 'generation-1',
      reportedOptions: { model: 'opus' },
      restoreSkippedOptions: [],
      optionRevision: 1,
      catalogListing: { models: [] }
    })
    expect(recordLiveListing).not.toHaveBeenCalled()

    pick.resolve()
    await started
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(recordLiveListing).not.toHaveBeenCalled()
    handover.resolve()
    await vi.waitFor(() => expect(recordLiveListing).toHaveBeenCalledWith(SESSION, { models: [] }))
  } finally {
    pick.resolve()
    handover.resolve()
  }
})

it('keeps a catalog readback reported before the child is published', async () => {
  startHost(undefined, (fence) =>
    host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence,
      acquisitionGeneration: 'generation-1',
      reportedOptions: { model: 'sonnet' },
      restoreSkippedOptions: [],
      optionRevision: 0,
      catalogListing: { models: [] }
    })
  )
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({ ok: true })
  expect(recordLiveListing).not.toHaveBeenCalled()
  await proveStart()
  await vi.waitFor(() => expect(recordLiveListing).toHaveBeenCalledWith(SESSION, { models: [] }))
})
