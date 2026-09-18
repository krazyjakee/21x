import {
  PieceCancelledError,
  PieceExecutionError,
  PieceHostCrashedError,
  PieceTimeoutError
} from '../piece-host/errors'

/**
 * Retry policy for connector-bridge piece calls (issue #13).
 *
 * 429 and 5xx responses, timeouts and host crashes are retried with
 * exponential backoff; a Retry-After hint wins over the computed delay. Every
 * other failure (auth, 4xx, allowlist, SSRF, unsupported context, bad output)
 * is permanent.
 *
 * Pieces surface HTTP failures only as error messages (the piece host passes
 * name + message across the process boundary), so the status and Retry-After
 * are recovered from the message: pieces-common's HttpError serialises
 * `{"response":{"status":503,...}}`, axios says "status code 503", and some
 * pieces rewrite 429s to "rate limit exceeded". Errors that carry numeric
 * `status` / `retryAfterMs` properties are honoured directly.
 */

export interface RetryPolicy {
  /** Attempts (including the first) before the work is dead-lettered. */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 30_000,
  maxDelayMs: 60 * 60_000
}

/** Upper bound for a provider's Retry-After hint. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000

/** Per-item failures (validation, write errors) tolerated across syncs before dead-lettering. */
export const DEFAULT_ITEM_MAX_ATTEMPTS = 3

export interface ErrorClassification {
  retryable: boolean
  status?: number
  retryAfterMs?: number
  rateLimited: boolean
}

const STATUS_PATTERNS = [
  /"status"\s*:\s*(\d{3})/,
  /status code (\d{3})/i,
  /\bHTTP\/?\d?(?:\.\d)?\s+(\d{3})\b/i,
  /\bstatus[:=\s]+(\d{3})\b/i
]
const RETRY_AFTER_PATTERN = /retry[-_ ]?after["']?\s*[:=]?\s*["']?([^"',}\n]+)/i

/** Parses a Retry-After value: delta seconds or an HTTP date. */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value * 1000)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(parseFloat(trimmed) * 1000)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

function readStatus(err: unknown, message: string): number | undefined {
  const own = (err as { status?: unknown; statusCode?: unknown } | null) ?? {}
  for (const v of [own.status, own.statusCode]) {
    if (typeof v === 'number' && v >= 100 && v < 600) return v
  }
  for (const re of STATUS_PATTERNS) {
    const m = re.exec(message)
    if (m) {
      const n = parseInt(m[1], 10)
      if (n >= 100 && n < 600) return n
    }
  }
  if (/rate[- ]limit|too many requests/i.test(message)) return 429
  return undefined
}

export function classifyError(err: unknown, now: number = Date.now()): ErrorClassification {
  if (err instanceof PieceTimeoutError || err instanceof PieceHostCrashedError) {
    return { retryable: true, rateLimited: false }
  }
  if (err instanceof PieceCancelledError) return { retryable: false, rateLimited: false }
  // Allowlist, SSRF and unsupported-context errors are PieceHostErrors but not
  // PieceExecutionErrors: retrying cannot help.
  const isPlainError = err instanceof PieceExecutionError || !(err instanceof Error && 'code' in err)
  if (!isPlainError) return { retryable: false, rateLimited: false }

  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const status = readStatus(err, message)
  const own = (err as { retryAfterMs?: unknown } | null) ?? {}
  let retryAfterMs = typeof own.retryAfterMs === 'number' && own.retryAfterMs >= 0 ? own.retryAfterMs : undefined
  if (retryAfterMs === undefined) {
    const m = RETRY_AFTER_PATTERN.exec(message)
    if (m) retryAfterMs = parseRetryAfter(m[1], now)
  }
  const rateLimited = status === 429
  const retryable = rateLimited || (status !== undefined && status >= 500 && status < 600)
  return { retryable, status, retryAfterMs: retryable ? retryAfterMs : undefined, rateLimited }
}

/**
 * Delay before attempt `attempt + 1`, where `attempt` is the number of
 * failures so far (1 after the first failure). Retry-After wins when given.
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, retryAfterMs?: number): number {
  // Retry-After is honoured even past maxDelayMs, but never beyond a day.
  if (retryAfterMs !== undefined) return Math.min(Math.max(0, retryAfterMs), MAX_RETRY_AFTER_MS)
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(exp, policy.maxDelayMs)
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  return 'Unknown error'
}
