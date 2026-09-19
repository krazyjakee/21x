import type { DatabaseManager } from '../database'

export interface MobilePairCodeRow {
  id: string
  pin: string
  expires_at: number
  attempts: number
}

export interface MobileSessionRow {
  id: string
  device_name: string
  paired_at: number
  last_seen: number
  revoked: number
}

export function createMobilePairCode(m: DatabaseManager, id: string, pin: string, expiresAt: number): void {
  m.prepare(
    'INSERT INTO mobile_pair_codes (id, pin, expires_at) VALUES (?, ?, ?)'
  ).run(id, pin, expiresAt)
}

export function getMobilePairCode(m: DatabaseManager, id: string): MobilePairCodeRow | undefined {
  return m.prepare('SELECT * FROM mobile_pair_codes WHERE id = ?').get(id) as MobilePairCodeRow | undefined
}

export function incrementPairCodeAttempts(m: DatabaseManager, id: string): number {
  m.prepare('UPDATE mobile_pair_codes SET attempts = attempts + 1 WHERE id = ?').run(id)
  const row = m.prepare('SELECT attempts FROM mobile_pair_codes WHERE id = ?').get(id) as { attempts: number } | undefined
  return row?.attempts ?? 0
}

export function deleteMobilePairCode(m: DatabaseManager, id: string): void {
  m.prepare('DELETE FROM mobile_pair_codes WHERE id = ?').run(id)
}

export function createMobileSession(m: DatabaseManager, id: string, tokenHash: string, deviceName: string): void {
  m.prepare(
    'INSERT INTO mobile_sessions (id, token_hash, device_name) VALUES (?, ?, ?)'
  ).run(id, tokenHash, deviceName)
}

export function getMobileSessionByTokenHash(m: DatabaseManager, tokenHash: string): MobileSessionRow | undefined {
  return m.prepare('SELECT * FROM mobile_sessions WHERE token_hash = ? AND revoked = 0').get(tokenHash) as MobileSessionRow | undefined
}

export function getMobileSessions(m: DatabaseManager): MobileSessionRow[] {
  return m.prepare('SELECT id, device_name, paired_at, last_seen, revoked FROM mobile_sessions WHERE revoked = 0 ORDER BY last_seen DESC').all() as MobileSessionRow[]
}

export function touchMobileSession(m: DatabaseManager, tokenHash: string): void {
  m.prepare('UPDATE mobile_sessions SET last_seen = unixepoch() WHERE token_hash = ?').run(tokenHash)
}

export function revokeMobileSession(m: DatabaseManager, id: string): boolean {
  const result = m.prepare('UPDATE mobile_sessions SET revoked = 1 WHERE id = ?').run(id)
  return result.changes > 0
}

export function revokeAllMobileSessions(m: DatabaseManager): void {
  m.prepare('UPDATE mobile_sessions SET revoked = 1').run()
}
