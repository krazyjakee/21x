import { createId } from '@paralleldrive/cuid2'
import type { DatabaseManager } from '../database'
import {
  decryptSettingValue,
  deserializeSecret,
  deserializeSecretWithValue,
  encryptSecret,
  encryptSettingValue,
  isApiKeySetting,
  isEncryptedSettingValue
} from './serializers'
import type { CreateSecretData, SecretRecord, SecretRecordWithValue, SecretRow, UpdateSecretData } from './types'

export function getSecrets(m: DatabaseManager): SecretRecord[] {
  const rows = m.prepare(
    'SELECT * FROM secrets ORDER BY name ASC'
  ).all() as SecretRow[]
  return rows.map(deserializeSecret)
}

export function getSecret(m: DatabaseManager, id: string): SecretRecord | undefined {
  const row = m.prepare(
    'SELECT * FROM secrets WHERE id = ?'
  ).get(id) as SecretRow | undefined
  return row ? deserializeSecret(row) : undefined
}

export function getSecretsByIds(m: DatabaseManager, ids: string[]): SecretRecord[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = m.db.prepare(
    `SELECT * FROM secrets WHERE id IN (${placeholders}) ORDER BY name ASC`
  ).all(...ids) as SecretRow[]
  return rows.map(deserializeSecret)
}

/**
 * Decrypts and returns secrets with their plaintext values.
 * ONLY for use within the main process (secret broker).
 * NEVER expose this through IPC.
 */
export function getSecretsWithValues(m: DatabaseManager, ids: string[]): SecretRecordWithValue[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = m.db.prepare(
    `SELECT * FROM secrets WHERE id IN (${placeholders}) ORDER BY name ASC`
  ).all(...ids) as SecretRow[]
  return rows.map(deserializeSecretWithValue)
}

export function createSecret(m: DatabaseManager, data: CreateSecretData): SecretRecord | undefined {
  const id = createId()
  const now = new Date().toISOString()
  const encryptedValue = encryptSecret(data.value)
  m.prepare(`
    INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.name, data.description, data.env_var_name, encryptedValue, now, now)
  return getSecret(m, id)
}

export function updateSecret(m: DatabaseManager, id: string, data: UpdateSecretData): SecretRecord | undefined {
  const existing = getSecret(m, id)
  if (!existing) return undefined

  const setClauses: string[] = []
  const values: (string | Buffer)[] = []

  if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name) }
  if (data.description !== undefined) { setClauses.push('description = ?'); values.push(data.description) }
  if (data.env_var_name !== undefined) { setClauses.push('env_var_name = ?'); values.push(data.env_var_name) }
  if (data.value !== undefined) {
    setClauses.push('value = ?')
    values.push(encryptSecret(data.value))
  }

  if (setClauses.length === 0) return existing

  setClauses.push('updated_at = ?')
  values.push(new Date().toISOString())
  values.push(id)

  m.db.prepare(
    `UPDATE secrets SET ${setClauses.join(', ')} WHERE id = ?`
  ).run(...values)

  return getSecret(m, id)
}

export function deleteSecret(m: DatabaseManager, id: string): boolean {
  const result = m.prepare('DELETE FROM secrets WHERE id = ?').run(id)
  return result.changes > 0
}

// API keys are encrypted at rest; callers in the main process always see plaintext.
export function getSetting(m: DatabaseManager, key: string): string | undefined {
  const row = m.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return undefined
  return isApiKeySetting(key) ? decryptSettingValue(row.value) : row.value
}

export function setSetting(m: DatabaseManager, key: string, value: string): void {
  const stored = isApiKeySetting(key) ? encryptSettingValue(value) : value
  m.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, stored)
}

/**
 * Re-encrypts API keys saved in plaintext by older versions (or while the
 * keychain was unavailable). Runs on every startup and is a no-op once done.
 */
export function encryptPlaintextApiKeys(m: DatabaseManager): number {
  const rows = m.prepare("SELECT key, value FROM settings WHERE key LIKE '%\\_api\\_key' ESCAPE '\\'")
    .all() as { key: string; value: string }[]
  let migrated = 0
  for (const row of rows) {
    if (!isApiKeySetting(row.key) || !row.value || isEncryptedSettingValue(row.value)) continue
    const encrypted = encryptSettingValue(row.value)
    if (encrypted === row.value) continue // keychain unavailable: keep the fallback
    m.prepare('UPDATE settings SET value = ? WHERE key = ?').run(encrypted, row.key)
    migrated++
  }
  return migrated
}

export function deleteSetting(m: DatabaseManager, key: string): void {
  m.prepare('DELETE FROM settings WHERE key = ?').run(key)
}

export function getAllSettings(m: DatabaseManager): Record<string, string> {
  const rows = m.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const result: Record<string, string> = {}
  for (const row of rows) result[row.key] = isApiKeySetting(row.key) ? decryptSettingValue(row.value) : row.value
  return result
}
