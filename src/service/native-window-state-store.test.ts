import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { NativeWindowStateStore } from './native-window-state-store'
import { isNativeWindowState, NATIVE_WINDOW_STATE_SCHEMAS } from '../shared/native-window-state'
import { isProductionSettingKey, isProductionSettingWrite } from '../shared/production-settings-codecs'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const state = { version: 1 as const, x: -1920, y: 100, width: 1400, height: 900, scale: 1, maximized: false, fullscreen: false }
function fixture() {
  const db = new Database(':memory:'); databases.push(db)
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
  let current = true
  const store = new NativeWindowStateStore(db, () => { if (!current) throw new Error('owner lost') })
  return { db, store, revoke: () => { current = false } }
}
describe('private native window observations', () => {
  it('persists only a finite current-profile observation and never exposes its key as renderer settings', () => {
    const f = fixture(); expect(f.store.load()).toEqual({ state: null })
    expect(f.store.save(state)).toEqual({ saved: true }); expect(f.store.load()).toEqual({ state })
    expect(isProductionSettingKey('__native_window_state_v1')).toBe(false)
    expect(isProductionSettingWrite('__native_window_state_v1', JSON.stringify(state))).toBe(false)
    f.revoke(); expect(() => f.store.save({ ...state, x: 20 })).toThrow('owner lost')
    expect(() => f.store.load()).toThrow('owner lost')
    expect(JSON.parse((f.db.prepare('SELECT value FROM settings').get() as { value: string }).value)).toEqual(state)
  })
  it('bounds persisted materialization and restores defaults for corrupt/foreign state without rewriting it', () => {
    const f = fixture()
    for (const raw of ['{', 'x'.repeat(2048), JSON.stringify({ ...state, path: '/private' }), JSON.stringify({ ...state, width: 0 })]) {
      f.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('__native_window_state_v1', raw)
      expect(f.store.load()).toEqual({ state: null })
      expect((f.db.prepare('SELECT value FROM settings').get() as { value: string }).value).toBe(raw)
    }
  })
  it('refuses forged private operations, nonfinite geometry and renderer-selected authority', () => {
    expect(isNativeWindowState(state)).toBe(true)
    for (const invalid of [{ ...state, scale: Infinity }, { ...state, x: 0.5 }, { ...state, width: 32769 }, { ...state, maximized: 'true' }, { ...state, leaseId: 'renderer' }]) {
      expect(isNativeWindowState(invalid)).toBe(false)
      expect(() => fixture().store.save(invalid as typeof state)).toThrow()
    }
    expect(NATIVE_WINDOW_STATE_SCHEMAS['engine.windowState.load'].validatePayload({ path: '/private' })).toBe(false)
    expect(NATIVE_WINDOW_STATE_SCHEMAS['engine.windowState.save'].validatePayload({ state, profileId: 'foreign' })).toBe(false)
  })
})
