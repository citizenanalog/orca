import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { WorktreeStartupLaunch } from '../../../shared/worktree/launch-types'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { RuntimeWorktreeLifecycleEvent } from '../orca-runtime-core'
import type { RuntimeStore } from '../runtime-store-contract'
import type { TerminalCreateOptions } from '../runtime-terminal-contracts'
import type { HostedReviewExecutionOptions } from '../../source-control/hosted-review-git-options'
import type { LocalProjectGhExecOptions } from '../../project-runtime-git-options'
import type { RuntimeRemoteFetchController } from '../runtime-remote-fetch-controller'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup,
  resolveWorktreeCreateAgentStartup
} from '../runtime-worktree-agent-startup'
import type { recordCreatedWorktreeLineage } from '../runtime-worktree-lineage-recording'
import type {
  WorktreeLineageInput,
  WorktreeLineageResolution
} from '../runtime-worktree-lineage-resolution'
import type { WorktreeTerminalProvisioningArgs } from '../runtime-worktree-terminal-provisioning'

type StartupAgentBuilder = Parameters<typeof resolveWorktreeCreateAgentStartup>[1]

export type WorkspaceCreationHost = Pick<
  RuntimeRemoteFetchController,
  | 'resolveRemoteTrackingBase'
  | 'hasRemoteTrackingRef'
  | 'getOrStartRemoteTrackingBaseRefresh'
  | 'fetchRemoteWithCache'
> & {
  getStore(): RuntimeStore | null
  requireStore(): RuntimeStore
  canSpawn(): boolean
  hasAuthoritativeWindow(): boolean
  resolveRepoSelector(selector: string): Promise<Repo>
  buildStartupForAgent(
    repo: Repo,
    ...args: Parameters<StartupAgentBuilder>
  ): ReturnType<StartupAgentBuilder>
  buildStartupForDraft(
    repo: Repo,
    draft: string,
    requestedAgent?: TuiAgent,
    launchSource?: string
  ): Promise<{
    agent: TuiAgent
    startup: WorktreeStartupLaunch
    draftPaste?: WorktreeStartupDraftPaste
  } | null>
  resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput,
    childRepo?: Repo
  ): Promise<WorktreeLineageResolution>
  recordCreatedWorktreeLineage(
    worktree: Parameters<typeof recordCreatedWorktreeLineage>[1],
    resolution: WorktreeLineageResolution
  ): ReturnType<typeof recordCreatedWorktreeLineage>
  getHostedReviewExecutionOptions(repo: Repo): HostedReviewExecutionOptions
  getLocalGitExecutionOptionArgs(repo: Repo): [] | [LocalProjectGhExecOptions]
  shouldProvisionWorktreeInBackground(navigation?: RuntimeNavigationTarget): boolean
  createTerminal(
    selector: string,
    options: TerminalCreateOptions,
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalCreate>
  pasteStartupDraftWhenReady(handle: string, draft: WorktreeStartupDraftPaste): void
  sendStartupFollowupWhenReady(handle: string, followup: WorktreeStartupFollowup): void
  provisionManagedWorktreeTerminals(
    options: WorktreeTerminalProvisioningArgs,
    createdWorktree?: Worktree
  ): Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }>
  notifyActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs'],
    navigationTarget?: RuntimeNavigationTarget
  ): void
  invalidateResolvedWorktreeCache(): void
  invalidateWorktreeScanCacheForRepo(repoId: string): void
  notifyWorktreesChanged(repoId: string): void
  emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void
}
