import { beforeEach, expect, it, vi } from 'vitest'
import type { IpcDeps } from './deps'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } }))
import { registerClaudePluginHandlers } from './claude-plugins'

const plugins = { getPluginResources: vi.fn(), uninstallPlugin: vi.fn() }
const agentManager = { runAgentsDeletion: vi.fn(), notifyAgentsChanged: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks(); handlers.clear()
  registerClaudePluginHandlers({ claudePluginManager: plugins, agentManager } as unknown as IpcDeps)
})

it('uninstalls inside the owner that stops the plugin\'s agents first, then publishes the change', async () => {
  plugins.getPluginResources.mockReturnValue({ agents: [{ id: 'one' }, { id: 'two' }] })
  plugins.uninstallPlugin.mockResolvedValue(true)
  agentManager.runAgentsDeletion.mockImplementation(async (_ids, remove) => remove())
  expect(await handlers.get('claudePlugin:uninstallPlugin')!({}, 'plugin')).toBe(true)
  expect(agentManager.runAgentsDeletion).toHaveBeenCalledExactlyOnceWith(['one', 'two'], expect.any(Function))
  expect(plugins.uninstallPlugin).toHaveBeenCalledExactlyOnceWith('plugin')
  expect(agentManager.notifyAgentsChanged).toHaveBeenCalledOnce()
})

it('does not touch the plugin or publish anything when the owner refuses', async () => {
  plugins.getPluginResources.mockReturnValue({ agents: [{ id: 'one' }] })
  agentManager.runAgentsDeletion.mockRejectedValue(new Error('“Build” did not confirm it stopped'))
  await expect(handlers.get('claudePlugin:uninstallPlugin')!({}, 'plugin')).rejects.toThrow('did not confirm it stopped')
  expect(plugins.uninstallPlugin).not.toHaveBeenCalled()
  expect(agentManager.notifyAgentsChanged).not.toHaveBeenCalled()
})
