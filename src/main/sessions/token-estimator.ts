import type { ChatProviderRequest } from '../chat/providers/types'

export const CHARS_PER_TOKEN = 3.5
export function estimateTokens(chars: number, correction = 1): number {
  if (!Number.isFinite(chars) || chars < 0) throw new RangeError('Token character count must be nonnegative and finite')
  const factor = Number.isFinite(correction) && correction > 0 ? Math.min(10, Math.max(0.1, correction)) : 1
  return Math.ceil(chars / CHARS_PER_TOKEN * factor)
}

/** Counts text/tool schemas, never base64 image bytes as text tokens. Image
 * modality cost remains estimated until the provider reports real usage. */
export function requestCharacters(request: ChatProviderRequest): number {
  return (request.system?.length ?? 0) + JSON.stringify(request.tools).length + request.messages.reduce((sum, message) => {
    return sum + message.content.length + (message.role === 'assistant' && message.toolCalls ? JSON.stringify(message.toolCalls).length : 0)
  }, 0)
}

export interface ReportedTokenUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}
export interface ReportedUsageFigures {
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens?: number
}

/** Strict adapter/provider normalization. Missing/invalid usage is absent,
 * including an empty object; zero explicitly reported by the provider is real. */
export function reportedTokenUsage(raw: unknown): ReportedTokenUsage | null {
  const figures = reportedUsageFigures(raw)
  return figures && figures.inputTokens !== null && figures.outputTokens !== null
    ? { inputTokens: figures.inputTokens, outputTokens: figures.outputTokens,
        ...(figures.cachedInputTokens !== undefined ? { cachedInputTokens: figures.cachedInputTokens } : {}) } : null
}

export function reportedUsageFigures(raw: unknown): ReportedUsageFigures | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const input = value.inputTokens ?? value.input_tokens ?? value.prompt_tokens ?? value.input
  const output = value.outputTokens ?? value.output_tokens ?? value.completion_tokens ?? value.output
  const valid = (count: unknown): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
  if (!valid(input) && !valid(output)) return null
  const cache = value.cachedInputTokens ?? value.cached_input_tokens ?? value.cache_read_input_tokens
  return { inputTokens: valid(input) ? input : null, outputTokens: valid(output) ? output : null,
    ...(valid(cache) ? { cachedInputTokens: cache } : {}) }
}
