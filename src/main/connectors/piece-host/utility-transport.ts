import { app, utilityProcess } from 'electron'
import { join } from 'path'
import type { PieceHostTransport } from './client'
import type { HostOutboundMessage } from './protocol'
import { pieceWorkerEnvironment } from './worker-environment'

/**
 * Starts the piece host (out/main/piece-host.js, built from host-entry.ts) in
 * an Electron utilityProcess. The child gets a minimal environment: no app
 * secrets or agent API keys, only what an HTTP client needs.
 */

export function pieceHostEntryPath(): string {
  return join(app.getAppPath(), 'out', 'main', 'piece-host.js')
}

export function createUtilityProcessTransport(entryPath: string = pieceHostEntryPath()): PieceHostTransport {
  const env = pieceWorkerEnvironment()
  const child = utilityProcess.fork(entryPath, [], {
    serviceName: 'Connector piece host',
    stdio: 'pipe',
    env
  })
  child.stdout?.on('data', (data: Buffer) => console.log('[piece-host]', data.toString().trim()))
  child.stderr?.on('data', (data: Buffer) => console.error('[piece-host]', data.toString().trim()))

  const exitHandlers: ((code: number | null) => void)[] = []
  let exited = false
  child.on('exit', (code) => {
    if (exited) return
    exited = true
    for (const handler of exitHandlers) handler(code)
  })

  return {
    postMessage: (message) => {
      if (!exited) child.postMessage(message)
    },
    onMessage: (handler) => {
      child.on('message', (message: unknown) => handler(message as HostOutboundMessage))
    },
    onExit: (handler) => {
      exitHandlers.push(handler)
    },
    kill: () => {
      if (!exited) child.kill()
    }
  }
}
