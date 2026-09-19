/**
 * Converts Pi RPC data (history, tool results, model lists) into the shared
 * adapter shapes.
 */

import type { SessionMessage } from './coding-agent-adapter'
import { MessagePartType, MessageRole } from './coding-agent-adapter'

export type PiMessage = {
  role?: string
  content?: string | Array<Record<string, unknown>>
  timestamp?: number
  stopReason?: string
  errorMessage?: string
}

type PiProvider = { id: string; name: string; models: Array<{ id: string; name: string }> }

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
    : []
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  return contentBlocks(content)
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('')
}

/** Text of a tool result; non-text blocks are shown as JSON. */
export function piToolResultText(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  return contentBlocks((result as { content?: unknown }).content)
    .map((block) => block.type === 'text' ? String(block.text ?? '') : JSON.stringify(block))
    .join('\n')
}

/** User and assistant text from Pi's `get_messages` history. */
export function convertPiHistory(messages: PiMessage[]): SessionMessage[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    const text = textFromContent(message.content)
    if (!text) return []
    return [{
      id: `pi-history-${message.timestamp ?? index}`,
      role: message.role === 'user' ? MessageRole.USER : MessageRole.ASSISTANT,
      parts: [{ id: `pi-history-part-${message.timestamp ?? index}`, type: MessagePartType.TEXT, text }],
    }]
  })
}

/** Groups `get_available_models` results by provider; the default comes from `get_state`'s model. */
export function piProvidersFromModels(
  models: unknown[],
  defaultModel: unknown,
): { providers: PiProvider[]; default: Record<string, string> } {
  const providers = new Map<string, PiProvider>()
  for (const model of models) {
    if (!model || typeof model !== 'object') continue
    const record = model as Record<string, unknown>
    if (typeof record.provider !== 'string' || typeof record.id !== 'string') continue
    const provider = providers.get(record.provider) ?? { id: record.provider, name: record.provider, models: [] }
    if (!provider.models.some((item) => item.id === record.id)) {
      provider.models.push({ id: record.id, name: typeof record.name === 'string' ? record.name : record.id })
    }
    providers.set(record.provider, provider)
  }
  const { provider, id } = (defaultModel && typeof defaultModel === 'object' ? defaultModel : {}) as Record<string, unknown>
  return {
    providers: Array.from(providers.values()),
    default: typeof provider === 'string' && typeof id === 'string' ? { [provider]: id } : {},
  }
}
