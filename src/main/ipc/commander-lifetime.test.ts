import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ipcMain } from 'electron'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { closeCommanderServices, getCommanderService, registerCommanderHandlers, shutdownCommanderServices } from './commander'
import { recoverIssueWriteOutcomes } from '../captain-github-tools'
import type { IpcDeps } from './deps'

vi.mock('../ipc-sender', () => ({ assertTrustedSender: vi.fn() }))
vi.mock('../captain-github-tools', async importOriginal => ({
  ...await importOriginal<typeof import('../captain-github-tools')>(), recoverIssueWriteOutcomes: vi.fn()
}))

describe('application Commander owner', () => {
  it('retains startup recovery and its late SQLite write, unbinds the window and refuses source revival', async () => {
    const source = createPortableDbFixture()
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    vi.mocked(recoverIssueWriteOutcomes).mockImplementation(async () => {
      await gate
      source.db.setSetting('fixture_commander_recovery', 'settled')
    })
    const deps = { db: source.db, agentManager: { sendMessage: vi.fn() } } as unknown as IpcDeps
    const commander = registerCommanderHandlers(deps, { getTools: () => [] })
    const list = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'commander:listSessions')![1]
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
    try {
      await list({ sender } as never)
      expect(sender.listenerCount('destroyed')).toBe(1)
      await vi.waitFor(() => expect(recoverIssueWriteOutcomes).toHaveBeenCalledOnce())
      expect(getCommanderService()).toBe(commander)
      shutdownCommanderServices()
      expect(getCommanderService()).toBeNull()
      expect(sender.listenerCount('destroyed')).toBe(0)
      await expect(closeCommanderServices(5)).rejects.toThrow('COMMANDER_HOST_SHUTDOWN_INCOMPLETE')
      const sql = vi.spyOn(source.rawDb, 'prepare')
      expect(() => list({ sender } as never)).toThrow('COMMANDER_SERVICE_CLOSED')
      expect(sql).not.toHaveBeenCalled()
      sql.mockRestore()
      const retry = closeCommanderServices()
      finish()
      await retry
      expect(source.db.getSetting('fixture_commander_recovery')).toBe('settled')
      expect(() => registerCommanderHandlers(deps)).toThrow('COMMANDER_SERVICE_CLOSED')
    } finally { finish(); await closeCommanderServices(); source.rawDb.close(); vi.restoreAllMocks() }
  })
})
