import type { WorkspaceActivationHost } from './workspace-activation-ports'
import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import {
  navigationTargetsClients,
  navigationTargetsHost,
  resolveRuntimeNavigationTarget
} from '../../../shared/runtime-navigation'
import { getRepoExecutionHostId } from '../../../shared/execution-host'

export class RuntimeWorkspaceActivation {
  constructor(private readonly host: WorkspaceActivationHost) {}
  private get store() {
    return this.host.getStore()
  }
  async activateManagedWorktree(
    worktreeSelector: string,
    opts: {
      notifyClients?: boolean
      clientKind?: 'mobile' | 'runtime'
      navigation?: RuntimeNavigationTarget
    } = {}
  ): Promise<{
    repoId: string
    worktreeId: string
    activated: boolean
    /** Mobile-scoped slept-agent wake outcome. `unsupported-headless` means no
     *  renderer holds the sleeping records (headless `orca serve`), so nothing
     *  woke — clients must not present the worktree's agents as resumed. */
    sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable'
  }> {
    this.host.assertGraphReady()
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    const navigation = resolveRuntimeNavigationTarget({ ...opts, defaultTarget: 'host' })
    const targetsHost = navigationTargetsHost(navigation)
    const targetsClients = navigationTargetsClients(navigation)

    if (!targetsHost && this.store?.getWorktreeMeta(worktree.id)?.isUnread) {
      // Why: mobile/web session activation intentionally bypasses renderer
      // selection, so the runtime must acknowledge the unread state itself.
      this.store.setWorktreeMeta(worktree.id, { isUnread: false })
      this.host.notifyWorktreesChanged(repo.id)
    }

    let sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable' =
      'not-applicable'
    if (targetsHost || targetsClients) {
      // Why: inactive worktree terminal panes are renderer-owned and may not have
      // live PTYs until the desktop activates the worktree and mounts them.
      if (targetsHost) {
        this.host.notifyHostActivateWorktree(repo.id, worktree.id)
      }
      if (targetsClients) {
        this.host.notifyClientsActivateWorktree(
          repo.id,
          worktree.id,
          undefined,
          undefined,
          undefined,
          navigation
        )
      }
    }
    if (!targetsHost) {
      // Why: mobile/web selection needs fresh session surfaces without forcing
      // every attached desktop renderer to navigate to the phone's workspace.
      this.host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
        allowAttachedWindow: true
      })
      await this.host.refreshMobileSessionPtyRecords()
      this.host.notifyMobileSessionTabsChanged(worktree.id)
      // Why: a phone open must also wake the worktree's slept agents (experimental
      // agent sleep). Only the host renderer holds the sleeping records + wake
      // authority, so fire-and-forget ask it — mobile-scoped so web/desktop are
      // unaffected. Headless serve has no renderer to wake anything, so report
      // that explicitly instead of letting mobile assume the agents resumed.
      if (opts.clientKind === 'mobile') {
        if (this.host.getAvailableAuthoritativeWindow()) {
          this.host.resumeSleepingAgents(() => worktree.id)
          sleepingAgentWake = 'requested'
        } else if (
          // Why: sleeping records are partitioned by execution host; reading
          // only the local partition would miss slept agents on SSH-host
          // worktrees and skip the headless warning for them.
          Object.values(
            this.store?.getWorkspaceSession?.(getRepoExecutionHostId(repo))
              .sleepingAgentSessionsByPaneKey ?? {}
          ).some((record) => record.worktreeId === worktree.id)
        ) {
          // Why: headless is only degraded when this worktree actually has a
          // persisted resume record. Ordinary mobile activation must not show
          // an unsupported warning merely because no desktop window is open.
          sleepingAgentWake = 'unsupported-headless'
        }
      }
    }
    return { repoId: repo.id, worktreeId: worktree.id, activated: true, sleepingAgentWake }
  }
}
