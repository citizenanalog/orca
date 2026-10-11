// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { TerminalLayoutController } from './terminal/layout/terminal-layout-controller'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { OrcaRuntimeWithFitOverrideListeners } from './orca-runtime-fit-override-listeners'

import { RuntimeEdgeCommandController } from './runtime-edge-command-controller'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import { RuntimeBrowserDriverController } from './runtime-browser-driver-controller'

import { RuntimeWorkspaceMetadata } from './workspaces/workspace-metadata'
import { RuntimeWorkspaceCreation } from './workspaces/workspace-creation'
import { RuntimeWorkspaceActivation } from './workspaces/workspace-activation'
import type { StatsCollector } from '../stats/collector'
import { RuntimeRemoteFetchController } from './runtime-remote-fetch-controller'
import { RuntimeWorktreeBaseReconciliation } from './runtime-worktree-base-reconciliation'
import { RuntimeWorkspaceRemovalRecovery } from './workspaces/workspace-removal-recovery'
import { RuntimeWorkspaceRemoval } from './workspaces/workspace-removal'
import { killAllProcessesForWorktree } from './worktree-teardown'
import { teardownFolderWorkspacePtys } from './folder-workspace-pty-teardown'

export class OrcaRuntimeWithTerminalDrivers extends OrcaRuntimeWithFitOverrideListeners {
  protected readonly terminalLayout = new TerminalLayoutController({
    getStore: () => this.store,
    getNotifier: () => this.notifier,
    getPtyController: () => this.ptyController,
    getTerminalSize: (ptyId) => this.getTerminalSize(ptyId),
    resizeHeadlessTerminal: (ptyId, cols, rows) => this.resizeHeadlessTerminal(ptyId, cols, rows),
    notifyRemoteTerminalViewPresenceChanged: (ptyId) =>
      this.notifyRemoteTerminalViewPresenceChanged(ptyId),
    isUnattachedLocalCandidate: (ptyId) => {
      if (
        this.headlessTerminals.has(ptyId) ||
        this.providerSnapshotPreferredPtys.has(ptyId) ||
        this.pendingPtyRegistrationIncarnations.has(ptyId) ||
        parseAppSshPtyId(ptyId)
      ) {
        return false
      }
      const pty = this.ptysById.get(ptyId)
      return pty !== undefined && pty.connectionId === null && pty.connected
    }
  })

  protected readonly edgeCommands = new RuntimeEdgeCommandController({
    browserHost: {
      getAgentBrowserBridge: () => this.agentBrowserBridge,
      resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
      resolveBrowserWorkspace: (selector) => this.resolveBrowserWorkspace(selector),
      getBrowserHostLeaseRegistry: () => getBrowserHostLeaseRegistry(this),
      getRuntimeBrowserPageRegistry: () => getRuntimeBrowserPageRegistry(this),
      resolveBrowserNetworkExecutionHost: (worktree) =>
        this.resolveBrowserNetworkExecutionHostForWorktree(worktree),
      getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
      getAvailableAuthoritativeWindow: () => this.getAvailableAuthoritativeWindow(),
      getOffscreenBrowserBackend: () => this.offscreenBrowserBackend,
      markHeadlessBrowserSessionTabActive: this.markHeadlessBrowserSessionTabActive.bind(this),
      notifyHeadlessBrowserSessionTabsChanged: (worktreeId) =>
        this.notifyMobileSessionTabsChanged(worktreeId),
      retireRuntimeOwnedBrowserSessionTab: (worktreeId, browserPageId) =>
        this.retireRuntimeOwnedBrowserSessionTab(worktreeId, browserPageId)
    },
    screencast: {
      registerSubscriptionCleanup: (subscriptionId, cleanup, connectionId) =>
        (this as RuntimeCommandSurfaceHost<this>).registerSubscriptionCleanup(
          subscriptionId,
          cleanup,
          connectionId
        ),
      cleanupSubscription: (subscriptionId) =>
        (this as RuntimeCommandSurfaceHost<this>).cleanupSubscription(subscriptionId),
      getDriver: (browserPageId) => this.browserDrivers.get(browserPageId),
      setDriver: (browserPageId, next) => this.browserDrivers.set(browserPageId, next),
      notifyRemoteViewersChanged: (browserPageId, hasRemoteViewers) =>
        this.notifier?.browserRemoteViewersChanged?.(browserPageId, hasRemoteViewers)
    },
    getBrowserCommands: () => this.browserCommands,
    emulatorHost: {
      getEmulatorBridge: () => this.emulatorBridge,
      resolveEmulatorWorkspaceId: (selector) => this.resolveEmulatorWorkspaceId(selector),
      resolveEmulatorCleanupWorkspaceId: (selector) =>
        this.resolveEmulatorCleanupWorkspaceId(selector),
      getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
      getSettings: () => this.requireStore().getSettings()
    }
  })

  // Why: tests and diagnostic seams replace only screencast startup; ordinary edge methods stay pre-bound.
  protected browserCommands = this.edgeCommands.getBrowserCommands()

  protected readonly browserDrivers = new RuntimeBrowserDriverController({
    notifyChanged: (browserPageId, next) =>
      this.notifier?.browserDriverChanged?.(browserPageId, next),
    cancelScreencast: (browserPageId) => this.edgeCommands.cancelScreencast(browserPageId)
  })

  protected stats: StatsCollector | null = null

  // Why: create and drift probes must share one fetch/freshness owner.
  protected readonly remoteFetches = new RuntimeRemoteFetchController()

  protected readonly worktreeBaseReconciliation = new RuntimeWorktreeBaseReconciliation(
    this.remoteFetches,
    () => this.notifier
  )

  protected readonly workspaceRemovalRecovery = new RuntimeWorkspaceRemovalRecovery({
    getStore: () => this.store,
    getPreservedBranchCleanup: () => this.preservedBranchCleanup,
    localRemovalJobHost: (store) => this.localRemovalJobHost(store),
    purgeRemovedWorktree: (...args) => this.purgeRemovedWorktree(...args),
    getAcquireFileWatcherRemoval: () => this.acquireFileWatcherRemoval,
    closeFileWatchersForRemoval: (path) => this.closeFileWatchersForRemoval(path),
    stopPtysForDestructiveWorktreeRemoval: (id, options) =>
      this.stopPtysForDestructiveWorktreeRemoval(id, options),
    emitWorktreeLifecycle: (event) => this.emitWorktreeLifecycle(event),
    publishWorktreeRemovalChange: (id) => this.publishWorktreeRemovalChange(id),
    clearOptimisticReconcileToken: (id) => this.clearOptimisticReconcileToken(id),
    removeWorktreeMetadataAndHistory: (store, id, host) =>
      this.removeWorktreeMetadataAndHistory(store, id, host),
    invalidateResolvedWorktreeCache: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScanCacheForRepo: (id) => this.invalidateWorktreeScanCacheForRepo(id)
  })

  protected readonly workspaceRemoval = new RuntimeWorkspaceRemoval({
    getStore: () => this.store,
    requireStore: () => this.requireStore(),
    resolveWorktreeRemovalTarget: (selector, hostId) =>
      this.resolveWorktreeRemovalTarget(selector, hostId),
    joinPendingWorktreeRemoval: (worktreeId, options) =>
      this.joinPendingWorktreeRemoval(worktreeId, options),
    emitWorktreeLifecycle: (event) => this.emitWorktreeLifecycle(event),
    purgeRemovedWorktree: (store, worktreeId, repoId, hostId) =>
      this.purgeRemovedWorktree(store, worktreeId, repoId, hostId),
    retryFailedLocalRemoval: (route, target, registered, options) =>
      this.retryFailedLocalRemoval(route, target, registered, options),
    getLocalProvider: () => this.getLocalProvider(),
    getOnPtyStopped: () => this.onPtyStopped,
    killOrphanWorktreeProcesses: (worktreeId, deps) =>
      killAllProcessesForWorktree(worktreeId, { runtime: this, ...deps }),
    teardownFolderWorkspacePtys: (worktreeId, connectionId) =>
      teardownFolderWorkspacePtys(
        {
          runtime: this,
          getLocalProvider: () => this.getLocalProvider(),
          onPtyStopped: this.onPtyStopped
        },
        worktreeId,
        connectionId
      ),
    getAcquireFileWatcherRemoval: () => this.acquireFileWatcherRemoval,
    acquireFileWatcherRemoval: (...args) => this.acquireFileWatcherRemoval(...args),
    clearOptimisticReconcileToken: (worktreeId) => this.clearOptimisticReconcileToken(worktreeId),
    removeWorktreeMetadataAndHistory: (store, worktreeId, hostId) =>
      this.removeWorktreeMetadataAndHistory(store, worktreeId, hostId),
    getPreservedBranchCleanup: () => this.preservedBranchCleanup,
    invalidateResolvedWorktreeCache: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScanCacheForRepo: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyWorktreesChanged: (repoId) => this.notifyWorktreesChanged(repoId),
    stopPtysForDestructiveWorktreeRemoval: (worktreeId, options) =>
      this.stopPtysForDestructiveWorktreeRemoval(worktreeId, options),
    closeFileWatchersForRemoval: (path) => this.closeFileWatchersForRemoval(path),
    publishWorktreeRemovalChange: (repoId) => this.publishWorktreeRemovalChange(repoId)
  })
  protected readonly workspaceActivation = new RuntimeWorkspaceActivation({
    getStore: () => this.store,
    assertGraphReady: () => this.assertGraphReady(),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    notifyWorktreesChanged: (id) => this.notifyWorktreesChanged(id),
    notifyHostActivateWorktree: (repoId, worktreeId) =>
      this.notifyHostActivateWorktree(repoId, worktreeId),
    notifyClientsActivateWorktree: (...args) => this.notifyClientsActivateWorktree(...args),
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(...args),
    refreshMobileSessionPtyRecords: () => this.refreshMobileSessionPtyRecords(),
    notifyMobileSessionTabsChanged: (id) => this.notifyMobileSessionTabsChanged(id),
    getAvailableAuthoritativeWindow: () => this.getAvailableAuthoritativeWindow(),
    resumeSleepingAgents: (getWorktreeId) => this.notifier?.resumeSleepingAgents?.(getWorktreeId())
  })

  protected readonly workspaceCreation = new RuntimeWorkspaceCreation({
    getStore: () => this.store,
    requireStore: () => this.requireStore(),
    canSpawn: () => Boolean(this.ptyController?.spawn),
    hasAuthoritativeWindow: () => this.authoritativeWindowId !== null,
    resolveRepoSelector: (selector) => this.resolveRepoSelector(selector),
    buildStartupForAgent: (...args) => this.buildStartupForAgent(...args),
    buildStartupForDraft: (...args) => this.buildStartupForDraft(...args),
    resolveLineageForWorktreeCreate: (...args) => this.resolveLineageForWorktreeCreate(...args),
    recordCreatedWorktreeLineage: (...args) => this.recordCreatedWorktreeLineage(...args),
    getHostedReviewExecutionOptions: (repo) => this.getHostedReviewExecutionOptions(repo),
    getLocalGitExecutionOptionArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo),
    resolveRemoteTrackingBase: (...args) => this.resolveRemoteTrackingBase(...args),
    hasRemoteTrackingRef: (...args) => this.hasRemoteTrackingRef(...args),
    getOrStartRemoteTrackingBaseRefresh: (...args) =>
      this.getOrStartRemoteTrackingBaseRefresh(...args),
    fetchRemoteWithCache: (...args) => this.fetchRemoteWithCache(...args),
    shouldProvisionWorktreeInBackground: (navigation) =>
      this.shouldProvisionWorktreeInBackground(navigation),
    createTerminal: (...args) => this.createTerminal(...args),
    pasteStartupDraftWhenReady: (...args) => this.pasteStartupDraftWhenReady(...args),
    sendStartupFollowupWhenReady: (...args) => this.sendStartupFollowupWhenReady(...args),
    provisionManagedWorktreeTerminals: (...args) => this.provisionManagedWorktreeTerminals(...args),
    notifyActivateWorktree: (...args) => this.notifyActivateWorktree(...args),
    invalidateResolvedWorktreeCache: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScanCacheForRepo: (id) => this.invalidateWorktreeScanCacheForRepo(id),
    notifyWorktreesChanged: (id) => this.notifyWorktreesChanged(id),
    emitWorktreeLifecycle: (event) => this.emitWorktreeLifecycle(event)
  })
  protected readonly workspaceMetadata = new RuntimeWorkspaceMetadata({
    getStore: () => this.store,
    resolveRemoteTrackingBase: (...args) => this.resolveRemoteTrackingBase(...args),
    fetchRemoteWithCache: (...args) => this.fetchRemoteWithCache(...args),
    requireStore: () => this.requireStore(),
    resolveRepoSelector: (selector) => this.resolveRepoSelector(selector),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    showManagedWorktree: (selector) => this.showManagedWorktree(selector),
    invalidateResolvedWorktreeCache: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScanCacheForRepo: (id) => this.invalidateWorktreeScanCacheForRepo(id),
    notifyWorktreesChanged: (...args) => this.notifyWorktreesChanged(...args),
    getRemoteFetches: () => this.remoteFetches,
    getWorktreeBaseReconciliation: () => this.worktreeBaseReconciliation,
    getWorktreeLineage: () => this.worktreeLineage
  })
}
