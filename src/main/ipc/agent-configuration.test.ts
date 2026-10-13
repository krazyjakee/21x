import { beforeEach, expect, it, vi } from 'vitest'
import type { IpcDeps } from './deps'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } }))
import { registerAgentHandlers } from './agents'

const db = { createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn() }
const manager = { runAgentConfigurationMutation: vi.fn(), drainStartQueue: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks(); handlers.clear()
  registerAgentHandlers({ db, agentManager: manager } as unknown as IpcDeps)
})

it('keeps Electron runtime edits behind the same acknowledged lifecycle fence as portable configuration', async () => {
  let finish!: () => void
  const stopped = new Promise<void>(resolve => { finish = resolve })
  manager.runAgentConfigurationMutation.mockImplementation(async (_id, _kind, write) => { await stopped; return write() })
  const changes = { config: { coding_agent: 'pi' } }
  const updated = { id: 'agent', ...changes }; db.updateAgent.mockReturnValue(updated)
  const result = handlers.get('agent:update')!({}, 'agent', changes)
  expect(manager.runAgentConfigurationMutation).toHaveBeenCalledWith('agent', 'update', expect.any(Function), changes)
  expect(db.updateAgent).not.toHaveBeenCalled()
  finish()
  expect(await result).toBe(updated)
  expect(db.updateAgent).toHaveBeenCalledExactlyOnceWith('agent', changes)
})

it('does not delete saved configuration when its owned session cannot acknowledge Stop', async () => {
  manager.runAgentConfigurationMutation.mockRejectedValue(new Error('Stop not acknowledged'))
  await expect(handlers.get('agent:delete')!({}, 'agent')).rejects.toThrow('Stop not acknowledged')
  expect(manager.runAgentConfigurationMutation).toHaveBeenCalledWith('agent', 'delete', expect.any(Function))
  expect(db.deleteAgent).not.toHaveBeenCalled()
})

it('reconciles starts after a new agent is saved', () => {
  db.createAgent.mockReturnValue({ id: 'agent' })
  expect(handlers.get('agent:create')!({}, { name: 'Agent' })).toEqual({ id: 'agent' })
  expect(manager.drainStartQueue).toHaveBeenCalledOnce()
  expect(db.createAgent.mock.invocationCallOrder[0]).toBeLessThan(manager.drainStartQueue.mock.invocationCallOrder[0])
})
