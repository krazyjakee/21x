import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import type { RolloverPolicy, SessionContextScope, SessionContextSnapshot } from './session-context'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const SESSION_CONTEXT_OPERATIONS = ['sessionContext:getSnapshot', 'sessionContext:setPolicy'] as const
export type SessionContextOperation = typeof SESSION_CONTEXT_OPERATIONS[number]
export const SESSION_CONTEXT_SETTING_KEYS = ['sessions.rollover', 'sessions.rollover_thresholds'] as const
export const SESSION_CONTEXT_LIMITS = { frameBytes: 512_000, storedBytes: 512_000, summaryBytes: 65_536, summaries: 10, warnings: 4, warningBytes: 4096, referenceBytes: 4096, projectReferences: 256, lifecycleRows: 100_000 } as const
export const SESSION_CONTEXT_GENERATION_STATES = ['open', 'running', 'closed', 'interrupted'] as const
export const SESSION_CONTEXT_HANDOFF_STATES = ['pending', 'summary', 'memory', 'creating', 'created', 'creation_unconfirmed', 'completed'] as const
export const SESSION_CONTEXT_REASONS = ['context', 'compactions', 'wakeups', 'turns', 'age'] as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const text = (value: unknown, max: number, multiline = false): value is string => typeof value === 'string' && value.length <= max &&
  !(multiline ? /\0/ : /[\u0000-\u001f\u007f]/).test(value) && new TextEncoder().encode(value).length <= max
const reference = (value: unknown): value is string => text(value, SESSION_CONTEXT_LIMITS.referenceBytes) && !!value
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullable = (value: unknown, predicate: (value: unknown) => boolean): boolean => value === null || predicate(value)
const bounded = (value: unknown): value is JsonValue => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).length <= SESSION_CONTEXT_LIMITS.frameBytes

export function isSessionContextScope(value: unknown): value is SessionContextScope {
  return isRecord(value) && hasExactKeys(value, ['kind', 'ownerId']) && (value.kind === 'captain' || value.kind === 'commander') && isDatabaseId(value.ownerId)
}
export function isSessionContextPolicy(value: unknown): value is RolloverPolicy {
  if (!isRecord(value) || !hasExactKeys(value, ['mode', 'contextRatio', 'compactions', 'wakeups', 'turns', 'maxAgeDays']) || !['off', 'observe', 'on'].includes(value.mode as string)) return false
  if (typeof value.contextRatio !== 'number' || !Number.isFinite(value.contextRatio) || value.contextRatio <= 0 || value.contextRatio > 1) return false
  if (typeof value.maxAgeDays !== 'number' || !Number.isFinite(value.maxAgeDays) || value.maxAgeDays <= 0 || value.maxAgeDays > 3650) return false
  return ['compactions', 'wakeups', 'turns'].every(key => integer(value[key]) && (value[key] as number) > 0 && (value[key] as number) <= 1_000_000)
}
export function isSessionContextSnapshot(value: unknown): value is SessionContextSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['scope', 'generation', 'usage', 'counters', 'policy', 'reasons', 'warnings', 'summaries'], ['handoff']) || !isSessionContextScope(value.scope) || !isSessionContextPolicy(value.policy)) return false
  const generation = value.generation
  if (generation !== null && (!isRecord(generation) || !hasExactKeys(generation, ['id', 'key', 'engine', 'state', 'createdAt', 'backendId']) || !reference(generation.id) || !reference(generation.key) ||
    !['chat', 'adapter'].includes(generation.engine as string) || !SESSION_CONTEXT_GENERATION_STATES.includes(generation.state as typeof SESSION_CONTEXT_GENERATION_STATES[number]) || !integer(generation.createdAt) || !nullable(generation.backendId, reference))) return false
  const usage = value.usage
  if (!isRecord(usage) || !hasExactKeys(usage, ['tokens', 'source', 'contextWindow', 'model', 'observedAt']) || !nullable(usage.tokens, integer) || !['reported', 'estimated', 'unknown'].includes(usage.source as string) ||
    !nullable(usage.contextWindow, item => integer(item) && item > 0) || !nullable(usage.model, item => text(item, SESSION_CONTEXT_LIMITS.referenceBytes)) || !nullable(usage.observedAt, integer) ||
    (usage.source === 'unknown' ? usage.tokens !== null || usage.observedAt !== null : usage.tokens === null)) return false
  if (!isRecord(value.counters) || !hasExactKeys(value.counters, ['compactions', 'wakeups', 'turns', 'ageMs']) || !Object.values(value.counters).every(integer)) return false
  if (!Array.isArray(value.reasons) || value.reasons.length > SESSION_CONTEXT_REASONS.length || new Set(value.reasons).size !== value.reasons.length || !value.reasons.every(reason => SESSION_CONTEXT_REASONS.includes(reason))) return false
  if (!Array.isArray(value.warnings) || value.warnings.length > SESSION_CONTEXT_LIMITS.warnings || !value.warnings.every(item => text(item, SESSION_CONTEXT_LIMITS.warningBytes, true))) return false
  if (!Array.isArray(value.summaries) || value.summaries.length > SESSION_CONTEXT_LIMITS.summaries || !value.summaries.every(summary => isRecord(summary) && hasExactKeys(summary, ['id', 'content', 'kind', 'createdAt', 'source']) &&
    reference(summary.id) && text(summary.content, SESSION_CONTEXT_LIMITS.summaryBytes, true) && ['summary', 'rollover', 'recovery'].includes(summary.kind as string) && integer(summary.createdAt) &&
    (summary.source === null || summary.source === 'model' || summary.source === 'fallback'))) return false
  const handoff = value.handoff
  if (handoff !== undefined && handoff !== null && (!isRecord(handoff) || !hasExactKeys(handoff, ['id', 'state']) || !reference(handoff.id) || !SESSION_CONTEXT_HANDOFF_STATES.includes(handoff.state as typeof SESSION_CONTEXT_HANDOFF_STATES[number]))) return false
  return bounded(value)
}
export interface SessionContextCodec<K extends SessionContextOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends SessionContextOperation>(operation: K): SessionContextCodec<K> {
  const snapshot = operation === 'sessionContext:getSnapshot', key = snapshot ? 'scope' : 'policy'
  const input = snapshot ? isSessionContextScope : isSessionContextPolicy
  const result = snapshot ? isSessionContextSnapshot : isSessionContextPolicy
  const validateArguments = (value: unknown): value is unknown[] => Array.isArray(value) && value.length === 1 && input(value[0]) && bounded(value)
  return {
    validateArguments,
    encodeArguments(args) { if (!validateArguments(args)) return fail('INVALID_ARGUMENTS'); return { [key]: args[0] } as JsonValue },
    decodeArguments(value) {
      if (!isRecord(value) || !hasExactKeys(value, [key]) || !bounded(value) || !input(value[key])) return fail('INVALID_ARGUMENTS')
      return [value[key]] as DesktopCommandMap[K]['apiArguments']
    },
    encodeResult(value) { if (!result(value) || !bounded(value)) return fail('INVALID_RESULT'); return { defined: true, value } },
    decodeResult(value) { if (!result(value) || !bounded(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateResult: result,
    validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && result(value.value) && bounded(value.value) }
  }
}
export const SESSION_CONTEXT_CODECS = { 'sessionContext:getSnapshot': codec('sessionContext:getSnapshot'), 'sessionContext:setPolicy': codec('sessionContext:setPolicy') }
