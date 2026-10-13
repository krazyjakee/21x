import type Database from 'better-sqlite3'
import { ConnectorStore } from '../connector-store'
import { ConnectorCredentialStore } from '../credentials'
import { ConnectorOAuthService } from '../oauth'
import { kvBackendFromConnectorStore, PieceHostClient } from '../piece-host/client'
import type { BridgeRuntime } from './engine'
import type { PieceHostTransportFactory } from '../piece-host/client'

/**
 * The app's single connector runtime: one ConnectorStore, one credential
 * store (session-only credentials live in its memory, so the IPC handlers and
 * the bridge must share it), one OAuth service in front of it (the credential
 * source every piece call resolves through, so OAuth2 tokens are refreshed
 * before use) and one piece host client, bound to the app database. Created on
 * first use; the piece host process starts on the first piece call.
 */

export interface ConnectorRuntime extends BridgeRuntime {
  store: ConnectorStore
  /** Raw credential store: set / clear / storage lookups for the IPC handlers. */
  credentialStore: ConnectorCredentialStore
  /** Refresh-aware credential source (BridgeRuntime.credentials) plus connect / disconnect / status. */
  credentials: ConnectorOAuthService
  client: PieceHostClient
}

export type DbSource = { db: Database.Database }

export interface ConnectorRuntimeHost {
  openExternal: (url: string) => Promise<void> | void
  createTransport: PieceHostTransportFactory
}

const runtimes = new WeakMap<object, ConnectorRuntime>()
const closingSources = new WeakSet<object>()

export class ConnectorRuntimeClosedError extends Error {
  readonly code = 'CONNECTOR_RUNTIME_CLOSED'
  constructor() { super('Connector runtime is shutting down'); this.name = 'ConnectorRuntimeClosedError' }
}

export function getConnectorRuntime(source: DbSource, host: ConnectorRuntimeHost): ConnectorRuntime {
  if (closingSources.has(source)) throw new ConnectorRuntimeClosedError()
  const existing = runtimes.get(source)
  if (existing) return existing
  const store = new ConnectorStore(source)
  const credentialStore = new ConnectorCredentialStore(store)
  const credentials = new ConnectorOAuthService({
    store,
    credentials: credentialStore,
    openExternal: host.openExternal
  })
  const client = new PieceHostClient({
    createTransport: host.createTransport,
    kv: kvBackendFromConnectorStore(store),
    credentials
  })
  const runtime: ConnectorRuntime = { store, credentialStore, credentials, client }
  runtimes.set(source, runtime)
  return runtime
}

/** Cancel public work, retaining its raw ownership until a close join or process exit. */
export function disposeConnectorRuntime(source: DbSource): void {
  closingSources.add(source)
  const runtime = runtimes.get(source)
  if (!runtime) return
  runtime.client.dispose()
  runtime.credentials.stop()
}

/** Join both runtime owners; an incomplete close retains the original runtime. */
export async function closeConnectorRuntime(source: DbSource, timeoutMs = 2000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
    throw new RangeError('Connector runtime shutdown deadline must be an integer from 1 to 3000 ms')
  }
  disposeConnectorRuntime(source)
  const runtime = runtimes.get(source)
  if (!runtime) return
  const results = await Promise.allSettled([runtime.credentials.close(timeoutMs), runtime.client.close(timeoutMs)])
  const incomplete = results.find(result => result.status === 'rejected')
  if (incomplete?.status === 'rejected') throw incomplete.reason
  runtimes.delete(source)
}
