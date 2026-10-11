import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveRepo = vi.hoisted(() => vi.fn<WorkspaceCreationHost['resolveRepoSelector']>())
vi.mock('../workspace-create-telemetry', () => ({
  trackRuntimeWorkspaceCreate: (
    _request: unknown,
    execute: (events: { begin: ReturnType<typeof vi.fn> }) => Promise<unknown>
  ) => execute({ begin: vi.fn() })
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/private/test', isPackaged: false },
  BrowserWindow: { fromId: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))

import { RuntimeWorkspaceCreation } from './workspaces/workspace-creation'
import type { WorkspaceCreationHost } from './workspaces/workspace-creation-ports'
import type { RuntimeStore } from './runtime-store-contract'

function makeRuntime(): RuntimeWorkspaceCreation {
  const unexpectedEffect = (): never => {
    throw new Error('unexpected_creation_effect')
  }
  const store: RuntimeStore = {
    getRepos: unexpectedEffect,
    getRepo: unexpectedEffect,
    addRepo: unexpectedEffect,
    updateRepo: unexpectedEffect,
    getAllWorktreeMeta: unexpectedEffect,
    getWorktreeMeta: unexpectedEffect,
    setWorktreeMeta: unexpectedEffect,
    removeWorktreeMeta: unexpectedEffect,
    getGitHubCache: unexpectedEffect,
    getSettings: () => ({
      workspaceDir: '',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: '',
      disabledTuiAgents: []
    })
  }
  return new RuntimeWorkspaceCreation({
    getStore: () => store,
    requireStore: unexpectedEffect,
    canSpawn: unexpectedEffect,
    hasAuthoritativeWindow: unexpectedEffect,
    resolveRepoSelector: resolveRepo,
    buildStartupForAgent: unexpectedEffect,
    buildStartupForDraft: unexpectedEffect,
    resolveLineageForWorktreeCreate: unexpectedEffect,
    recordCreatedWorktreeLineage: unexpectedEffect,
    getHostedReviewExecutionOptions: unexpectedEffect,
    getLocalGitExecutionOptionArgs: unexpectedEffect,
    resolveRemoteTrackingBase: unexpectedEffect,
    hasRemoteTrackingRef: unexpectedEffect,
    getOrStartRemoteTrackingBaseRefresh: unexpectedEffect,
    fetchRemoteWithCache: unexpectedEffect,
    shouldProvisionWorktreeInBackground: unexpectedEffect,
    createTerminal: unexpectedEffect,
    pasteStartupDraftWhenReady: unexpectedEffect,
    sendStartupFollowupWhenReady: unexpectedEffect,
    provisionManagedWorktreeTerminals: unexpectedEffect,
    notifyActivateWorktree: unexpectedEffect,
    invalidateResolvedWorktreeCache: unexpectedEffect,
    invalidateWorktreeScanCacheForRepo: unexpectedEffect,
    notifyWorktreesChanged: unexpectedEffect,
    emitWorktreeLifecycle: unexpectedEffect
  })
}

describe('unverified OpenCode model worktree creation', () => {
  beforeEach(() => {
    resolveRepo.mockReset()
    resolveRepo.mockRejectedValue(new Error('repo_read_before_model_refusal'))
  })

  it.each(['local-repo', 'folder-repo', 'ssh-repo'])(
    'refuses %s before resolving or creating its workspace',
    async (repoSelector) => {
      const runtime = makeRuntime()
      await expect(
        runtime.createManagedWorktree({
          repoSelector,
          name: 'unverified-model',
          startupAgent: 'opencode',
          startupLaunchPreferences: { model: 'private-proof/model-b' }
        })
      ).rejects.toMatchObject({ code: 'capability_unsupported' })
      expect(resolveRepo).not.toHaveBeenCalled()
    }
  )

  it('preserves worktree creation without a model preference', async () => {
    const runtime = makeRuntime()
    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'local-repo',
        name: 'ordinary',
        startupAgent: 'opencode'
      })
    ).rejects.toThrow('repo_read_before_model_refusal')
    expect(resolveRepo).toHaveBeenCalledOnce()
  })
})
