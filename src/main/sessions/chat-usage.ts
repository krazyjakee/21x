import type { ChatMessage, ChatStopReason, ChatUsage } from '../../shared/chat'
import { contextWindowFor } from './model-windows'
import { calibrate, estimateChatMessageTokens, estimateChatPromptTokens, type ChatPromptShape } from './token-estimator'
import type { SessionUsageInput, UsageOwnerKind } from './usage-store'

/**
 * Turns a finished ChatRuntime turn into one `session_usage` row (#97).
 *
 * The turn's figures are `reported` when every model call reported usage.
 * Otherwise (the Codex subscription never does; an OpenAI-compatible server
 * may not) they are estimated from the text the turn sent and received,
 * scaled by the session's latest calibration ratio.
 *
 * `contextTokens` is the prompt of the turn's last model call. When it is
 * reported, the raw estimate of that same prompt is stored alongside it
 * (`estimatedPromptTokens`) so later estimates in the session can be
 * calibrated against it.
 */

export interface ChatTurnUsageInput {
  ownerKind: UsageOwnerKind
  ownerId: string
  sessionId?: string | null
  turnId: string
  provider: { id: string; model: string }
  /** What every model call of the turn was sent besides the history. */
  prompt: Omit<ChatPromptShape, 'messages'>
  /** The history the turn started from (context messages, including the newest user message). */
  inputMessages: readonly ChatMessage[]
  /** The turn's result: the history after the turn, its usage and stop reason. */
  result: { messages: readonly ChatMessage[]; usage: ChatUsage; stopReason: ChatStopReason }
  /** The session's latest calibration ratio (SessionUsageStore.calibration). */
  calibration?: number | null
}

export function chatTurnUsage(input: ChatTurnUsageInput): SessionUsageInput {
  const { result, prompt } = input
  const usage = result.usage
  const all = result.messages
  const start = input.inputMessages.length

  // Each assistant message the turn added is one model call's answer; the
  // prompt of that call is the history before it.
  let estimatedInput = 0
  let estimatedOutput = 0
  let lastPrompt: number | null = null
  for (let i = start; i < all.length; i++) {
    const message = all[i]
    if (message.role !== 'assistant') continue
    const promptTokens = estimateChatPromptTokens({ ...prompt, messages: all.slice(0, i) })
    estimatedInput += promptTokens
    estimatedOutput += estimateChatMessageTokens(message)
    lastPrompt = promptTokens
  }
  // A call that failed before answering still had a prompt.
  if (lastPrompt === null) {
    lastPrompt = estimateChatPromptTokens({ ...prompt, messages: all })
    estimatedInput = lastPrompt
  }

  const modelCalls = usage.modelCalls ?? null
  const reportedCalls = usage.reportedCalls ?? (usage.inputTokens + usage.outputTokens > 0 ? modelCalls ?? 1 : 0)
  const reported = reportedCalls > 0 && (modelCalls === null || reportedCalls >= modelCalls)
  const window = contextWindowFor(input.provider.model)

  const base = {
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    sessionId: input.sessionId ?? null,
    turnKey: input.turnId,
    engine: 'chat' as const,
    backend: input.provider.id,
    model: input.provider.model || null,
    contextWindow: window.tokens,
    windowSource: window.source,
    modelCalls,
    stopReason: result.stopReason
  }

  if (reported) {
    const contextTokens = usage.lastPromptTokens ?? null
    return {
      ...base,
      source: 'reported',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      contextTokens,
      contextSource: contextTokens === null ? null : 'reported',
      // The pair only calibrates when the last call is the one both figures measured.
      estimatedPromptTokens: contextTokens === null ? null : lastPrompt
    }
  }

  const ratio = input.calibration ?? null
  return {
    ...base,
    source: 'estimated',
    inputTokens: calibrate(estimatedInput, ratio),
    outputTokens: calibrate(estimatedOutput, ratio),
    contextTokens: calibrate(lastPrompt, ratio),
    contextSource: 'estimated',
    estimatedPromptTokens: null
  }
}
