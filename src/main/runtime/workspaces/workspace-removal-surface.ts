import { RuntimeWorkspaceMetadataSurface } from './workspace-metadata-surface'
import type { RuntimeWorkspaceRemoval } from './workspace-removal'

export class RuntimeWorkspaceRemovalSurface extends RuntimeWorkspaceMetadataSurface {
  removeManagedWorktree(
    ...args: Parameters<RuntimeWorkspaceRemoval['removeManagedWorktree']>
  ): ReturnType<RuntimeWorkspaceRemoval['removeManagedWorktree']> {
    return this.workspaceRemoval.removeManagedWorktree(...args)
  }
}
