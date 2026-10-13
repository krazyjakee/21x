import { describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { IpcDeps } from './deps'
import { registerMcpHandlers } from './mcp'
import { testMcpServer, areMcpProbesClosed } from '../agent-manager/mcp-server-test'

vi.mock('../agent-manager/mcp-server-test', () => ({ testMcpServer: vi.fn(), areMcpProbesClosed: vi.fn(() => false) }))

describe('application MCP probe result ownership', () => {
  it('stores tools while open and fences a success queued before final shutdown', async () => {
    const db = { updateMcpServerTools: vi.fn() }
    registerMcpHandlers({ db } as unknown as IpcDeps)
    const invoke = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'mcp:testConnection')![1]
    const tools = [{ name: 'fixture', description: 'fixture only' }]
    vi.mocked(testMcpServer).mockResolvedValue({ status: 'connected', tools, toolCount: 1 })
    await invoke({} as never, { id: 'fixture-server', name: 'fixture' })
    expect(db.updateMcpServerTools).toHaveBeenCalledExactlyOnceWith('fixture-server', tools)
    const accepted = invoke({} as never, { id: 'fixture-server', name: 'fixture' })
    vi.mocked(areMcpProbesClosed).mockReturnValue(true)
    await accepted
    expect(db.updateMcpServerTools).toHaveBeenCalledTimes(1)
  })
})
