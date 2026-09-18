import type { ChildProcess } from 'child_process'
import { writeToChildStdin } from '../../child-stream-guards'

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
