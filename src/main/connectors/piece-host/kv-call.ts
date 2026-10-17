import {
  CONNECTOR_KV_MAX_INSTANCE_BYTES, CONNECTOR_KV_MAX_KEY_CHARS, CONNECTOR_KV_MAX_VALUE_BYTES,
  ConnectorKvLimitError, type ConnectorKvMutation
} from '../connector-store'
import type { PieceStoreScope } from './protocol'

/** A call sees its own edits; durable storage changes only with a successful result. */
export interface PieceKvCall {
  get(scope: PieceStoreScope, key: string): unknown
  put(scope: PieceStoreScope, key: string, value: unknown): void
  delete(scope: PieceStoreScope, key: string): void
  commit(): void
  discard(): void
}

export function createPieceKvCall(
  read: (scope: PieceStoreScope, key: string) => unknown,
  apply: (mutations: readonly ConnectorKvMutation[]) => void
): PieceKvCall {
  const pending = new Map<string, { mutation: ConnectorKvMutation; bytes: number }>()
  let bytes = 0
  let open = true
  const id = (scope: PieceStoreScope, key: string): string => JSON.stringify([scope, key])
  const assertOpen = (): void => { if (!open) throw new Error('Connector KV call is closed') }
  const stage = (mutation: ConnectorKvMutation): void => {
    assertOpen()
    if (mutation.key.length > CONNECTOR_KV_MAX_KEY_CHARS) throw new ConnectorKvLimitError('key', mutation.key.length, CONNECTOR_KV_MAX_KEY_CHARS)
    const encoded = mutation.op === 'put' ? JSON.stringify(mutation.value ?? null) : 'null'
    if (typeof encoded !== 'string') throw new TypeError('Connector KV values must be JSON data')
    const valueBytes = Buffer.byteLength(encoded)
    if (valueBytes > CONNECTOR_KV_MAX_VALUE_BYTES) throw new ConnectorKvLimitError('value', valueBytes, CONNECTOR_KV_MAX_VALUE_BYTES)
    const key = id(mutation.scope, mutation.key), size = Buffer.byteLength(key) + valueBytes
    const total = bytes - (pending.get(key)?.bytes ?? 0) + size
    // Bound both payload and object overhead, including delete-only calls.
    if (total > CONNECTOR_KV_MAX_INSTANCE_BYTES) throw new ConnectorKvLimitError('instance', total, CONNECTOR_KV_MAX_INSTANCE_BYTES)
    if (!pending.has(key) && pending.size >= 4096) throw new Error('Connector call key limit is 4096')
    const snapshot: ConnectorKvMutation = mutation.op === 'put' ? { ...mutation, value: JSON.parse(encoded) } : { ...mutation }
    pending.set(key, { mutation: snapshot, bytes: size }); bytes = total
  }
  const discard = (): void => { open = false; pending.clear(); bytes = 0 }
  return {
    get: (scope, key) => {
      assertOpen()
      const entry = pending.get(id(scope, key))
      return entry ? entry.mutation.op === 'put' ? structuredClone(entry.mutation.value) : null : read(scope, key)
    },
    put: (scope, key, value) => stage({ op: 'put', scope, key, value }),
    delete: (scope, key) => stage({ op: 'delete', scope, key }),
    commit: () => {
      assertOpen()
      try { apply([...pending.values()].map(entry => entry.mutation)) }
      finally { discard() }
    },
    discard
  }
}
