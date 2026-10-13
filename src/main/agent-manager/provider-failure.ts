import { findCreditExhaustionMessage } from './credit-exhaustion'

/** Recovery semantics are independent of the backend's spelling of an error.
 * Delivery evidence is a separate requirement: a retryable error alone never
 * proves that replaying a prompt is safe. */
export interface ProviderFailure {
  kind: 'transient' | 'exhausted' | 'terminal'
  message: string
  delivery: 'rejected' | 'turn_failed' | 'unknown'
  code?: string
  intentId?: string
}

export function classifyProviderFailure(error: unknown, delivery: ProviderFailure['delivery'] = 'unknown'): ProviderFailure {
  const raw = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const existing = raw.providerFailure as ProviderFailure | undefined
  if (existing) return existing
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(raw.message ?? error)
  const code = String(raw.code ?? raw.status ?? raw.statusCode ?? '')
  const text = `${message} ${code}`.toLowerCase()
  // Authority/configuration failures win over embedded provider text.
  if (/incompatible.?session|unauthori[sz]ed|authentication|invalid.?api.?key|invalid.?model|model.?not.?found|permission|approval|cancelled|canceled|aborterror|manual.?stop/.test(text)
    || /^(401|403|404)$/.test(code)) return { kind: 'terminal', message, delivery, code }
  if (findCreditExhaustionMessage([message, code])) return { kind: 'exhausted', message, delivery, code }
  if (/serveroverloaded|overloaded|at capacity|rate.?limit|throttl|too many requests|service unavailable|temporarily unavailable|internal server error|bad gateway|gateway timeout|stream.?disconnect|connection reset|econnreset|\b(?:429|500|502|503|504|529)\b/.test(text)) {
    return { kind: 'transient', message, delivery, code }
  }
  return { kind: 'terminal', message, delivery, code }
}

export function providerFailureError(error: unknown, delivery: ProviderFailure['delivery']): Error & { providerFailure: ProviderFailure } {
  const failure = classifyProviderFailure(error, delivery)
  return Object.assign(new Error(failure.message), { providerFailure: failure })
}

export const PROVIDER_MAX_RETRIES = 5
export const PROVIDER_RETRY_MAX_MS = 60_000
export function providerRetryDelay(intentId: string, attempt: number): number {
  let hash = 0
  for (const char of `${intentId}:${attempt}`) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0
  const base = Math.min(48_000, 1_000 * 2 ** Math.max(0, attempt - 1))
  return Math.min(PROVIDER_RETRY_MAX_MS, Math.round(base * (1 + (hash % 251) / 1000)))
}

export const PROVIDER_CONTINUATION = 'Continue the interrupted work from the persisted conversation and current workspace. Inspect completed tool results first. Do not repeat completed tool calls, task starts, writes, or other external actions. Continue only the remaining intent below; if an outcome is unconfirmed, stop and ask the user to resolve it.'
