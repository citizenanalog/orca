import { RuntimeWorkspaceCreationSurface } from './workspace-creation-surface'
import type { RuntimeWorkspaceMetadata } from './workspace-metadata'

export class RuntimeWorkspaceMetadataSurface extends RuntimeWorkspaceCreationSurface {
  getCanonicalFetchKey(
    ...args: Parameters<RuntimeWorkspaceMetadata['getCanonicalFetchKey']>
  ): ReturnType<RuntimeWorkspaceMetadata['getCanonicalFetchKey']> {
    return this.workspaceMetadata.getCanonicalFetchKey(...args)
  }

  getOrStartRemoteFetch(
    ...args: Parameters<RuntimeWorkspaceMetadata['getOrStartRemoteFetch']>
  ): ReturnType<RuntimeWorkspaceMetadata['getOrStartRemoteFetch']> {
    return this.workspaceMetadata.getOrStartRemoteFetch(...args)
  }

  getOrStartRemoteTrackingBaseRefresh(
    ...args: Parameters<RuntimeWorkspaceMetadata['getOrStartRemoteTrackingBaseRefresh']>
  ): ReturnType<RuntimeWorkspaceMetadata['getOrStartRemoteTrackingBaseRefresh']> {
    return this.workspaceMetadata.getOrStartRemoteTrackingBaseRefresh(...args)
  }

  fetchRemoteWithCache(
    ...args: Parameters<RuntimeWorkspaceMetadata['fetchRemoteWithCache']>
  ): ReturnType<RuntimeWorkspaceMetadata['fetchRemoteWithCache']> {
    return this.workspaceMetadata.fetchRemoteWithCache(...args)
  }

  resolveRemoteTrackingBase(
    ...args: Parameters<RuntimeWorkspaceMetadata['resolveRemoteTrackingBase']>
  ): ReturnType<RuntimeWorkspaceMetadata['resolveRemoteTrackingBase']> {
    return this.workspaceMetadata.resolveRemoteTrackingBase(...args)
  }

  hasRemoteTrackingRef(
    ...args: Parameters<RuntimeWorkspaceMetadata['hasRemoteTrackingRef']>
  ): ReturnType<RuntimeWorkspaceMetadata['hasRemoteTrackingRef']> {
    return this.workspaceMetadata.hasRemoteTrackingRef(...args)
  }

  recordOptimisticReconcileToken(
    ...args: Parameters<RuntimeWorkspaceMetadata['recordOptimisticReconcileToken']>
  ): ReturnType<RuntimeWorkspaceMetadata['recordOptimisticReconcileToken']> {
    return this.workspaceMetadata.recordOptimisticReconcileToken(...args)
  }

  clearOptimisticReconcileToken(
    ...args: Parameters<RuntimeWorkspaceMetadata['clearOptimisticReconcileToken']>
  ): ReturnType<RuntimeWorkspaceMetadata['clearOptimisticReconcileToken']> {
    return this.workspaceMetadata.clearOptimisticReconcileToken(...args)
  }

  emitWorktreeBaseStatus(
    ...args: Parameters<RuntimeWorkspaceMetadata['emitWorktreeBaseStatus']>
  ): ReturnType<RuntimeWorkspaceMetadata['emitWorktreeBaseStatus']> {
    return this.workspaceMetadata.emitWorktreeBaseStatus(...args)
  }

  reconcileWorktreeBaseStatus(
    ...args: Parameters<RuntimeWorkspaceMetadata['reconcileWorktreeBaseStatus']>
  ): ReturnType<RuntimeWorkspaceMetadata['reconcileWorktreeBaseStatus']> {
    return this.workspaceMetadata.reconcileWorktreeBaseStatus(...args)
  }

  probeWorktreeDrift(
    ...args: Parameters<RuntimeWorkspaceMetadata['probeWorktreeDrift']>
  ): ReturnType<RuntimeWorkspaceMetadata['probeWorktreeDrift']> {
    return this.workspaceMetadata.probeWorktreeDrift(...args)
  }

  updateManagedWorktreeMeta(
    ...args: Parameters<RuntimeWorkspaceMetadata['updateManagedWorktreeMeta']>
  ): ReturnType<RuntimeWorkspaceMetadata['updateManagedWorktreeMeta']> {
    return this.workspaceMetadata.updateManagedWorktreeMeta(...args)
  }

  adoptManagedProvisionedRoot(
    ...args: Parameters<RuntimeWorkspaceMetadata['adoptManagedProvisionedRoot']>
  ): ReturnType<RuntimeWorkspaceMetadata['adoptManagedProvisionedRoot']> {
    return this.workspaceMetadata.adoptManagedProvisionedRoot(...args)
  }

  persistManagedWorktreeSortOrder(
    ...args: Parameters<RuntimeWorkspaceMetadata['persistManagedWorktreeSortOrder']>
  ): ReturnType<RuntimeWorkspaceMetadata['persistManagedWorktreeSortOrder']> {
    return this.workspaceMetadata.persistManagedWorktreeSortOrder(...args)
  }

  resolveManagedPrBase(
    ...args: Parameters<RuntimeWorkspaceMetadata['resolveManagedPrBase']>
  ): ReturnType<RuntimeWorkspaceMetadata['resolveManagedPrBase']> {
    return this.workspaceMetadata.resolveManagedPrBase(...args)
  }

  resolveManagedMrBase(
    ...args: Parameters<RuntimeWorkspaceMetadata['resolveManagedMrBase']>
  ): ReturnType<RuntimeWorkspaceMetadata['resolveManagedMrBase']> {
    return this.workspaceMetadata.resolveManagedMrBase(...args)
  }
}
