/**
 * Provider errors that mean the current account cannot start or continue work.
 *
 * Deliberately excludes generic HTTP 429 / "rate limited" messages: those are
 * commonly short-lived request throttles and should be retried by the backend,
 * not cause an unexpected agent handoff.
 */
const CREDIT_EXHAUSTION_PATTERNS = [
  /\binsufficient[_\s-]?quota\b/i,
  /\bquota\s+(?:has\s+been\s+)?(?:exceeded|exhausted|depleted)\b/i,
  /\b(?:credit|credits|credit balance)\b.{0,80}\b(?:exhausted|depleted|too low|insufficient|used up|ran out|run out)\b/i,
  /\b(?:ran|run) out of (?:credits?|quota|usage)\b/i,
  /\b(?:usage|spending|monthly|weekly) limit\b.{0,80}\b(?:reached|exceeded|exhausted|used up|hit)\b/i,
  /\byou(?:'ve| have) hit your (?:usage |weekly |monthly )?limit\b/i,
  /\bout of (?:rate )?limits?\b/i,
  /\bpayment required\b/i,
  /\bbilling\b.{0,80}\b(?:quota|limit|credits?|balance)\b.{0,80}\b(?:exceeded|exhausted|depleted|too low|reached)\b/i,
]

export function isCreditExhaustionError(message: string | null | undefined): boolean {
  if (!message) return false
  return CREDIT_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message))
}

export function findCreditExhaustionMessage(messages: Array<string | null | undefined>): string | undefined {
  return messages.find((message): message is string => isCreditExhaustionError(message))
}

/** Normalize a persisted JSON config value into a safe, ordered fallback list. */
export function normalizeFallbackAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}
