import { spawn, type ChildProcess } from 'child_process'
import { guardChildStreams, writeToChildStdin } from '../../child-stream-guards'
import { onJsonLines } from './jsonl'

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

const RPC_TIMEOUT_MS = 30_000

/** The stdio peer state shared by every JSON-RPC-over-stdio session. */
export interface JsonRpcPeer {
  process: ChildProcess
  pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>
  nextRequestId: number
}

/**
 * Writes one newline-delimited JSON-RPC frame. A dead peer must not take the
 * application with it, so this never throws; false means the child is gone.
 */
export function writeJsonRpc(
  peer: Pick<JsonRpcPeer, 'process'>,
  payload: unknown,
  label: string,
  onError?: (err: Error) => void
): boolean {
  return writeToChildStdin(peer.process, `${JSON.stringify(payload)}\n`, label, onError)
}

/** Sends a request and resolves with its result (or rejects on error / 30s timeout). */
export function sendJsonRpcRequest(peer: JsonRpcPeer, method: string, params: unknown, label: string): Promise<unknown> {
  const id = peer.nextRequestId++
  return new Promise((resolve, reject) => {
    peer.pendingRequests.set(id, { resolve, reject })
    // A write that fails after the child exits (EPIPE) must fail the request now,
    // not after the 30s timeout.
    const failWrite = (err: Error): void => {
      if (!peer.pendingRequests.delete(id)) return
      reject(new Error(`${label}: failed to send ${method}: ${err.message}`))
    }
    if (!writeJsonRpc(peer, { jsonrpc: '2.0', id, method, params }, label, failWrite)) {
      peer.pendingRequests.delete(id)
      reject(new Error(`${label}: failed to send ${method}, process is not running`))
      return
    }
    setTimeout(() => {
      if (!peer.pendingRequests.delete(id)) return
      reject(new Error(`${label} RPC timed out: ${method}`))
    }, RPC_TIMEOUT_MS)
  })
}

/**
 * Spawns a child that speaks newline-delimited JSON-RPC on stdio and routes
 * every parsed frame to `onMessage`. Stderr and the exit are logged; callers
 * add their own `exit` listener for session state.
 */
export function spawnJsonRpcChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  label: string,
  onMessage: (message: JsonRpcMessage) => void
): ChildProcess {
  // On Windows, .cmd/.bat wrappers need shell:true to resolve.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  const child = spawn(command, args, {
    ...options,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(needsShell ? { shell: true } : {})
  })

  // Every pipe needs an error listener before the first write. The child can
  // exit at any moment, and an unhandled EPIPE on its stdin takes the whole
  // main process down with a crash dialog.
  guardChildStreams(child, label)

  onJsonLines(child.stdout, (line) => {
    try {
      onMessage(JSON.parse(line) as JsonRpcMessage)
    } catch (error) {
      console.error(`[${label}] Failed to parse JSON-RPC message:`, line, error)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    console.log(`[${label}] stderr:`, chunk.toString())
  })
  child.on('exit', (code, signal) => {
    console.log(`[${label}] Process exited: code=${code}, signal=${signal}`)
  })
  return child
}

/** Settles the request `response` answers; false when nothing was waiting on it. */
export function settleJsonRpcResponse(peer: JsonRpcPeer, response: JsonRpcResponse): boolean {
  const pending = peer.pendingRequests.get(response.id)
  if (!pending) return false
  peer.pendingRequests.delete(response.id)
  if (response.error) pending.reject(new Error(response.error.message))
  else pending.resolve(response.result)
  return true
}

/**
 * SIGTERM, then SIGKILL if the child has not exited after `graceMs`, and fails
 * every in-flight request at once instead of leaving it on its 30s timeout.
 *
 * The escalation is cancelled by the child's own `exit`, not by
 * `ChildProcess.killed`: that flag only says a signal was SENT, so it is true
 * immediately and would never escalate.
 */
export function terminateJsonRpcPeer(peer: JsonRpcPeer, reason: string, graceMs = 1000): void {
  const child = peer.process
  try {
    child.kill('SIGTERM')
  } catch {
    // Already gone.
  }
  const escalation = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Exited during the grace period, which is the outcome we wanted.
    }
  }, graceMs)
  escalation.unref()
  child.once('exit', () => clearTimeout(escalation))

  for (const pending of peer.pendingRequests.values()) {
    pending.reject(new Error(reason))
  }
  peer.pendingRequests.clear()
}
