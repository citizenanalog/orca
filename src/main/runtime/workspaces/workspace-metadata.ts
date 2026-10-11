import type { WorkspaceMetadataHost } from './workspace-metadata-ports'
import type { LocalGitExecOptions } from '../../git/repo-default-base-ref'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { RemoteFetchResult, RemoteTrackingBase } from '../runtime-remote-fetch-controller'
import type { WorktreeBaseStatusEvent } from '../../../shared/worktree/base-ref-drift-types'
import { probeRuntimeWorktreeDrift } from '../runtime-worktree-drift-probe'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { GitHubPrStartPoint, GitPushTarget } from '../../../shared/worktree/types'
import {
  persistRuntimeManagedWorktreeSortOrder,
  updateRuntimeManagedWorktreeMetadata
} from '../runtime-managed-worktree-metadata'
import { resolveRuntimeGitHubWorktreeBase } from '../runtime-github-worktree-base'
import { resolveRuntimeGitLabWorktreeBase } from '../runtime-gitlab-worktree-base'
import { listWorktreesStrict } from '../../git/worktree-listing'
import {
  adoptRuntimeProvisionedRoot,
  readLocalSparseCheckoutEnabled,
  type RuntimeProvisionedRootRequest
} from '../runtime-provisioned-root-adoption'

export class RuntimeWorkspaceMetadata {
  constructor(private readonly host: WorkspaceMetadataHost) {}
  private get store() {
    return this.host.getStore()
  }
  private get remoteFetches() {
    return this.host.getRemoteFetches()
  }
  private get worktreeBaseReconciliation() {
    return this.host.getWorktreeBaseReconciliation()
  }
  private get worktreeLineage() {
    return this.host.getWorktreeLineage()
  }
  async getCanonicalFetchKey(
    repoPath: string,
    remote: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<string> {
    return await this.remoteFetches.getCanonicalFetchKey(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteFetch(
    repoPath: string,
    remote: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteFetch(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteTrackingBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteTrackingBaseRefresh(repoPath, base, gitOptions)
  }

  async fetchRemoteWithCache(
    repoPath: string,
    remote: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<void> {
    await this.remoteFetches.fetchRemoteWithCache(repoPath, remote, gitOptions)
  }

  async resolveRemoteTrackingBase(
    repoPath: string,
    baseBranch: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<RemoteTrackingBase | null> {
    return await this.remoteFetches.resolveRemoteTrackingBase(repoPath, baseBranch, gitOptions)
  }

  async hasRemoteTrackingRef(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<boolean> {
    return await this.remoteFetches.hasRemoteTrackingRef(repoPath, base, gitOptions)
  }

  recordOptimisticReconcileToken(worktreeId: string): string {
    return this.worktreeBaseReconciliation.recordToken(worktreeId)
  }

  clearOptimisticReconcileToken(worktreeId: string): void {
    this.worktreeBaseReconciliation.clearToken(worktreeId)
  }

  emitWorktreeBaseStatus(event: WorktreeBaseStatusEvent): void {
    this.worktreeBaseReconciliation.emitStatus(event)
  }

  async reconcileWorktreeBaseStatus(args: {
    repoId: string
    repoPath: string
    worktreeId: string
    base: RemoteTrackingBase
    branchName: string
    createdBaseSha: string
    token: string
    fetchPromise: Promise<RemoteFetchResult>
  }): Promise<void> {
    await this.worktreeBaseReconciliation.reconcile(args)
  }

  /**
   * Probe how far the worktree's HEAD is behind its tracking remote. Returns
   * null when the probe cannot establish a signal (no default base ref, or
   * git failure). Dispatch treats null as "unknown — proceed" (§3.1); only
   * knowing-and-stale refuses.
   */
  async probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null> {
    return probeRuntimeWorktreeDrift({
      selector: worktreeSelector,
      store: this.store ? this.host.requireStore() : null,
      resolveWorktree: (selector) => this.host.resolveWorktreeSelector(selector),
      resolveRemoteTrackingBase: (repoPath, base, options) =>
        this.host.resolveRemoteTrackingBase(repoPath, base, options),
      fetchRemote: (repoPath, remote, options) =>
        this.host.fetchRemoteWithCache(repoPath, remote, options)
    })
  }

  async updateManagedWorktreeMeta(
    worktreeSelector: string,
    updates: Omit<Partial<WorktreeMeta>, 'pushTarget'> & {
      pushTarget?: GitPushTarget | null
      lineage?: {
        parentWorktree?: string
        noParent?: boolean
      }
    }
  ) {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return updateRuntimeManagedWorktreeMetadata({
      selector: worktreeSelector,
      updates,
      store: this.store,
      ports: {
        resolveWorktree: (selector) => this.host.resolveWorktreeSelector(selector),
        validateParent: (worktree, parent) => this.worktreeLineage.validateParent(worktree, parent),
        invalidateResolved: () => this.host.invalidateResolvedWorktreeCache(),
        invalidateScan: (repoId) => this.host.invalidateWorktreeScanCacheForRepo(repoId),
        notifyChanged: (repoId) => this.host.notifyWorktreesChanged(repoId),
        showWorktree: (selector) => this.host.showManagedWorktree(selector)
      }
    })
  }

  adoptManagedProvisionedRoot(
    repoSelector: string,
    request: RuntimeProvisionedRootRequest
  ): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return adoptRuntimeProvisionedRoot(repoSelector, request, {
      store: this.store,
      resolveRepo: (selector) => this.host.resolveRepoSelector(selector),
      listWorktrees: (repoPath) => listWorktreesStrict(repoPath),
      isSparseCheckoutEnabled: readLocalSparseCheckoutEnabled,
      invalidateScan: (repoId) => {
        this.host.invalidateResolvedWorktreeCache()
        this.host.invalidateWorktreeScanCacheForRepo(repoId)
      },
      notifyChanged: (repoId) => this.host.notifyWorktreesChanged(repoId),
      showWorktree: (selector) => this.host.showManagedWorktree(selector)
    })
  }

  persistManagedWorktreeSortOrder(orderedIds: string[]): { updated: number } {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return persistRuntimeManagedWorktreeSortOrder({
      orderedIds,
      store: this.store,
      invalidateResolved: () => this.host.invalidateResolvedWorktreeCache(),
      notifyChanged: (repoId) =>
        this.host.notifyWorktreesChanged(repoId, { invalidateGitScans: false, sortOrderOnly: true })
    })
  }

  async resolveManagedPrBase(args: {
    repoSelector: string
    prNumber: number
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }): Promise<GitHubPrStartPoint | { error: string }> {
    return resolveRuntimeGitHubWorktreeBase(args, {
      store: this.store ? this.host.requireStore() : null,
      resolveRepo: (selector) => this.host.resolveRepoSelector(selector)
    })
  }

  async resolveManagedMrBase(args: {
    repoSelector: string
    mrIid: number
    sourceBranch?: string
    targetBranch?: string
    isCrossRepository?: boolean
  }): Promise<
    { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget } | { error: string }
  > {
    return resolveRuntimeGitLabWorktreeBase(args, {
      store: this.store ? this.host.requireStore() : null,
      resolveRepo: (selector) => this.host.resolveRepoSelector(selector)
    })
  }
}
