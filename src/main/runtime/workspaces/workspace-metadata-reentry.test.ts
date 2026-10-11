import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../../persistence/profile-state/profile-state-sqlite-authority'
import { OrcaRuntimeService } from '../orca-runtime'
import { RuntimeRemoteFetchController } from '../runtime-remote-fetch-controller'
import type { RemoteTrackingBase } from '../runtime-remote-fetch-controller'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { WorkspaceMetadataHost } from './workspace-metadata-ports'

const trackingBase: RemoteTrackingBase = {
  remote: 'origin',
  branch: 'main',
  ref: 'origin/main',
  base: 'main'
}
const ownerFailure = new Error('owner callback bypassed runtime')

class ControlledRemoteFetches extends RuntimeRemoteFetchController {
  override async resolveRemoteTrackingBase(): Promise<RemoteTrackingBase> {
    return trackingBase
  }
  override async fetchRemoteWithCache(): Promise<void> {
    throw ownerFailure
  }
}

class MetadataRuntime extends OrcaRuntimeService {
  protected override readonly remoteFetches = new ControlledRemoteFetches()
  constructor(
    store: Store,
    readonly selectedWorktree: ResolvedWorktree
  ) {
    super(store)
  }

  override async resolveWorktreeSelector(): Promise<ResolvedWorktree> {
    return this.selectedWorktree
  }

  override async showManagedWorktree() {
    return this.selectedWorktree
  }

  override notifyWorktreesChanged(
    ...args: Parameters<WorkspaceMetadataHost['notifyWorktreesChanged']>
  ) {
    super.notifyWorktreesChanged(...args)
  }
}

let directory: string
let store: Store
let runtime: MetadataRuntime

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-metadata-reentry-'))
  store = new Store({
    dataFile: join(directory, 'state.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(join(directory, 'profile.db'), 'reentry')
  })
  store.addRepo({
    id: 'repo',
    path: directory,
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 0,
    worktreeBaseRef: 'main'
  })
  const path = join(directory, 'checkout')
  const worktree: ResolvedWorktree = {
    id: `repo::${path}`,
    repoId: 'repo',
    path,
    branch: 'feature',
    head: '',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path, head: '', branch: 'feature', isBare: false, isMainWorktree: false }
  }
  runtime = new MetadataRuntime(store, worktree)
})

afterEach(() => {
  vi.restoreAllMocks()
  store.freezeWrites()
  rmSync(directory, { recursive: true, force: true })
})

it('uses a runtime tracking-base replacement installed after construction', async () => {
  const calls: { receiver: unknown; args: unknown[] }[] = []
  vi.spyOn(runtime, 'resolveRemoteTrackingBase').mockImplementation(async function (
    this: unknown,
    ...args
  ) {
    calls.push({ receiver: this, args })
    return null
  })
  await expect(runtime.probeWorktreeDrift('selected')).resolves.toBeNull()
  expect(calls).toEqual([{ receiver: runtime, args: [directory, 'main', {}] }])
})

it('uses the runtime fetch replacement with its original receiver and arguments', async () => {
  const failure = new Error('runtime fetch override')
  const resolve = vi.spyOn(runtime, 'resolveRemoteTrackingBase').mockResolvedValue(trackingBase)
  const calls: { receiver: unknown; args: unknown[] }[] = []
  vi.spyOn(runtime, 'fetchRemoteWithCache').mockImplementation(async function (
    this: unknown,
    ...args
  ) {
    calls.push({ receiver: this, args })
    throw failure
  })
  await expect(runtime.probeWorktreeDrift('selected')).rejects.toBe(failure)
  expect(resolve).toHaveBeenCalledExactlyOnceWith(directory, 'main', {})
  expect(calls).toEqual([{ receiver: runtime, args: [directory, 'origin', {}] }])
})

it('retains omitted notification options and explicit sort-order options', async () => {
  const notify = vi.spyOn(runtime, 'notifyWorktreesChanged').mockImplementation(() => {})
  await runtime.updateManagedWorktreeMeta('selected', { comment: 'updated' })
  expect(store.getWorktreeMeta(runtime.selectedWorktree.id)?.comment).toBe('updated')
  expect(notify.mock.calls).toEqual([['repo']])
  const otherId = `repo::${join(directory, 'other')}`
  store.setWorktreeMeta(runtime.selectedWorktree.id, { sortOrder: 0 })
  store.setWorktreeMeta(otherId, { sortOrder: 0 })
  expect(runtime.persistManagedWorktreeSortOrder([runtime.selectedWorktree.id, otherId])).toEqual({
    updated: 2
  })
  expect(notify.mock.calls).toEqual([
    ['repo'],
    ['repo', { invalidateGitScans: false, sortOrderOnly: true }]
  ])
})

function configureMobileActivation(): () => number {
  let reads = 0
  const worktreeId = runtime.selectedWorktree.id
  Object.defineProperty(runtime.selectedWorktree, 'id', {
    get: () => {
      reads += 1
      return worktreeId
    }
  })
  // Only availability is consumed here; the fixture creates no desktop window.
  Object.defineProperties(runtime, {
    getAvailableAuthoritativeWindow: { configurable: true, value: () => ({}) },
    assertGraphReady: { value: () => {} },
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: { value: () => {} },
    refreshMobileSessionPtyRecords: { value: async () => null },
    notifyMobileSessionTabsChanged: { value: () => {} }
  })
  return () => reads
}

it.each([
  { label: 'absent notifier', notifier: null },
  { label: 'missing optional notifier method', notifier: {} }
])('skips the sleeping workspace ID read for $label', async ({ notifier }) => {
  const reads = configureMobileActivation()
  Object.defineProperty(runtime, 'notifier', { value: notifier })
  await runtime.activateManagedWorktree('selected', { clientKind: 'mobile' })
  expect(reads()).toBe(4)
})

it('looks up the sleeping callback late and keeps its notifier receiver', async () => {
  const reads = configureMobileActivation()
  const calls: { receiver: unknown; args: string[] }[] = []
  const notifier = {
    resumeSleepingAgents(this: unknown, ...args: string[]) {
      calls.push({ receiver: this, args })
    }
  }
  let currentNotifier: object = {}
  Object.defineProperty(runtime, 'notifier', { get: () => currentNotifier })
  Object.defineProperty(runtime, 'getAvailableAuthoritativeWindow', {
    value: () => {
      currentNotifier = notifier
      return {}
    }
  })
  await runtime.activateManagedWorktree('selected', { clientKind: 'mobile' })
  expect(reads()).toBe(5)
  expect(calls).toEqual([{ receiver: notifier, args: [runtime.selectedWorktree.id] }])
})
