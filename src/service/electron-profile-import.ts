/**
 * First-launch import of an Electron 21x profile into a new authenticated
 * profile. The Electron database is read through SQLite's backup API while the
 * Electron app's profile lock is held, so it is never modified; every
 * credential is then converted inside the copy and the copy is published with
 * one rename. A failure leaves no database behind, so the next launch simply
 * tries again, and the Electron app keeps working on its original data.
 *
 * Electron `safeStorage` values use Chromium's os_crypt scheme: a `v10`/`v11`
 * prefix, then AES-128-CBC with a PBKDF2-SHA1 key ("saltysalt") derived from
 * the password the app keeps in the OS credential store (v11 on Linux, v10 on
 * macOS) or, for Linux v10, the fixed "peanuts" password.
 */
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { existsSync, fsyncSync, lstatSync, openSync, closeSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import { acquireProfileLock } from '../main/platform/profile-lock'
import type { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { encryptRecordCredential, encryptSettingValue } from '../main/database/serializers'
import { TASK_SOURCE_STORED_CREDENTIAL_FIELDS } from '../shared/task-source-credentials'

export class ElectronProfileImportError extends Error {
  constructor(readonly code: 'ELECTRON_PROFILE_IN_USE' | 'ELECTRON_PROFILE_INVALID' | 'ELECTRON_CREDENTIALS_UNAVAILABLE') {
    super(code)
    this.name = 'ElectronProfileImportError'
  }
}

const SAFE_STORAGE_SETTING_PREFIX = 'safeStorage:v1:'
const RECORD_PREFIX = '21x-record-credential:'
/** Marker shared with the production owner: the managed task MCP row it may refresh. */
export const MANAGED_TASK_MCP_MARKER = '__managed_task_mcp_id'
const IMPORT_SETTLED = 'Imported from the previous 21x app; not resumed automatically'
/** How many legacy credentials could not be read and were cleared for re-entry. */
export const DROPPED_CREDENTIALS_SETTING = '__electron_import_cleared_credentials'

export interface ElectronImportOptions {
  /** Electron userData directory chosen by trusted native setup. */
  profileRoot: string
  /** Destination database path inside the new, locked, empty profile. */
  destination: string
  /** Already configured as the process secret storage for the destination profile. */
  storage: AuthenticatedSecretStorage
  /** Read-only Chromium password for the Electron app, when the OS store has one. */
  loadSafeStoragePassword(): Promise<Buffer | null>
  platform?: NodeJS.Platform
}

/** Decrypts Chromium os_crypt ciphertext; null when the bytes are not os_crypt. */
export function createSafeStorageDecoder(password: Buffer | null, platform: NodeJS.Platform = process.platform): (value: Buffer) => string | null {
  const keys = new Map<string, Buffer>()
  const keyFor = (version: 'v10' | 'v11'): Buffer | null => {
    if (keys.has(version)) return keys.get(version)!
    let key: Buffer | null = null
    if (platform === 'darwin') key = version === 'v10' && password ? pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1') : null
    else if (version === 'v10') key = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
    else key = password ? pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1') : null
    if (key) keys.set(version, key)
    return key
  }
  return value => {
    const version = value.subarray(0, 3).toString('latin1')
    if (version !== 'v10' && version !== 'v11') return null
    const key = keyFor(version)
    if (!key) throw new ElectronProfileImportError('ELECTRON_CREDENTIALS_UNAVAILABLE')
    try {
      const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
      const plain = Buffer.concat([decipher.update(value.subarray(3)), decipher.final()])
      try { return new TextDecoder('utf-8', { fatal: true }).decode(plain) } finally { plain.fill(0) }
    } catch {
      throw new ElectronProfileImportError('ELECTRON_CREDENTIALS_UNAVAILABLE')
    }
  }
}

function realDirectory(path: string): boolean {
  try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink() } catch { return false }
}

/** Copy, convert and publish. Returns false when there is nothing to import. */
export async function importElectronProfile(options: ElectronImportOptions): Promise<boolean> {
  const source = join(options.profileRoot, '21x.db')
  if (!realDirectory(options.profileRoot) || !existsSync(source) || !lstatSync(source).isFile()) return false
  if (existsSync(options.destination)) throw new ElectronProfileImportError('ELECTRON_PROFILE_INVALID')
  const staging = `${options.destination}.import`
  rmSync(staging, { force: true })
  rmSync(`${staging}-journal`, { force: true })
  let lock: ReturnType<typeof acquireProfileLock>
  try { lock = acquireProfileLock(options.profileRoot) } catch { throw new ElectronProfileImportError('ELECTRON_PROFILE_IN_USE') }
  try {
    const original = new SQLite(source, { readonly: true, fileMustExist: true, timeout: 5000 })
    try { await original.backup(staging) } catch { throw new ElectronProfileImportError('ELECTRON_PROFILE_INVALID') } finally { original.close() }
  } finally { lock.release() }
  try {
    const password = await options.loadSafeStoragePassword()
    let dropped = 0
    try {
      dropped = convertCredentials(staging, createSafeStorageDecoder(password, options.platform), options.storage)
    } finally { password?.fill(0) }
    if (dropped) {
      const db = new SQLite(staging, { fileMustExist: true })
      try { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(DROPPED_CREDENTIALS_SETTING, String(dropped)) } finally { db.close() }
    }
    const descriptor = openSync(staging, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    renameSync(staging, options.destination)
    return true
  } catch (error) {
    rmSync(staging, { force: true })
    throw error instanceof ElectronProfileImportError ? error : new ElectronProfileImportError('ELECTRON_PROFILE_INVALID')
  }
}

/** Returns how many unreadable credentials were cleared. */
function convertCredentials(path: string, rawDecode: (value: Buffer) => string | null, storage: AuthenticatedSecretStorage): number {
  const db = new SQLite(path, { fileMustExist: true })
  let dropped = 0
  // One unreadable secret (locked keyring, corrupt bytes) must not cost the
  // whole profile: it is cleared and the user re-enters it.
  const decode = (value: Buffer): string | null => {
    try { return rawDecode(value) } catch { dropped++; return '' }
  }
  try {
    db.pragma('journal_mode = DELETE')
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name))
    const columns = (table: string): Set<string> => new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(row => row.name))
    /** Untagged legacy BLOB: os_crypt ciphertext, or UTF-8 written while encryption was unavailable. */
    const utf8 = (value: Buffer): string => {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(value) } catch { dropped++; return '' }
    }
    const blob = (value: Buffer): Buffer => storage.encryptString(decode(value) ?? utf8(value))
    const record = (value: unknown): unknown => typeof value !== 'string' || value === '' || value.startsWith(RECORD_PREFIX) ? value : encryptRecordCredential(value)
    db.transaction(() => {
      if (tables.has('settings')) {
        const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?')
        for (const row of db.prepare("SELECT key, value FROM settings WHERE key LIKE '%\\_api\\_key' ESCAPE '\\' AND value <> ''").all() as Array<{ key: string; value: string }>) {
          const plain = row.value.startsWith(SAFE_STORAGE_SETTING_PREFIX)
            ? decode(Buffer.from(row.value.slice(SAFE_STORAGE_SETTING_PREFIX.length), 'base64'))
            : row.value
          update.run(plain ? encryptSettingValue(plain) : '', row.key)
        }
      }
      for (const [table, fields] of [['secrets', ['value']], ['oauth_tokens', ['access_token', 'refresh_token']], ['connector_instances', ['auth']]] as const) {
        if (!tables.has(table)) continue
        const present = columns(table)
        for (const field of fields) {
          if (!present.has(field)) continue
          const update = db.prepare(`UPDATE "${table}" SET "${field}" = ? WHERE rowid = ?`)
          for (const row of db.prepare(`SELECT rowid AS id, "${field}" AS value FROM "${table}" WHERE "${field}" IS NOT NULL`).all() as Array<{ id: number; value: Buffer | string }>) {
            const value = Buffer.isBuffer(row.value) ? row.value : Buffer.from(row.value, 'utf8')
            update.run(value.length ? blob(value) : null, row.id)
          }
        }
      }
      const json = (table: string, field: string, transform: (value: Record<string, unknown>) => Record<string, unknown>): void => {
        if (!tables.has(table) || !columns(table).has(field)) return
        const update = db.prepare(`UPDATE "${table}" SET "${field}" = ? WHERE rowid = ?`)
        for (const row of db.prepare(`SELECT rowid AS id, "${field}" AS value FROM "${table}"`).all() as Array<{ id: number; value: string | null }>) {
          if (!row.value) continue
          const parsed = JSON.parse(row.value) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
          update.run(JSON.stringify(transform(parsed as Record<string, unknown>)), row.id)
        }
      }
      const everyValue = (values: unknown): unknown => values && typeof values === 'object' && !Array.isArray(values)
        ? Object.fromEntries(Object.entries(values as Record<string, unknown>).map(([key, value]) => [key, record(value)])) : values
      json('agents', 'config', config => config.api_keys === undefined ? config : { ...config, api_keys: everyValue(config.api_keys) })
      json('mcp_servers', 'headers', everyValue as (value: Record<string, unknown>) => Record<string, unknown>)
      json('mcp_servers', 'environment', everyValue as (value: Record<string, unknown>) => Record<string, unknown>)
      json('mcp_servers', 'oauth_metadata', metadata => metadata.client_secret === undefined ? metadata : { ...metadata, client_secret: record(metadata.client_secret) })
      json('task_sources', 'config', config => {
        const result = { ...config }
        for (const key of TASK_SOURCE_STORED_CREDENTIAL_FIELDS) if (result[key] !== undefined) result[key] = record(result[key])
        return result
      })
      // Work the old app was in the middle of (lost sessions awaiting a
      // recap, undelivered messages, queued starts) may be weeks old. It is
      // settled, not resumed: nothing acts on the first launch by itself, and
      // every task stays where it was for the user to restart.
      const settle = (table: string, sql: string): void => { if (tables.has(table)) db.prepare(sql).run() }
      settle('agent_provider_recovery', `UPDATE agent_provider_recovery SET state = 'cancelled', record = json_set(record, '$.state', 'cancelled')
        WHERE state IN ('sending', 'accepted', 'retrying', 'dispatching') AND json_valid(record)`)
      settle('delivery_outbox', `UPDATE delivery_outbox SET state = 'cancelled', last_error = '${IMPORT_SETTLED}'
        WHERE state IN ('pending', 'claimed', 'accepted')`)
      settle('agent_start_queue', `UPDATE agent_start_queue SET state = 'cancelled', last_error = '${IMPORT_SETTLED}'
        WHERE state IN ('queued', 'retrying', 'claimed', 'starting')`)
      // Electron owned its task-management row by name. The import is the
      // trusted step that hands exactly that row to the new profile.
      if (tables.has('mcp_servers')) {
        const managed = db.prepare("SELECT id FROM mcp_servers WHERE name = 'task-management'").all() as Array<{ id: string }>
        if (managed.length === 1) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(MANAGED_TASK_MCP_MARKER, encryptSettingValue(managed[0].id))
      }
    })()
  } finally { db.close() }
  return dropped
}
