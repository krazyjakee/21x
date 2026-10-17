import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createNodeProcessTransport } from './node-transport'
import { pieceWorkerEnvironment } from './worker-environment'
import { PieceHostClient } from './client'
import { kvBackendFromConnectorStore } from './client'
import Database from 'better-sqlite3'
import { applySchema } from '../../database/schema'
import { ConnectorStore, CONNECTOR_KV_MAX_VALUE_BYTES } from '../connector-store'
import { ConnectorCredentialStore } from '../credentials'
import { PieceCancelledError, PieceExecutionError, PieceHostCrashedError, PieceTimeoutError } from './errors'
import { tmpdir } from 'node:os'
import { DatabaseManager } from '../../database/manager'
import { ConnectorBridgeEngine } from '../bridge/engine'
import { CONNECTOR_TASK_MAPPINGS } from '../bridge/mappings'

const root = resolve(__dirname, '../../../..')

describe('standalone connector worker transport', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('shares the minimal HTTP environment without inheriting credentials, preloads or Electron mode', () => {
    const source = { PATH: '/fixture', HOME: '/fixture-home', HTTP_PROXY: 'http://fixture-proxy',
      OPENAI_API_KEY: 'fixture-key', NODE_OPTIONS: '--require=fixture', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1' }
    expect(pieceWorkerEnvironment(source)).toEqual({ PATH: '/fixture', HOME: '/fixture-home', HTTP_PROXY: 'http://fixture-proxy' })
    expect(source.OPENAI_API_KEY).toBe('fixture-key')
  })

  it.skipIf(Boolean(process.versions.electron))('rejects a PATH-based entry before launching a worker', () => {
    expect(() => createNodeProcessTransport('piece-host.cjs')).toThrow('absolute regular file')
  })

  it.skipIf(Boolean(process.versions.electron))('uses owning Node, preserves structured data and joins actual close with system Node hidden', async () => {
    vi.stubEnv('PATH', '')
    vi.stubEnv('NODE_OPTIONS', '--require=/fixture-missing-preload')
    vi.stubEnv('OPENAI_API_KEY', 'fixture-secret')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('electron_run_as_node', '1')
    const transport = createNodeProcessTransport(join(root, 'test/fixtures/piece-node-worker.cjs'))
    const exits = vi.fn()
    transport.onExit(exits)
    const client = new PieceHostClient({ createTransport: () => transport,
      credentials: { get: () => null }, kv: { get: () => null, put: () => {}, delete: () => {} } })
    try {
      const bytes = Buffer.from([0, 1, 255])
      expect(await client.runAction({ instanceId: 'fixture', pieceName: '@activepieces/piece-trello',
        pieceVersion: '0.6.0', actionName: 'get_board', propsValue: { bytes }, timeoutMs: 2000 }))
        .toEqual({ executable: process.execPath, version: process.version, electron: false,
          systemNodeHidden: true, preloadsAbsent: true, secretsAbsent: true, electronModeAbsent: true, bytes })
      await client.close()
      expect(exits).toHaveBeenCalledOnce()
      const lateExit = vi.fn()
      transport.onExit(lateExit)
      await Promise.resolve()
      expect(lateExit).toHaveBeenCalledOnce()
    } finally { await client.close() }
  })

  it.skipIf(Boolean(process.versions.electron))('runs the real compiled host and pinned Trello disable hook over Node IPC', async () => {
    // Test output stays below ignored node_modules so plain require() resolves
    // the existing pinned pieces. This is not packaged-resource staging proof.
    const cache = join(root, 'node_modules/.cache')
    mkdirSync(cache, { recursive: true })
    const directory = mkdtempSync(join(cache, '21x-node-piece-'))
    let client: PieceHostClient | undefined
    try {
      const { build } = await import('vite')
      await build({ configFile: false, root, logLevel: 'silent',
        build: { ssr: join(root, 'src/main/connectors/piece-host/host-entry.ts'), target: 'node22',
          outDir: directory, emptyOutDir: false, minify: false,
          rollupOptions: { output: { format: 'cjs', entryFileNames: 'piece-host.cjs', inlineDynamicImports: true } } },
        ssr: { noExternal: true } })
      vi.stubEnv('PATH', '')
      client = new PieceHostClient({ createTransport: () => createNodeProcessTransport(join(directory, 'piece-host.cjs')),
        credentials: { get: () => ({ type: 'custom_auth', props: { api_key: 'fixture', token: 'fixture' } }) },
        kv: { get: () => null, put: () => {}, delete: () => {} } })
      await expect(client.runTrigger({ instanceId: 'fixture', pieceName: '@activepieces/piece-trello',
        pieceVersion: '0.6.0', triggerName: 'deadline', hook: 'onDisable', timeoutMs: 2000 })).resolves.toBeNull()
      expect(client.starts).toBe(1)
      await client.close()
    } finally {
      await client?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)
})

describe.skipIf(Boolean(process.versions.electron))('real Node connector failure and checkpoint ownership', () => {
  let compiled: string
  let directory: string
  let database: InstanceType<typeof Database>
  let store: ConnectorStore
  let credentials: ConnectorCredentialStore
  let client: PieceHostClient
  let instance: string
  let foreign: string
  let exits: number
  let checkpoint: Promise<void>
  let reachedCheckpoint: () => void
  const secret = 'synthetic-connector-checkpoint-canary'
  const base = { pieceName: '@activepieces/piece-trello', pieceVersion: '0.6.0', triggerName: 'deadline', hook: 'run' as const }
  const call = (mode = 'success', cursor = 2, signal?: AbortSignal) => client.runTrigger({ ...base, instanceId: instance,
    propsValue: { mode, cursor }, signal, timeoutMs: mode === 'hang' && !signal ? 500 : 2500 })
  const makeClient = () => new PieceHostClient({ createTransport: () => {
    const transport = createNodeProcessTransport(join(compiled, 'worker.cjs'))
    transport.onExit(() => { exits++ })
    transport.onMessage(message => { if ('fixtureCheckpoint' in message) reachedCheckpoint() })
    return transport
  }, credentials, kv: kvBackendFromConnectorStore(store) })
  const manager = () => {
    const source = new DatabaseManager({ paths: { profileRoot: directory, workspaceRoot: directory, attachmentRoot: directory }, managedTaskMcp: { disabled: true } })
    source.db = database
    return source
  }
  const engine = () => new ConnectorBridgeEngine({ runtime: { store, client, credentials }, log: () => {}, mappings: {
    [base.pieceName]: { ...CONNECTOR_TASK_MAPPINGS[base.pieceName], import: {
      target: { type: 'trigger', name: base.triggerName }, itemsPath: 'cards', props: { items: { value: true }, cursor: { value: 2 } }
    } }
  } })

  beforeAll(async () => {
    const cache = join(root, 'node_modules/.cache'); mkdirSync(cache, { recursive: true })
    compiled = mkdtempSync(join(cache, '21x-piece-lifecycle-'))
    const { build } = await import('vite')
    await build({ configFile: false, root, logLevel: 'silent', build: {
      ssr: join(root, 'test/fixtures/piece-lifecycle-worker.ts'), target: 'node22', outDir: compiled, emptyOutDir: false,
      minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'worker.cjs', inlineDynamicImports: true } }
    }, ssr: { noExternal: true } })
  }, 15000)
  afterAll(() => rmSync(compiled, { recursive: true, force: true }))

  beforeEach(() => {
    vi.stubEnv('PATH', '')
    directory = mkdtempSync(join(tmpdir(), '21x-piece-checkpoint-'))
    database = new Database(join(directory, 'fixture.db')); applySchema(database)
    store = new ConnectorStore({ db: database }); credentials = new ConnectorCredentialStore(store)
    instance = store.createInstance({ pieceName: base.pieceName, pieceVersion: base.pieceVersion }).id
    foreign = store.createInstance({ pieceName: base.pieceName, pieceVersion: base.pieceVersion }).id
    store.kvPut(instance, 'flow', 'cursor', 1); store.kvPut(instance, 'flow', 'deleted', 'keep-until-success')
    store.kvPut(foreign, 'flow', 'cursor', 900)
    credentials.set(instance, { type: 'secret_text', secret }, 'persistent')
    exits = 0
    checkpoint = new Promise(resolve => { reachedCheckpoint = resolve })
    client = makeClient()
  })
  afterEach(async () => {
    try { await client.close(); credentials.close() }
    finally { database.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() }
  })

  it('commits call-local reads, writes and deletes only to its instance and reopens encrypted credentials', async () => {
    const ciphertext = store.getAuthBlob(instance)!.auth!
    expect(ciphertext.includes(Buffer.from(secret))).toBe(false)
    expect(await call()).toEqual({ before: 1, staged: 2, hadCredential: true })
    expect(store.kvGet(instance, 'flow', 'cursor')).toBe(2)
    expect(store.kvGet(instance, 'project', 'project-marker')).toBe('call-owned')
    expect(store.kvGet(instance, 'flow', 'deleted')).toBeNull()
    expect(store.kvGet(foreign, 'flow', 'cursor')).toBe(900)
    await client.close(); credentials.close(); database.close()
    database = new Database(join(directory, 'fixture.db'))
    store = new ConnectorStore({ db: database }); credentials = new ConnectorCredentialStore(store)
    expect(store.kvGet(instance, 'flow', 'cursor')).toBe(2)
    expect(credentials.get(instance)).toEqual({ type: 'secret_text', secret })
    expect(store.getAuthBlob(instance)!.auth).toEqual(ciphertext)
  })

  it.each(['error', 'crash', 'timeout', 'cancel'] as const)('keeps the durable checkpoint after %s and admits a fresh worker call', async failure => {
    const controller = failure === 'cancel' ? new AbortController() : undefined
    const result = call(failure === 'timeout' || failure === 'cancel' ? 'hang' : failure, 99, controller?.signal).catch(error => error)
    if (controller) { await checkpoint; controller.abort() }
    const error = await result
    expect(error).toBeInstanceOf({ error: PieceExecutionError, crash: PieceHostCrashedError,
      timeout: PieceTimeoutError, cancel: PieceCancelledError }[failure])
    expect(String(error)).not.toContain(secret)
    expect(store.kvGet(instance, 'flow', 'cursor')).toBe(1)
    expect(store.kvGet(instance, 'flow', 'deleted')).toBe('keep-until-success')
    expect(store.kvGet(instance, 'project', 'project-marker')).toBeNull()
    expect(await call()).toEqual({ before: 1, staged: 2, hadCredential: true })
    expect(client.starts).toBe(failure === 'error' ? 1 : 2)
    await client.close()
    expect(exits).toBe(client.starts)
    // A new SQLite handle must see the successful checkpoint, never failed edits.
    database.close(); database = new Database(join(directory, 'fixture.db'))
    store = new ConnectorStore({ db: database })
    expect(store.kvGet(instance, 'flow', 'cursor')).toBe(2)
    expect(store.kvGet(foreign, 'flow', 'cursor')).toBe(900)
  }, 10000)

  it('rolls back the entire successful result if a later SQLite edit fails', async () => {
    database.exec(`CREATE TRIGGER fail_fixture_marker BEFORE INSERT ON connector_kv WHEN NEW.key = 'project-marker' BEGIN SELECT RAISE(ABORT, 'fixture checkpoint write refused'); END`)
    await expect(call()).rejects.toBeInstanceOf(PieceExecutionError)
    expect(store.kvGet(instance, 'flow', 'cursor')).toBe(1)
    expect(store.kvGet(instance, 'flow', 'deleted')).toBe('keep-until-success')
    database.exec('DROP TRIGGER fail_fixture_marker')
    await expect(call()).resolves.toMatchObject({ before: 1, staged: 2 })
  })

  it('commits imported tasks and worker checkpoint together, retaining the old cursor across failed commit and reopen', async () => {
    let source = manager(), importer = engine()
    const project = source.createProject({ name: 'Synthetic checkpoint project' })!
    const config = { piece_name: base.pieceName, connector_instance_id: instance, props: { board_id: 'fixture-board' } }
    const taskSource = source.createTaskSource({ name: 'Synthetic source', plugin_id: 'connector-bridge', mcp_server_id: null, project_id: project.id, config })!
    database.exec(`CREATE TRIGGER fail_fixture_sync BEFORE UPDATE ON connector_sync_state WHEN NEW.last_synced_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture sync commit refused'); END`)
    const failed = await importer.sync(taskSource.id, config, { db: source })
    expect(failed).toMatchObject({ imported: 0, updated: 0 })
    expect(failed.errors).not.toEqual([])
    expect(source.getTaskByExternalId(taskSource.id, 'synthetic-item')).toBeUndefined()
    expect(store.kvGet(instance, 'flow', 'cursor')).toBe(1)
    expect(store.getSyncState(instance)?.cursor).toMatchObject({ triggerEnabled: 'deadline' })
    await importer.close(); await client.close(); credentials.close(); database.close()
    database = new Database(join(directory, 'fixture.db')); store = new ConnectorStore({ db: database }); credentials = new ConnectorCredentialStore(store)
    expect(store.kvGet(instance, 'flow', 'cursor')).toBe(1)
    database.exec('DROP TRIGGER fail_fixture_sync')
    source = manager(); client = makeClient(); importer = engine()
    try {
      await expect(importer.sync(taskSource.id, config, { db: source }, { manual: true })).resolves.toMatchObject({ imported: 1, updated: 0, errors: [] })
      expect(source.getTaskByExternalId(taskSource.id, 'synthetic-item')?.title).toBe('Recovered item')
      expect(store.kvGet(instance, 'flow', 'cursor')).toBe(2)
      expect(store.getSyncState(instance)?.lastSyncedAt).not.toBeNull()
    } finally { await importer.close() }
  }, 15000)

  it('rolls back trigger initialization when its durable enable marker cannot be saved', async () => {
    const source = manager(), importer = engine()
    const project = source.createProject({ name: 'Synthetic enable project' })!
    const config = { piece_name: base.pieceName, connector_instance_id: instance, props: { board_id: 'fixture-board' } }
    const taskSource = source.createTaskSource({ name: 'Synthetic source', plugin_id: 'connector-bridge', mcp_server_id: null, project_id: project.id, config })!
    store.kvPut(instance, 'flow', 'cursor', 7)
    database.exec(`CREATE TRIGGER fail_fixture_enable BEFORE INSERT ON connector_sync_state WHEN NEW.cursor LIKE '%triggerEnabled%' BEGIN SELECT RAISE(ABORT, 'fixture enable commit refused'); END`)
    try {
      const failed = await importer.sync(taskSource.id, config, { db: source })
      expect(failed.errors).not.toEqual([])
      expect(store.kvGet(instance, 'flow', 'cursor')).toBe(7)
      expect(store.getSyncState(instance)?.cursor).not.toHaveProperty('triggerEnabled')
      database.exec('DROP TRIGGER fail_fixture_enable')
      await expect(importer.sync(taskSource.id, config, { db: source }, { manual: true })).resolves.toMatchObject({ imported: 1, errors: [] })
      expect(store.kvGet(instance, 'flow', 'cursor')).toBe(2)
    } finally { await importer.close() }
  }, 15000)

  it('retains the previous checkpoint if a staged value exceeds the existing cap', async () => {
    // Guard the public KV adapter too: an untrusted worker cannot grow a call
    // journal without bound while durable storage waits for its result.
    const pending = kvBackendFromConnectorStore(store).beginCall!(instance)
    pending.put('flow', 'cursor', 99)
    expect(() => pending.put('flow', 'too-large', 'x'.repeat(CONNECTOR_KV_MAX_VALUE_BYTES))).toThrow('limit')
    pending.discard()
    expect(store.kvGet(instance, 'flow', 'cursor')).toBe(1)
    expect(() => pending.commit()).toThrow('closed')
  })
})
