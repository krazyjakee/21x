import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import type { WorktreeManager } from './worktree-manager'
import { WorkspaceCleanupScheduler } from './workspace-cleanup-scheduler'

describe('workspace cleanup native host adapter', () => {
  const source = createPortableDbFixture()
  const owner = new WorkspaceCleanupScheduler(source.db, {} as WorktreeManager)
  afterEach(async () => { await owner.close(); source.rawDb.close() })

  it('rebinds the two guarded events and suppresses destroyed windows and closed owners', () => {
    const first = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const current = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } }
    owner.start(first as unknown as BrowserWindow)
    owner.start(current as unknown as BrowserWindow)
    const dispatch = owner as unknown as { sendToRenderer(channel: string, data: unknown): void }
    dispatch.sendToRenderer('workspace:cleanup-progress', { phase: 'starting' })
    dispatch.sendToRenderer('workspace:cleanup-complete', { cleaned: 1, errors: [] })
    expect(first.webContents.send).not.toHaveBeenCalled()
    expect(current.webContents.send).toHaveBeenCalledWith('workspace:cleanup-progress', { phase: 'starting' })
    expect(current.webContents.send).toHaveBeenCalledWith('workspace:cleanup-complete', { cleaned: 1, errors: [] })
    current.webContents.send.mockClear()
    current.isDestroyed.mockReturnValue(true)
    dispatch.sendToRenderer('workspace:cleanup-progress', {})
    expect(current.webContents.send).not.toHaveBeenCalled()
    current.isDestroyed.mockReturnValue(false)
    owner.shutdown()
    dispatch.sendToRenderer('workspace:cleanup-complete', {})
    expect(current.webContents.send).not.toHaveBeenCalled()
  })
})
