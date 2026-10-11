import { OrcaRuntimeWithGetWorktreeTerminalProvisioningHost } from '../orca-runtime-get-worktree-terminal-provisioning-host'
import type { RuntimeWorkspaceCreation } from './workspace-creation'

export class RuntimeWorkspaceCreationSurface extends OrcaRuntimeWithGetWorktreeTerminalProvisioningHost {
  createManagedWorktree(
    ...args: Parameters<RuntimeWorkspaceCreation['createManagedWorktree']>
  ): ReturnType<RuntimeWorkspaceCreation['createManagedWorktree']> {
    return this.workspaceCreation.createManagedWorktree(...args)
  }
}
