import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../database/schema'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import {
  CONNECTOR_KV_MAX_INSTANCE_BYTES,
  CONNECTOR_KV_MAX_KEY_CHARS,
  CONNECTOR_KV_MAX_VALUE_BYTES,
  ConnectorKvLimitError,
  ConnectorStore
} from './connector-store'

type Db = InstanceType<typeof Database>

const CONNECTOR_TABLES = ['connector_dead_letters', 'connector_instances', 'connector_kv', 'connector_sync_state']

function openMemory(): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

function tableNames(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'connector_%' ORDER BY name").all() as
    { name: string }[]).map((r) => r.name)
}

function countRows(db: Db, table: string, instanceId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE instance_id = ?`).get(instanceId) as { n: number }).n
}

describe('connector schema', () => {
  it('a fresh database gets the connector tables', () => {
    const db = openMemory()
    applySchema(db)
    expect(tableNames(db)).toEqual(CONNECTOR_TABLES)
  })

  it('an existing database from before connectors gets them on the next start, without a version bump', () => {
    const db = openMemory()
    applySchema(db)
    db.prepare("INSERT INTO settings (key, value) VALUES ('keep', 'me')").run()
    // The shape of an install that is already at the current schema version
    // but predates connectors.
    for (const t of CONNECTOR_TABLES) db.exec(`DROP TABLE ${t}`)
    expect(tableNames(db)).toEqual([])

    expect(applySchema(db)).toBe(false)
    expect(tableNames(db)).toEqual(CONNECTOR_TABLES)
    expect(db.prepare("SELECT value FROM settings WHERE key = 'keep'").get()).toEqual({ value: 'me' })
  })

  it('every child table cascades from connector_instances', () => {
    const db = openMemory()
    applySchema(db)
    for (const t of CONNECTOR_TABLES.filter((t) => t !== 'connector_instances')) {
      const fks = db.pragma(`foreign_key_list(${t})`) as { table: string; on_delete: string }[]
      expect(fks).toEqual([expect.objectContaining({ table: 'connector_instances', on_delete: 'CASCADE' })])
    }
  })
})

describe('ConnectorStore', () => {
  let rawDb: Db
  let store: ConnectorStore

  beforeEach(() => {
    ;({ rawDb } = createTestDb())
    store = new ConnectorStore({ db: rawDb })
  })

  describe('instances', () => {
    it('creates, reads, updates and lists instances', () => {
      const a = store.createInstance({ pieceName: '@activepieces/piece-slack', pieceVersion: '0.9.1', displayName: 'Slack', config: { channel: 'ops' } })
      expect(a).toMatchObject({
        pieceName: '@activepieces/piece-slack', pieceVersion: '0.9.1', displayName: 'Slack',
        config: { channel: 'ops' }, enabled: true, authType: null, hasStoredAuth: false
      })

      const updated = store.updateInstance(a.id, { enabled: false, pieceVersion: '0.9.2', config: { channel: 'dev' } })
      expect(updated).toMatchObject({ enabled: false, pieceVersion: '0.9.2', config: { channel: 'dev' }, displayName: 'Slack' })
      expect(store.getInstance(a.id)).toEqual(updated)

      const b = store.createInstance({ pieceName: '@activepieces/piece-github', pieceVersion: '1.0.0' })
      expect(store.listInstances().map((i) => i.id)).toEqual([a.id, b.id])
      expect(store.updateInstance('missing', { enabled: true })).toBeUndefined()
    })

    it('never exposes the auth ciphertext on the record', () => {
      const a = store.createInstance({ pieceName: 'p', pieceVersion: '1' })
      store.setAuthBlob(a.id, 'secret_text', Buffer.from('ciphertext'))
      const record = store.getInstance(a.id)!
      expect(record).toMatchObject({ authType: 'secret_text', hasStoredAuth: true })
      expect(JSON.stringify(record)).not.toContain('ciphertext')
    })
  })

  describe('key-value store', () => {
    let a: string
    let b: string

    beforeEach(() => {
      a = store.createInstance({ pieceName: 'p', pieceVersion: '1' }).id
      b = store.createInstance({ pieceName: 'p', pieceVersion: '1' }).id
    })

    it.each(['project', 'flow'] as const)('get / put / delete in the %s scope', (scope) => {
      expect(store.kvGet(a, scope, 'cursor')).toBeNull()
      store.kvPut(a, scope, 'cursor', { since: '2026-01-01', ids: [1, 2] })
      expect(store.kvGet(a, scope, 'cursor')).toEqual({ since: '2026-01-01', ids: [1, 2] })

      store.kvPut(a, scope, 'cursor', 42)
      expect(store.kvGet(a, scope, 'cursor')).toBe(42)
      expect(store.kvList(a, scope)).toEqual(['cursor'])

      expect(store.kvDelete(a, scope, 'cursor')).toBe(true)
      expect(store.kvGet(a, scope, 'cursor')).toBeNull()
      expect(store.kvDelete(a, scope, 'cursor')).toBe(false)
    })

    it('isolates keys per instance and per scope', () => {
      store.kvPut(a, 'project', 'k', 'a-project')
      store.kvPut(a, 'flow', 'k', 'a-flow')
      store.kvPut(b, 'project', 'k', 'b-project')

      expect(store.kvGet(a, 'project', 'k')).toBe('a-project')
      expect(store.kvGet(a, 'flow', 'k')).toBe('a-flow')
      expect(store.kvGet(b, 'project', 'k')).toBe('b-project')
      expect(store.kvGet(b, 'flow', 'k')).toBeNull()

      store.kvDelete(a, 'project', 'k')
      expect(store.kvGet(a, 'flow', 'k')).toBe('a-flow')
      expect(store.kvGet(b, 'project', 'k')).toBe('b-project')

      expect(store.kvClear(a)).toBe(1)
      expect(store.kvGet(b, 'project', 'k')).toBe('b-project')
    })

    it('rejects an unknown scope', () => {
      expect(() => store.kvPut(a, 'global' as never, 'k', 1)).toThrow(/scope/)
    })

    it('rejects an oversized value with a typed error and writes nothing', () => {
      const big = 'x'.repeat(CONNECTOR_KV_MAX_VALUE_BYTES)
      let error: unknown
      try {
        store.kvPut(a, 'project', 'big', big)
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(ConnectorKvLimitError)
      expect(error).toMatchObject({ kind: 'value', limit: CONNECTOR_KV_MAX_VALUE_BYTES, code: 'CONNECTOR_KV_LIMIT' })
      expect(store.kvGet(a, 'project', 'big')).toBeNull()

      // Exactly at the cap is fine (the JSON quotes count).
      store.kvPut(a, 'project', 'ok', 'x'.repeat(CONNECTOR_KV_MAX_VALUE_BYTES - 2))
      expect(store.kvList(a, 'project')).toEqual(['ok'])
    })

    it('rejects an overlong key with a typed error', () => {
      expect(() => store.kvPut(a, 'flow', 'k'.repeat(CONNECTOR_KV_MAX_KEY_CHARS + 1), 1))
        .toThrow(expect.objectContaining({ name: 'ConnectorKvLimitError', kind: 'key' }))
    })

    it('caps the total per instance across scopes, without counting an overwritten value twice', () => {
      const chunk = 'x'.repeat(500 * 1024)
      const fits = Math.floor(CONNECTOR_KV_MAX_INSTANCE_BYTES / (chunk.length + 2 + 4))
      for (let i = 0; i < fits; i++) store.kvPut(a, i % 2 ? 'flow' : 'project', `k${String(i).padStart(3, '0')}`, chunk)

      expect(() => store.kvPut(a, 'project', 'one-more', chunk))
        .toThrow(expect.objectContaining({ name: 'ConnectorKvLimitError', kind: 'instance', limit: CONNECTOR_KV_MAX_INSTANCE_BYTES }))
      expect(store.kvGet(a, 'project', 'one-more')).toBeNull()
      expect(store.kvUsage(a)).toBeLessThanOrEqual(CONNECTOR_KV_MAX_INSTANCE_BYTES)

      // Replacing an existing key is measured net of its old value.
      store.kvPut(a, 'project', 'k000', chunk)
      // Another instance has its own budget.
      store.kvPut(b, 'project', 'one-more', chunk)
    })
  })

  describe('sync state and dead letters', () => {
    it('merges sync-state patches', () => {
      const id = store.createInstance({ pieceName: 'p', pieceVersion: '1' }).id
      expect(store.getSyncState(id)).toBeNull()

      store.updateSyncState(id, { cursor: { page: 2 }, attemptCount: 1, lastError: 'timeout', nextRetryAt: 1000 })
      const next = store.updateSyncState(id, { lastSyncedAt: 2000, attemptCount: 0, lastError: null })
      expect(next).toEqual({ instanceId: id, cursor: { page: 2 }, attemptCount: 0, nextRetryAt: 1000, lastError: null, lastSyncedAt: 2000 })
    })

    it('adds, lists and clears dead letters', () => {
      const id = store.createInstance({ pieceName: 'p', pieceVersion: '1' }).id
      const d1 = store.addDeadLetter(id, { externalId: 'ext-1', payload: { a: 1 }, error: 'boom', attempts: 5 })
      const d2 = store.addDeadLetter(id, { payload: [1, 2], error: 'bad' })
      expect(store.listDeadLetters(id)).toEqual([d1, d2])
      expect(d1).toMatchObject({ externalId: 'ext-1', payload: { a: 1 }, attempts: 5 })

      expect(store.clearDeadLetters(id, [d1.id])).toBe(1)
      expect(store.listDeadLetters(id)).toEqual([d2])
      expect(store.clearDeadLetters(id)).toBe(1)
      expect(store.listDeadLetters(id)).toEqual([])
    })
  })

  it('deleting an instance cascades its KV, sync state, dead letters and auth, and notifies listeners', () => {
    const keep = store.createInstance({ pieceName: 'p', pieceVersion: '1' }).id
    const gone = store.createInstance({ pieceName: 'p', pieceVersion: '1' }).id
    for (const id of [keep, gone]) {
      store.kvPut(id, 'project', 'k', 1)
      store.kvPut(id, 'flow', 'k', 2)
      store.updateSyncState(id, { cursor: 'c' })
      store.addDeadLetter(id, { payload: {}, error: 'e' })
      store.setAuthBlob(id, 'secret_text', Buffer.from('cipher'))
    }
    const deleted: string[] = []
    store.onInstanceDeleted((id) => deleted.push(id))

    expect(store.deleteInstance(gone)).toBe(true)

    expect(deleted).toEqual([gone])
    expect(store.getInstance(gone)).toBeUndefined()
    expect(store.getAuthBlob(gone)).toBeUndefined()
    for (const t of ['connector_kv', 'connector_sync_state', 'connector_dead_letters']) {
      expect(countRows(rawDb, t, gone)).toBe(0)
      expect(countRows(rawDb, t, keep)).toBeGreaterThan(0)
    }
    expect(store.getAuthBlob(keep)?.auth).not.toBeNull()
  })
})
