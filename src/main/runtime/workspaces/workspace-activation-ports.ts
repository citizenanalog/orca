import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { WorkspaceCreationHost } from './workspace-creation-ports'

export type WorkspaceActivationHost = Pick<
  WorkspaceCreationHost,
  'getStore' | 'notifyWorktreesChanged'
> & {
  assertGraphReady(): void
  resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree>
  notifyHostActivateWorktree(repoId: string, worktreeId: string): void
  notifyClientsActivateWorktree: WorkspaceCreationHost['notifyActivateWorktree']
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId: string,
    options: { allowAttachedWindow: true }
  ): void
  refreshMobileSessionPtyRecords(): Promise<void>
  notifyMobileSessionTabsChanged(worktreeId: string): void
  getAvailableAuthoritativeWindow(): object | null
  resumeSleepingAgents(getWorktreeId: () => string): void
}
