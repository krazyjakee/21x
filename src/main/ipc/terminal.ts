import { guardedIpcSend } from '../guarded-ipc-send'
import { ipcMain } from 'electron'
import { assertTrustedSender } from '../ipc-sender'
import { TerminalServiceCore } from '../terminal-service-core'
import { createNodePty, createPythonPty, resolveShell, terminalProcessCwd } from '../terminal-process'

const owners = new Set<TerminalServiceCore>()
let closing = false

export function shutdownTerminalServices(): void {
  closing = true
  for (const owner of owners) owner.shutdown()
}

export async function closeTerminalServices(): Promise<void> {
  shutdownTerminalServices()
  await Promise.all([...owners].map(async owner => {
    await owner.close()
    owners.delete(owner)
  }))
}

export function registerTerminalHandlers(): void {
  if (closing) throw new Error('TERMINAL_SERVICE_CLOSED')
  const terminals = new TerminalServiceCore({
    resolveShell,
    create: process.platform === 'win32' ? createNodePty : createPythonPty,
    getCwd: terminalProcessCwd
  })
  owners.add(terminals)

  ipcMain.handle('terminal:create', async (event, input: { id: string; cols: number; rows: number; cwd?: string }) => {
    assertTrustedSender(event, 'terminal:create')
    const sender = event.sender
    return terminals.create(input, {
      data: (id, data) => { if (!sender.isDestroyed()) guardedIpcSend(sender, 'terminal:data', { id, data }) },
      exit: id => { if (!sender.isDestroyed()) guardedIpcSend(sender, 'terminal:exit', { id }) }
    })
  })
  ipcMain.handle('terminal:write', (event, { id, data }: { id: string; data: string }) => {
    assertTrustedSender(event, 'terminal:write')
    return terminals.write(id, data)
  })
  ipcMain.handle('terminal:resize', (event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    assertTrustedSender(event, 'terminal:resize')
    return terminals.resize(id, cols, rows)
  })
  ipcMain.handle('terminal:getBuffer', (event, { id, lines }: { id: string; lines?: number }) => {
    assertTrustedSender(event, 'terminal:getBuffer')
    return terminals.getBuffer(id, lines)
  })
  ipcMain.handle('terminal:kill', (event, { id, expectedPid }: { id: string; expectedPid?: number }) => {
    assertTrustedSender(event, 'terminal:kill')
    return terminals.kill(id, expectedPid)
  })
  ipcMain.handle('terminal:getCwd', (event, { id, expectedPid }: { id: string; expectedPid?: number }) => {
    assertTrustedSender(event, 'terminal:getCwd')
    return terminals.getCwd(id, expectedPid)
  })
}
