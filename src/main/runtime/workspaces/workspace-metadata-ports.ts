import type { WorkspaceCreationHost } from './workspace-creation-ports'
import type { RuntimeRemoteFetchController } from '../runtime-remote-fetch-controller'
import type { RuntimeWorktreeBaseReconciliation } from '../runtime-worktree-base-reconciliation'
import type { RuntimeWorktreeLineageController } from '../runtime-worktree-lineage-controller'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { Worktree } from '../../../shared/worktree/types'

export type WorkspaceMetadataHost = Pick<
  WorkspaceCreationHost,
  | 'getStore'
  | 'requireStore'
  | 'resolveRemoteTrackingBase'
  | 'fetchRemoteWithCache'
  | 'resolveRepoSelector'
  | 'invalidateResolvedWorktreeCache'
  | 'invalidateWorktreeScanCacheForRepo'
> & {
  getRemoteFetches(): RuntimeRemoteFetchController
  getWorktreeBaseReconciliation(): RuntimeWorktreeBaseReconciliation
  getWorktreeLineage(): Pick<RuntimeWorktreeLineageController, 'validateParent'>
  resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree>
  showManagedWorktree(selector: string): Promise<Worktree>
  notifyWorktreesChanged(
    repoId: string,
    options?: { invalidateGitScans?: boolean; sortOrderOnly?: boolean }
  ): void
}
