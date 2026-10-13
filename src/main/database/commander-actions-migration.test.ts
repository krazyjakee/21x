import { afterEach, describe, expect, it } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { applySchema } from './schema'
import { migrateCommanderActions } from './commander-actions-migration'
import type { DatabaseManager } from '../database'

const databases: DatabaseManager[] = []
afterEach(() => { for (const db of databases.splice(0)) db.db.close() })
function fixture() { const db = createPortableTestDb(); databases.push(db); return db }

describe('schema 35 Commander action migration', () => {
  it('upgrades the actual v34 sequence, preserves legacy attribution and ledger history, and is idempotent', () => {
    const manager = fixture(), db = manager.db
    db.exec('ALTER TABLE commander_messages DROP COLUMN input_mode; DROP TABLE commander_actions;')
    manager.setSetting('__schema_version', '34')
    db.prepare('INSERT INTO commander_sessions(id,title,created_at,updated_at,archived) VALUES (?,?,?,?,0)').run('old', 'Existing conversation', 1, 1)
    db.prepare('INSERT INTO commander_messages(id,session_id,role,content,created_at) VALUES (?,?,?,?,?)').run('old-user', 'old', 'user', 'An old typed or spoken request', 1)
    db.prepare(`INSERT INTO session_generations(id,owner_id,engine,generation_key,process_run_id,state,created_at,updated_at)
      VALUES ('ledger-old','commander:old','chat','generation-old','previous-process','idle',1,1)`).run()
    const before = (db.prepare('PRAGMA table_info(commander_messages)').all() as Array<{ name: string }>).map(column => column.name)
    expect(applySchema(db)).toBe(true)
    expect(manager.getSetting('__schema_version')).toBe('35')
    const after = (db.prepare('PRAGMA table_info(commander_messages)').all() as Array<{ name: string }>).map(column => column.name)
    expect(after.filter(name => !before.includes(name))).toEqual(['input_mode'])
    expect(db.prepare('SELECT content,input_mode FROM commander_messages WHERE id=?').get('old-user')).toEqual({ content: 'An old typed or spoken request', input_mode: null })
    expect(db.prepare('SELECT state FROM session_generations WHERE id=?').get('ledger-old')).toEqual({ state: 'idle' })
    expect(applySchema(db)).toBe(false)
    migrateCommanderActions(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM commander_messages').get()).toEqual({ n: 1 })
    expect(() => db.prepare('UPDATE commander_messages SET input_mode=? WHERE id=?').run('guessed', 'old-user')).toThrow()
  })

  it('fresh databases have the same single input-mode column and scoped action uniqueness', () => {
    const db = fixture().db
    const columns = db.prepare('PRAGMA table_info(commander_messages)').all() as Array<{ name: string }>
    expect(columns.filter(column => column.name === 'input_mode')).toHaveLength(1)
    const insert = db.prepare(`INSERT INTO commander_actions(id,session_id,tool_call_id,tool_name,target,changes,result,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    insert.run('first', 'session-a', 'turn:call', 'update_project', '{}', '[]', '{}', 1)
    expect(() => insert.run('duplicate', 'session-a', 'turn:call', 'update_project', '{}', '[]', '{}', 2)).toThrow()
    expect(() => insert.run('other', 'session-b', 'turn:call', 'update_project', '{}', '[]', '{}', 2)).not.toThrow()
  })
})
