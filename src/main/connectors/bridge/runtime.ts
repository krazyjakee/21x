import type Database from 'better-sqlite3'
import { ConnectorStore } from '../connector-store'
import { ConnectorCredentialStore } from '../credentials'
import { kvBackendFromConnectorStore, PieceHostClient } from '../piece-host/client'
import { createUtilityProcessTransport } from '../piece-host/utility-transport'
import type { BridgeRuntime } from './engine'

/**
 * The app's single connector runtime: one ConnectorStore, one credential
 * store (session-only credentials live in its memory, so the IPC handlers and
 * the bridge must share it) and one piece host client, bound to the app
 * database. Created on first use; the piece host process starts on the first
 * piece call.
 */

export interface ConnectorRuntime extends BridgeRuntime {
  store: ConnectorStore
  credentials: ConnectorCredentialStore
  client: PieceHostClient
}

type DbSource = { db: Database.Database }

const runtimes = new WeakMap<object, ConnectorRuntime>()

export function getConnectorRuntime(source: DbSource): ConnectorRuntime {
  const existing = runtimes.get(source)
  if (existing) return existing
  const store = new ConnectorStore(source)
  const credentials = new ConnectorCredentialStore(store)
  const client = new PieceHostClient({
    createTransport: () => createUtilityProcessTransport(),
    kv: kvBackendFromConnectorStore(store),
    credentials
  })
  const runtime: ConnectorRuntime = { store, credentials, client }
  runtimes.set(source, runtime)
  return runtime
}

/** Kills the piece host of the runtime bound to `source`, if one was created. */
export function disposeConnectorRuntime(source: DbSource): void {
  const runtime = runtimes.get(source)
  if (!runtime) return
  runtime.client.dispose()
  runtimes.delete(source)
}
