import type { DatabaseManager } from '../database'
import type { AgentManager } from '../agent-manager'
import type { GitHubManager } from '../github-manager'
import type { GitLabManager } from '../gitlab-manager'
import type { ForgejoManager } from '../forgejo-manager'
import type { WorktreeManager } from '../worktree-manager'
import type { SyncManager } from '../sync-manager'
import type { PluginRegistry } from '../plugins/registry'
import type { OAuthManager } from '../oauth/oauth-manager'
import type { ClaudePluginManager } from '../claude-plugin-manager'
import type { HeartbeatScheduler } from '../heartbeat-scheduler'
import type { WorkspaceCleanupScheduler } from '../workspace-cleanup-scheduler'
import type { VoiceSessionManager } from '../voice/voice-session-manager'

/** Everything the IPC handlers reach into. Optional services may be absent in tests. */
export interface IpcDeps {
  db: DatabaseManager
  agentManager: AgentManager
  githubManager: GitHubManager
  worktreeManager: WorktreeManager
  syncManager: SyncManager
  pluginRegistry: PluginRegistry
  oauthManager?: OAuthManager
  claudePluginManager?: ClaudePluginManager
  heartbeatScheduler?: HeartbeatScheduler
  gitlabManager?: GitLabManager
  forgejoManager?: ForgejoManager
  workspaceCleanupScheduler?: WorkspaceCleanupScheduler
  voiceSessionManager?: VoiceSessionManager
}

/** Returns an optional service, or throws the error the renderer shows when it is missing. */
export function required<T>(service: T | undefined, name: string): T {
  if (!service) throw new Error(`${name} not initialized`)
  return service
}
