/**
 * Feature flags of the managed sessions epic (#96), stored as `settings` rows.
 * The epic's rollout (decision D9) is observe-only first; later batches add
 * `sessions.commander_managed`, `sessions.captain_managed` and
 * `sessions.rollover` (see docs/managed-sessions.md).
 */
export const SESSION_FLAG_KEYS = {
  /**
   * B3 (#99): record every Commander, Captain and task-agent turn in the
   * managed-session ledger. Record only: nothing reads the ledger to change
   * behaviour. On unless the setting is `off` (or `false`, `0`, `no`).
   */
  ledger: 'sessions.ledger'
} as const

const OFF_VALUES = new Set(['off', 'false', '0', 'no', 'disabled'])

/** Whether `sessions.ledger` records. A missing or unreadable setting counts as on. */
export function isLedgerEnabled(getSetting: (key: string) => string | null | undefined): boolean {
  try {
    const value = getSetting(SESSION_FLAG_KEYS.ledger)
    if (value === null || value === undefined) return true
    return !OFF_VALUES.has(String(value).trim().toLowerCase())
  } catch {
    return true
  }
}

/** Reads a setting straight from the `settings` table (for callers holding only the raw handle). */
export function settingReader(source: { db: { prepare(sql: string): { get(...args: unknown[]): unknown } } }): (key: string) => string | undefined {
  return (key) => (source.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
}
