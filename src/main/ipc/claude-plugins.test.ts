import { beforeEach, expect, it, vi } from 'vitest'
import type { IpcDeps } from './deps'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } }))
import { registerClaudePluginHandlers } from './claude-plugins'
import { AgentDeletionRefused } from '../../shared/agent-deletion'

const plugins = { getPluginResources: vi.fn(), uninstallPlugin: vi.fn() }
const agentManager = { runAgentsDeletion: vi.fn(), notifyAgentsChanged: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks(); handlers.clear()
  registerClaudePluginHandlers({ claudePluginManager: plugins, agentManager } as unknown as IpcDeps)
})

it('uninstalls inside the owner that stops the plugin\'s agents first, then publishes the change', async () => {
  plugins.getPluginResources.mockReturnValue({ agents: [{ id: 'one' }, { id: 'two' }] })
  const reports = [{ agent_id: 'one' }, { agent_id: 'two' }], live = new Map([['one', { running: ['task'], queued: [] }]])
  plugins.uninstallPlugin.mockResolvedValue(reports)
  agentManager.runAgentsDeletion.mockImplementation(async (_ids, remove) => remove(live))
  expect(await handlers.get('claudePlugin:uninstallPlugin')!({}, 'plugin')).toBe(reports)
  expect(agentManager.runAgentsDeletion).toHaveBeenCalledExactlyOnceWith(['one', 'two'], expect.any(Function))
  expect(plugins.uninstallPlugin).toHaveBeenCalledExactlyOnceWith('plugin', live)
  expect(agentManager.notifyAgentsChanged).toHaveBeenCalledOnce()
})

it('answers a named refusal as a result, so both hosts show the same words', async () => {
  plugins.getPluginResources.mockReturnValue({ agents: [{ id: 'one' }] })
  agentManager.runAgentsDeletion.mockRejectedValue(new AgentDeletionRefused('Not deleted.', 2, 0))
  expect(await handlers.get('claudePlugin:uninstallPlugin')!({}, 'plugin')).toEqual({ refused: 'Not deleted. Already done: 2 sessions stopped.' })
  expect(plugins.uninstallPlugin).not.toHaveBeenCalled()
})

it('does not touch the plugin or publish anything when the owner fails', async () => {
  plugins.getPluginResources.mockReturnValue({ agents: [{ id: 'one' }] })
  agentManager.runAgentsDeletion.mockRejectedValue(new Error('“Build” did not confirm it stopped'))
  await expect(handlers.get('claudePlugin:uninstallPlugin')!({}, 'plugin')).rejects.toThrow('did not confirm it stopped')
  expect(plugins.uninstallPlugin).not.toHaveBeenCalled()
  expect(agentManager.notifyAgentsChanged).not.toHaveBeenCalled()
})
