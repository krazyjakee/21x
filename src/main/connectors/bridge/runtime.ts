import type Database from 'better-sqlite3'
import { shell } from 'electron'
import { ConnectorStore } from '../connector-store'
import { ConnectorCredentialStore } from '../credentials'
import { ConnectorOAuthService } from '../oauth'
import { kvBackendFromConnectorStore, PieceHostClient } from '../piece-host/client'
import { createUtilityProcessTransport } from '../piece-host/utility-transport'
import type { BridgeRuntime } from './engine'

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

type DbSource = { db: Database.Database }

const runtimes = new WeakMap<object, ConnectorRuntime>()

export function getConnectorRuntime(source: DbSource): ConnectorRuntime {
  const existing = runtimes.get(source)
  if (existing) return existing
  const store = new ConnectorStore(source)
  const credentialStore = new ConnectorCredentialStore(store)
  const credentials = new ConnectorOAuthService({
    store,
    credentials: credentialStore,
    openExternal: (url) => shell.openExternal(url)
  })
  const client = new PieceHostClient({
    createTransport: () => createUtilityProcessTransport(),
    kv: kvBackendFromConnectorStore(store),
    credentials
  })
  const runtime: ConnectorRuntime = { store, credentialStore, credentials, client }
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
