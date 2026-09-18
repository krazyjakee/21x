import {
  CONNECTOR_PIECE_ALLOWLIST,
  resolveAllowedOperation,
  type ConnectorPieceAllowlist
} from '../allowlist'
import { assertSafeUrlProps, defaultHostLookup, type HostLookup } from '../ssrf'
import {
  buildActionContext,
  buildPollingTriggerContext,
  isHostedPiece,
  UnsupportedUseRecorder,
  type PieceStoreChannel
} from './context-shim'
import { deserializePieceError, PieceNotAllowedError, serializePieceError } from './errors'
import type { HostInboundMessage, HostOutboundMessage, PieceInvocation, PieceStoreScope } from './protocol'

/**
 * The piece host's request loop, independent of Electron so tests can drive it
 * through a fake port. host-entry.ts wires it to `process.parentPort`.
 *
 * The host has no database handle and no credential store. Each invoke carries
 * the resolved auth; `context.store` calls go back to the main process, which
 * decides the instance from the call id.
 */

export interface HostPort {
  postMessage(message: HostOutboundMessage): void
  onMessage(handler: (message: HostInboundMessage) => void): void
}

export interface LoadedPieceModule {
  /** Version read from the installed package.json. */
  version: string
  module: Record<string, unknown>
}

/** Returns a piece bundled with the app, or undefined. Never installs anything. */
export type PieceModuleLoader = (pieceName: string) => LoadedPieceModule | undefined

export interface PieceHostRuntimeOptions {
  allowlist?: ConnectorPieceAllowlist
  lookup?: HostLookup
}

/** JSON round trip: piece output must be plain data to cross IPC and land in tasks. */
function toPlainData(value: unknown): unknown {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as unknown
}

export function startPieceHost(port: HostPort, loadPiece: PieceModuleLoader, options: PieceHostRuntimeOptions = {}): void {
  const allowlist = options.allowlist ?? CONNECTOR_PIECE_ALLOWLIST
  const lookup = options.lookup ?? defaultHostLookup
  const pendingStore = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let nextStoreId = 1

  function storeChannel(callId: number): PieceStoreChannel {
    const request = (op: 'get' | 'put' | 'delete', scope: PieceStoreScope, key: string, value?: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const storeId = nextStoreId++
        pendingStore.set(storeId, { resolve, reject })
        port.postMessage({ kind: 'store', storeId, callId, op, scope, key, ...(op === 'put' ? { value } : {}) })
      })
    return {
      get: (scope, key) => request('get', scope, key),
      put: async (scope, key, value) => {
        await request('put', scope, key, value)
      },
      delete: async (scope, key) => {
        await request('delete', scope, key)
      }
    }
  }

  async function invoke(callId: number, invocation: PieceInvocation): Promise<unknown> {
    const { pieceName, pieceVersion, target } = invocation
    const allowed = resolveAllowedOperation(pieceName, pieceVersion, target, allowlist)
    const pieceEntry = allowlist.pieces[pieceName]
    const loaded = loadPiece(pieceName)
    if (!loaded) throw new PieceNotAllowedError(pieceName, 'package is not bundled with this build')
    if (loaded.version !== pieceVersion) {
      throw new PieceNotAllowedError(pieceName, `bundled version ${loaded.version} does not match ${pieceVersion}`)
    }
    const piece = loaded.module[pieceEntry.exportName]
    if (!isHostedPiece(piece)) {
      throw new PieceNotAllowedError(pieceName, `export "${pieceEntry.exportName}" is not a piece`)
    }

    await assertSafeUrlProps(invocation.propsValue, allowed.urlProps, allowed, lookup)

    const recorder = new UnsupportedUseRecorder()
    const channel = storeChannel(callId)
    let output: unknown
    if (target.type === 'action') {
      const action = piece.getAction(target.name)
      if (!action) throw new PieceNotAllowedError(pieceName, `action "${target.name}" does not exist in ${pieceVersion}`)
      const ctx = buildActionContext(invocation, channel, recorder, `21x-run-${callId}`)
      try {
        output = await action.run(ctx)
      } catch (err) {
        throw recorder.first ?? err
      }
    } else {
      const trigger = piece.getTrigger(target.name)
      if (!trigger) throw new PieceNotAllowedError(pieceName, `trigger "${target.name}" does not exist in ${pieceVersion}`)
      if (trigger.type !== 'POLLING') {
        throw new PieceNotAllowedError(pieceName, `trigger "${target.name}" is ${String(trigger.type)}; only POLLING triggers run in 21x`)
      }
      const hook = trigger[target.hook]
      if (typeof hook !== 'function') {
        throw new PieceNotAllowedError(pieceName, `trigger "${target.name}" has no ${target.hook} hook`)
      }
      const ctx = buildPollingTriggerContext(invocation, channel, recorder)
      try {
        output = await hook.call(trigger, ctx)
      } catch (err) {
        throw recorder.first ?? err
      }
    }
    // The piece caught an UnsupportedPieceContext and carried on: still a failure.
    if (recorder.first) throw recorder.first
    return toPlainData(output)
  }

  port.onMessage((message) => {
    if (message.kind === 'store-result') {
      const pending = pendingStore.get(message.storeId)
      if (!pending) return
      pendingStore.delete(message.storeId)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(deserializePieceError(message.error))
      return
    }
    if (message.kind === 'invoke') {
      invoke(message.id, message.invocation).then(
        (output) => port.postMessage({ kind: 'result', id: message.id, ok: true, output }),
        (err) => port.postMessage({ kind: 'result', id: message.id, ok: false, error: serializePieceError(err) })
      )
    }
  })

  port.postMessage({ kind: 'ready' })
}
