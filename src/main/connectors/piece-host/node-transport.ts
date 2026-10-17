import { fork, type ForkOptions, type SpawnOptions } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { nodeWorkerRuntime } from '../../node-worker-runtime'
import type { PieceHostTransport } from './client'
import type { HostOutboundMessage } from './protocol'
import { pieceWorkerEnvironment } from './worker-environment'

/** The service owner supplies a trusted absolute worker entry, never renderer input. */
export function createNodeProcessTransport(entryPath: string): PieceHostTransport {
  if (process.versions.electron) throw new Error('Connector Node transport requires a standalone service')
  if (!isAbsolute(entryPath) || !lstatSync(entryPath).isFile() || lstatSync(entryPath).isSymbolicLink()) {
    throw new Error('Connector worker entry must be an absolute regular file')
  }
  const runtime = nodeWorkerRuntime(process.platform, process.execPath, pieceWorkerEnvironment())
  // Pinned Node's fork forwards these options to spawn; ForkOptions omits
  // the supported Windows console flag from its narrower declaration.
  const options: ForkOptions & Pick<SpawnOptions, 'windowsHide'> = {
    execPath: runtime.execPath, execArgv: [], env: runtime.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true
  }
  const child = fork(realpathSync(entryPath), [], options)
  // Piece output can contain credentials. Drain it without forwarding raw text.
  child.stdout?.resume()
  child.stderr?.resume()
  const handlers: ((code: number | null) => void)[] = []
  let closed = false
  let exitCode: number | null = null
  let terminating = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  const terminate = (): void => {
    if (closed || terminating) return
    terminating = true
    // A piece may install a SIGTERM handler. A request to kill is not an exit
    // receipt; bound the grace period and keep owning the child until close.
    child.kill('SIGTERM')
    escalation = setTimeout(() => { if (!closed) child.kill('SIGKILL') }, 250)
    escalation.unref()
  }
  child.on('error', terminate)
  child.once('close', code => {
    closed = true
    if (escalation) clearTimeout(escalation)
    exitCode = code
    for (const handler of handlers) handler(code)
    handlers.length = 0
  })
  return {
    postMessage: message => {
      if (!closed && child.connected) child.send(message, error => { if (error) terminate() })
    },
    onMessage: handler => { child.on('message', message => handler(message as HostOutboundMessage)) },
    onExit: handler => {
      if (closed) queueMicrotask(() => handler(exitCode))
      else handlers.push(handler)
    },
    kill: terminate
  }
}
