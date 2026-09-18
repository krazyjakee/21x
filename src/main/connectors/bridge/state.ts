/**
 * Connector-bridge state kept in `connector_sync_state.cursor` (issue #13).
 *
 * The row's own columns hold the job-level retry state (attempt_count,
 * next_retry_at, last_error, last_synced_at). The cursor JSON holds the rest,
 * so everything survives a restart:
 *
 * - `triggerEnabled`: the polling trigger whose onEnable already ran.
 * - `lastRunAt`: when the scheduler last started a job (success or not).
 * - `rateLimitedUntil`: honoured by manual syncs too (a Retry-After).
 * - `items`: per-item failures by external id; `dead` once dead-lettered.
 *   A dead item is skipped until its content changes.
 * - `pending`: local title / due date / status changes that failed to reach
 *   the source and are waiting for a retry. Import leaves those fields alone
 *   until they land (local change wins).
 */

export interface BridgeItemFailure {
  attempts: number
  lastError: string
  fingerprint: string
  dead?: boolean
}

export interface BridgePendingUpdate {
  changed: Record<string, unknown>
  attempts: number
  nextRetryAt: number
  lastError: string
}

export interface BridgeCursor {
  v: 1
  triggerEnabled?: string
  lastRunAt?: number
  rateLimitedUntil?: number
  items: Record<string, BridgeItemFailure>
  pending: Record<string, BridgePendingUpdate>
}

/** Keeps the cursor bounded; the oldest failure records go first. */
export const BRIDGE_MAX_TRACKED_ITEMS = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function readCursor(raw: unknown): BridgeCursor {
  const cursor: BridgeCursor = { v: 1, items: {}, pending: {} }
  if (!isRecord(raw) || raw.v !== 1) return cursor
  if (typeof raw.triggerEnabled === 'string') cursor.triggerEnabled = raw.triggerEnabled
  if (typeof raw.lastRunAt === 'number') cursor.lastRunAt = raw.lastRunAt
  if (typeof raw.rateLimitedUntil === 'number') cursor.rateLimitedUntil = raw.rateLimitedUntil
  if (isRecord(raw.items)) {
    for (const [id, v] of Object.entries(raw.items)) {
      if (isRecord(v) && typeof v.attempts === 'number') {
        cursor.items[id] = {
          attempts: v.attempts,
          lastError: typeof v.lastError === 'string' ? v.lastError : '',
          fingerprint: typeof v.fingerprint === 'string' ? v.fingerprint : '',
          ...(v.dead === true ? { dead: true } : {})
        }
      }
    }
  }
  if (isRecord(raw.pending)) {
    for (const [id, v] of Object.entries(raw.pending)) {
      if (isRecord(v) && isRecord(v.changed) && typeof v.attempts === 'number') {
        cursor.pending[id] = {
          changed: v.changed,
          attempts: v.attempts,
          nextRetryAt: typeof v.nextRetryAt === 'number' ? v.nextRetryAt : 0,
          lastError: typeof v.lastError === 'string' ? v.lastError : ''
        }
      }
    }
  }
  return cursor
}

export function trimCursor(cursor: BridgeCursor): BridgeCursor {
  const ids = Object.keys(cursor.items)
  for (const id of ids.slice(0, Math.max(0, ids.length - BRIDGE_MAX_TRACKED_ITEMS))) delete cursor.items[id]
  return cursor
}

/** Earliest time a pending update is due, or null. */
export function nextPendingAt(cursor: BridgeCursor): number | null {
  let next: number | null = null
  for (const p of Object.values(cursor.pending)) {
    if (next === null || p.nextRetryAt < next) next = p.nextRetryAt
  }
  return next
}
