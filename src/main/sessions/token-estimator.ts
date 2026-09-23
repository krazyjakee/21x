import type { ChatMessage } from '../../shared/chat'

/**
 * Token estimates for when a backend reports no usage (managed sessions, #97).
 *
 * The base rate is characters ÷ 3.5, plus a small per-message overhead for the
 * role and framing tokens every chat format adds. It is deliberately simple:
 * it runs on every turn and has to agree with no particular tokenizer. The
 * error is corrected by calibration: when a model call both reports its
 * prompt size and had its prompt estimated, the ratio between the two
 * (clamped) scales later estimates in the same session. That is what "reported
 * usage corrects estimates" means here; a reported figure is always kept as
 * reported, never replaced by a calibrated estimate.
 */

export const CHARS_PER_TOKEN = 3.5
/** Role and framing tokens per chat message. */
export const MESSAGE_OVERHEAD_TOKENS = 4
/** A tool definition's framing, on top of its name, description and schema. */
export const TOOL_OVERHEAD_TOKENS = 8
/**
 * An image of unknown size. Vision models charge by pixels, roughly
 * (width × height) / 750 for Claude; a screenshot scaled to the usual
 * 1.15-megapixel limit lands near this figure.
 */
export const IMAGE_TOKENS = 1_600

/** Calibration ratios outside this range mean the two figures measured different things. */
export const MIN_CALIBRATION_RATIO = 0.5
export const MAX_CALIBRATION_RATIO = 3
/** Below this, a prompt is too small for its ratio to say anything about larger ones. */
export const MIN_CALIBRATION_TOKENS = 256

/** Where a usage figure came from. The UI shows "≈" for `estimated`. */
export type UsageSource = 'reported' | 'estimated'

export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0
  return estimateCharTokens(text.length)
}

/** The estimate for a character count, when only the length of the text is kept. */
export function estimateCharTokens(chars: number): number {
  return Number.isFinite(chars) && chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0
}

function jsonTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  try {
    return estimateTextTokens(JSON.stringify(value))
  } catch {
    return 0
  }
}

/** One provider-neutral chat message, with its framing. */
export function estimateChatMessageTokens(message: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content)
  if (message.role === 'user') {
    tokens += (message.images?.length ?? 0) * IMAGE_TOKENS
  } else if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? []) tokens += estimateTextTokens(call.name) + jsonTokens(call.input)
  } else {
    tokens += estimateTextTokens(message.name)
  }
  return tokens
}

export interface ChatPromptShape {
  system?: string
  messages: readonly ChatMessage[]
  tools?: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>
}

/** The prompt of one chat model call: system prompt, tool definitions and history. */
export function estimateChatPromptTokens(prompt: ChatPromptShape): number {
  let tokens = prompt.system ? MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(prompt.system) : 0
  for (const tool of prompt.tools ?? []) {
    tokens += TOOL_OVERHEAD_TOKENS + estimateTextTokens(tool.name) + estimateTextTokens(tool.description) + jsonTokens(tool.inputSchema)
  }
  for (const message of prompt.messages) tokens += estimateChatMessageTokens(message)
  return tokens
}

/**
 * The correction factor a reported prompt size gives for the estimate of the
 * same prompt, or null when the pair says nothing useful (either side missing,
 * the prompt too small, or the ratio so far off that the two figures cannot
 * have measured the same thing).
 */
export function calibrationRatio(reportedTokens: number | null | undefined, estimatedTokens: number | null | undefined): number | null {
  if (!reportedTokens || !estimatedTokens) return null
  if (!Number.isFinite(reportedTokens) || !Number.isFinite(estimatedTokens)) return null
  if (reportedTokens < MIN_CALIBRATION_TOKENS || estimatedTokens < MIN_CALIBRATION_TOKENS) return null
  const ratio = reportedTokens / estimatedTokens
  if (ratio < MIN_CALIBRATION_RATIO || ratio > MAX_CALIBRATION_RATIO) return null
  return ratio
}

/** Scales a raw estimate by a calibration ratio; an unusable ratio leaves it as it is. */
export function calibrate(estimatedTokens: number, ratio: number | null | undefined): number {
  if (!ratio || !Number.isFinite(ratio) || ratio < MIN_CALIBRATION_RATIO || ratio > MAX_CALIBRATION_RATIO) return estimatedTokens
  return Math.round(estimatedTokens * ratio)
}
