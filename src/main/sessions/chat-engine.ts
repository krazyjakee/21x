import type { ChatMessage } from '../../shared/chat'
import { ChatRuntime, type ChatTurnHandle, type ChatTurnOptions, type ChatEventListener } from '../chat/chat-runtime'
import type { ChatProvider, ChatProviderRequest } from '../chat/providers/types'
import { chatMessageCharacters, managedVerbatimTokens } from '../commander/context'
import { estimateTokens } from './token-estimator'

export function isContextOverflow(error: unknown): boolean {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const text = `${error instanceof Error ? error.message : String(value.message ?? error)} ${value.code ?? ''}`
  return /context_length_exceeded|maximum context length|context window exceeded|prompt is too long|input exceeds.*context|too many tokens/i.test(text)
}

/** The model view can omit older whole turns and shorten already-persisted
 * tool outputs. Calls/results stay paired; user instructions stay intact. */
export function boundChatMessages(messages: ChatMessage[], tokenBudget: number): { messages: ChatMessage[]; shortened: boolean } {
  const limit = Math.max(1, Math.floor(tokenBudget))
  let kept = [...messages]
  let shortened = false
  let omitted = 0
  const withOmission = (): ChatMessage[] => omitted && kept[0]?.role === 'user'
    ? [{ ...kept[0], content: `[${omitted} earlier turns omitted from this request; full history is stored.]\n\n${kept[0].content}` }, ...kept.slice(1)] : kept
  const size = (): number => estimateTokens(withOmission().reduce((sum, message) => sum + chatMessageCharacters(message), 0))
  while (size() > limit) {
    const next = kept.findIndex((message, index) => index > 0 && message.role === 'user')
    if (next < 0) break
    kept = kept.slice(next)
    omitted++
    shortened = true
  }
  if (size() > limit) {
    const marker = '\n[Tool output shortened for context; full result is stored. Do not repeat completed actions.]'
    const tools = kept.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'tool')
      .sort((a, b) => b.message.content.length - a.message.content.length)
    for (const { message, index } of tools) {
      if (size() <= limit) break
      const excessChars = Math.ceil((size() - limit) * 3.5)
      const remaining = Math.max(0, message.content.length - excessChars - marker.length)
      if (remaining + marker.length >= message.content.length) continue
      kept[index] = { ...message, content: `${message.content.slice(0, remaining)}${marker}` }
      shortened = true
    }
  }
  if (size() > limit) throw new Error('The remaining user instruction and completed tool steps cannot safely fit the reduced context budget. Full history is retained; shorten the request before continuing.')
  return { messages: withOmission(), shortened }
}

export interface ChatEngineOptions extends ChatTurnOptions {
  onContextNotice?: (message: string, identity: string) => void
}

/** Managed Commander engine. ChatRuntime keeps sole tool/cancellation
 * ownership; a rejected model context retries once without restarting it. */
export class ChatEngine {
  constructor(private readonly runtime: ChatRuntime) {}
  startTurn(options: ChatEngineOptions, listener: ChatEventListener): ChatTurnHandle {
    const provider = options.provider
    const initialBudget = managedVerbatimTokens(provider.model, provider.contextWindow)
    let budget = initialBudget
    let overflowRetried = false
    let shorteningNotified = false
    const managedProvider: ChatProvider = {
      id: provider.id, model: provider.model, supportsImages: provider.supportsImages, contextWindow: provider.contextWindow,
      async *stream(request: ChatProviderRequest, signal: AbortSignal) {
        while (true) {
          const bounded = boundChatMessages(request.messages, budget)
          if (bounded.shortened && !shorteningNotified) {
            shorteningNotified = true
            options.onContextNotice?.('Model context was reduced; the full conversation and tool results remain stored.', 'context-view')
          }
          let emitted = false
          try {
            for await (const event of provider.stream({ ...request, messages: bounded.messages }, signal)) {
              if (event.type === 'tool_call' || (event.type === 'text_delta' && event.text)) emitted = true
              yield event
            }
            return
          } catch (error) {
            if (signal.aborted || !isContextOverflow(error) || overflowRetried || emitted) throw error
            overflowRetried = true
            budget = Math.max(1, Math.floor(initialBudget / 2))
            options.onContextNotice?.(`The model rejected its context. Retrying once with a ${budget}-token verbatim budget; completed tools will not run again.`, 'overflow-retry')
          }
        }
      }
    }
    return this.runtime.startTurn({ ...options, provider: managedProvider, reuseCompletedTools: () => overflowRetried }, listener)
  }
}
