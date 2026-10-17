import type Database from 'better-sqlite3'
import { isNativeWindowState, type NativeWindowState } from '../shared/native-window-state'
import { ServiceProtocolError } from '../shared/service-protocol'

/** This key is deliberately absent from the public production settings list.
 * Native window observations have no task/configuration credential authority. */
const KEY = '__native_window_state_v1'
export class NativeWindowStateStore {
  constructor(private readonly database: Database.Database, private readonly beforeEffect: () => void) {}
  load(): { state: NativeWindowState | null } {
    this.beforeEffect()
    const size = this.database.prepare('SELECT typeof(value) AS type,length(CAST(value AS BLOB)) AS bytes FROM settings WHERE key=?').get(KEY) as { type: string; bytes: number } | undefined
    this.beforeEffect()
    if (!size || size.type !== 'text' || size.bytes > 1024) return { state: null }
    const row = this.database.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as { value: string } | undefined
    this.beforeEffect()
    if (!row) return { state: null }
    let state: unknown
    try { state = JSON.parse(row.value) } catch { return { state: null } }
    return { state: isNativeWindowState(state) ? state : null }
  }
  save(state: NativeWindowState): { saved: true } {
    if (!isNativeWindowState(state)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const value = JSON.stringify(state)
    this.beforeEffect()
    this.database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, value)
    this.beforeEffect()
    return { saved: true }
  }
}
