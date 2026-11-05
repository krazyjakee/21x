import { agentApi, claudePluginApi } from '@/lib/ipc-client'
import { usePluginMarketplaceStore } from '@/stores/plugin-marketplace-store'
import { DeletionDialog } from './DeletionDialog'
import type { AgentDeletionImpact } from '@shared/agent-deletion'

/**
 * Unlike deleting one agent, this never promises other agents are safe: a plugin
 * also takes skills and MCP servers with it, and on Tauri that refresh can stop
 * other agents sharing the backend.
 */
export function PluginUninstallDialog({ plugin, onClose }: { plugin: { id: string; name: string }; onClose: () => void }) {
  const uninstallPlugin = usePluginMarketplaceStore((state) => state.uninstallPlugin)
  return (
    <DeletionDialog
      subjectId={plugin.id}
      title={`Remove “${plugin.name}”?`}
      doneTitle={`“${plugin.name}” was removed`}
      idleText="None of this plugin’s agents are running anything."
      runningText="This plugin’s agents stop before it is removed."
      actionLabel="Remove plugin"
      stopLabel="Stop and remove"
      readImpacts={async () => {
        const { agents } = await claudePluginApi.getPluginResources(plugin.id)
        const impacts = await Promise.all(agents.map((agent) => agentApi.deletionImpact(agent.id)))
        return impacts.filter((impact): impact is AgentDeletionImpact => !!impact)
      }}
      remove={() => uninstallPlugin(plugin.id)}
      onClose={onClose}
    />
  )
}
