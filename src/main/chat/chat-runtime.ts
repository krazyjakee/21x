import { createId } from '@paralleldrive/cuid2'
import type { ChatMessage, ChatRuntimeEvent, ChatStopReason, ChatToolCall, ChatUsage } from '../../shared/chat'
import type { ChatProvider, ChatProviderStopReason } from './providers/types'
import { isAbortError } from './providers/types'
import { runTool, validateTools, type ChatToolDefinition } from './tools'

/**
 * The streaming chat loop.
 *
 * One turn = the user's newest message plus however many model calls it takes
 * to answer it. Each model call streams text; when the model asks for tools
 * the runtime runs them and calls the model again with the results, until the
 * model answers in text, the per-turn tool-call limit is reached, the turn is
 * cancelled, or something fails. It is a plain function loop: no planner, no
 * memory, no process — the first token should arrive as fast as the provider
 * can produce it.
 */

export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 8
/** A hard ceiling no caller can raise: a runaway loop must not burn a whole budget. */
export const MAX_TOOL_CALLS_PER_TURN_CAP = 32

export interface ChatTurnOptions {
  provider: ChatProvider
  /** Full history including the newest user message. */
  messages: ChatMessage[]
  system?: string
  tools?: ChatToolDefinition[]
  maxToolCalls?: number
  maxTokens?: number
  /** Optional external signal; the turn also gets its own controller for `cancel()`. */
  signal?: AbortSignal
  /** Managed callers durably commit a completed model/tool step before the
   * next effect. Legacy callers keep the existing in-memory behavior. */
  onStep?: (message: ChatMessage, stepIndex: number) => void | Promise<void>
  /** Context recovery may request a completed action again. Reuse its saved
   * result rather than dispatch the same name/arguments a second time. */
  reuseCompletedTools?: () => boolean
}

export interface ChatTurnResult {
  turnId: string
  stopReason: ChatStopReason
  /** The history after this turn: input messages plus everything the model and tools added. */
  messages: ChatMessage[]
  usage: ChatUsage
  error?: string
}

export interface ChatTurnHandle {
  turnId: string
  /** Resolves when the turn is over, including after cancellation or an error. Never rejects. */
  done: Promise<ChatTurnResult>
  cancel: () => void
}

export type ChatEventListener = (event: ChatRuntimeEvent) => void

/**
 * Providers reject a history where an assistant tool call has no result, and
 * a turn cancelled while its tools run leaves exactly that. Adds a
 * "cancelled" result for every call of the last assistant message that lacks
 * one, so the returned history can be sent again.
 */
function closeUnansweredToolCalls(messages: ChatMessage[], content = 'Cancelled before this tool ran.'): void {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistant = i
      break
    }
  }
  const assistant = messages[lastAssistant]
  if (!assistant || assistant.role !== 'assistant' || !assistant.toolCalls?.length) return
  const answered = new Set(
    messages.slice(lastAssistant + 1).flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : []))
  )
  for (const call of assistant.toolCalls) {
    if (answered.has(call.id)) continue
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content, isError: true })
  }
}

function clampToolLimit(requested: number | undefined): number {
  const value = Number.isFinite(requested) ? Math.floor(requested as number) : DEFAULT_MAX_TOOL_CALLS_PER_TURN
  return Math.max(0, Math.min(MAX_TOOL_CALLS_PER_TURN_CAP, value))
}

function toolIdentity(name: string, input: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
  return `${name}:${JSON.stringify(canonical(input))}`
}

export class ChatRuntime {
  private readonly turns = new Map<string, AbortController>()
  private readonly work = new Set<Promise<ChatTurnResult>>()
  private closing = false
  private providerMutation = false

  /** Turn ids currently running. */
  get activeTurnIds(): string[] {
    return [...this.turns.keys()]
  }

  startTurn(options: ChatTurnOptions, listener: ChatEventListener): ChatTurnHandle {
    if (this.closing) throw new Error('CHAT_RUNTIME_CLOSED')
    if (this.providerMutation) throw new Error('CHAT_PROVIDER_CONFIGURATION_CHANGING')
    const turnId = createId()
    const controller = new AbortController()
    const forward = (): void => controller.abort()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', forward, { once: true })
    }
    this.turns.set(turnId, controller)

    // Never emit before the caller holds the handle: even a synchronous failure
    // (a bad tool list) is reported on a later tick.
    const done = Promise.resolve()
      .then(() => this.run(turnId, options, controller.signal, listener))
      .finally(() => {
        this.turns.delete(turnId)
        options.signal?.removeEventListener('abort', forward)
      })
    this.work.add(done)
    void done.finally(() => this.work.delete(done)).catch(() => {})
    return { turnId, done, cancel: () => controller.abort() }
  }

  /** Aborts a running turn. Unknown ids are ignored so a late cancel is harmless. */
  cancel(turnId: string): boolean {
    const controller = this.turns.get(turnId)
    if (!controller) return false
    controller.abort()
    return true
  }

  cancelAll(): void {
    for (const controller of this.turns.values()) controller.abort()
  }

  /** Reserve synchronously before another provider owner is awaited. Accepted
   * tools and streams remain owned until their raw work settles. */
  beginProviderConfigurationMutation(): { drain(): Promise<void>; release(): void } {
    if (this.closing || this.providerMutation) throw new Error('CHAT_PROVIDER_CONFIGURATION_UNAVAILABLE')
    this.providerMutation = true
    this.cancelAll()
    let released = false
    return {
      drain: async () => { while (this.work.size) await Promise.allSettled([...this.work]) },
      release: () => { if (!released) { released = true; this.providerMutation = false } }
    }
  }

  shutdown(): void {
    this.closing = true
    this.cancelAll()
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Chat shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CHAT_SHUTDOWN_INCOMPLETE')), timeoutMs)
    })
    try { await Promise.race([Promise.allSettled([...this.work]), expired]) }
    finally { if (timer) clearTimeout(timer) }
  }

  private async run(
    turnId: string,
    options: ChatTurnOptions,
    signal: AbortSignal,
    listener: ChatEventListener
  ): Promise<ChatTurnResult> {
    const messages: ChatMessage[] = [...options.messages]
    const hasImages = messages.some((message) => message.role === 'user' && message.images?.length)
    const errorMessage = (error: unknown): string => hasImages
      ? 'The chat request with images failed. Check the selected model and try again.'
      : error instanceof Error ? error.message : String(error)
    const usage: ChatUsage = { inputTokens: 0, outputTokens: 0 }
    const emit = (event: ChatRuntimeEvent): void => {
      if (this.closing) return
      try {
        listener(event)
      } catch (err) {
        console.error('[ChatRuntime] listener threw:', err)
      }
    }
    const finish = (stopReason: ChatStopReason, error?: string): ChatTurnResult => {
      if (error !== undefined) emit({ type: 'error', message: error })
      emit({ type: 'done', stopReason, messages, usage })
      return { turnId, stopReason, messages, usage, ...(error !== undefined ? { error } : {}) }
    }

    let toolsByName: Map<string, ChatToolDefinition>
    try {
      toolsByName = validateTools(options.tools ?? [])
    } catch (err) {
      return finish('error', errorMessage(err))
    }
    const providerTools = [...toolsByName.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    const limit = clampToolLimit(options.maxToolCalls)
    let toolCallsUsed = 0
    let limitReached = false

    // Partial assistant text is kept on cancel so the caller can show what arrived.
    let currentText = ''
    let currentCalls: ChatToolCall[] = []
    let stepIndex = 0
    const completedTools = new Map<string, { content: string; isError?: boolean }>()

    try {
      while (true) {
        if (signal.aborted) throw new DOMException('Chat turn cancelled', 'AbortError')
        currentText = ''
        currentCalls = []
        let stopReason: ChatProviderStopReason = 'other'

        const stream = options.provider.stream(
          {
            system: options.system,
            // A snapshot: the loop keeps appending to `messages`, and a provider
            // (or a test double) that holds on to its request must not see that.
            messages: [...messages],
            tools: providerTools,
            toolChoice: limitReached ? 'none' : 'auto',
            maxTokens: options.maxTokens
          },
          signal
        )
        for await (const event of stream) {
          signal.throwIfAborted()
          if (event.type === 'text_delta') {
            currentText += event.text
            emit(event)
          } else if (event.type === 'tool_call') {
            currentCalls.push({ id: event.id, name: event.name, input: event.input })
          } else {
            stopReason = event.stopReason
            if (event.usage) {
              usage.inputTokens += event.usage.inputTokens
              usage.outputTokens += event.usage.outputTokens
            }
          }
        }

        signal.throwIfAborted()
        const assistant: ChatMessage = { role: 'assistant', content: currentText, ...(currentCalls.length > 0 ? { toolCalls: currentCalls } : {}) }
        messages.push(assistant)
        currentText = ''
        if (options.onStep) await options.onStep(assistant, ++stepIndex)
        const calls = currentCalls
        currentCalls = []

        if (calls.length === 0) {
          if (limitReached) return finish('tool_limit')
          return finish(stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn')
        }
        if (stopReason === 'max_tokens') {
          // A truncated tool input parses as a plausible partial object; never run it.
          if (options.onStep) {
            const before = messages.length
            closeUnansweredToolCalls(messages, 'Tool call was not executed because the model response was truncated.')
            for (const message of messages.slice(before)) await options.onStep(message, ++stepIndex)
          }
          return finish('max_tokens')
        }
        if (limitReached) {
          // Asked for a text answer and still got tool calls: stop rather than loop.
          if (options.onStep) {
            const before = messages.length
            closeUnansweredToolCalls(messages, 'Tool call was not executed because the turn tool limit was reached.')
            for (const message of messages.slice(before)) await options.onStep(message, ++stepIndex)
          }
          return finish('tool_limit')
        }

        for (const call of calls) {
          if (signal.aborted) throw new DOMException('Chat turn cancelled', 'AbortError')
          emit({ type: 'tool_call_start', id: call.id, name: call.name, input: call.input })
          let result: { content: string; isError?: boolean }
          const identity = toolIdentity(call.name, call.input)
          const saved = options.reuseCompletedTools?.() ? completedTools.get(identity) : undefined
          if (saved) {
            toolCallsUsed++
            result = saved
          } else if (toolCallsUsed >= limit) {
            limitReached = true
            result = {
              content: `Tool-call limit reached for this turn (${limit}). Answer with what you have.`,
              isError: true
            }
          } else {
            toolCallsUsed++
            result = await runTool(toolsByName.get(call.name), call.name, call.input, { signal, toolCallId: call.id })
            completedTools.set(identity, result)
          }
          if (!options.onStep) signal.throwIfAborted()
          const isError = result.isError === true
          const tool: ChatMessage = { role: 'tool', toolCallId: call.id, name: call.name, content: result.content, isError }
          messages.push(tool)
          if (options.onStep) await options.onStep(tool, ++stepIndex)
          signal.throwIfAborted()
          emit({ type: 'tool_call_result', id: call.id, name: call.name, content: result.content, isError })
        }
        if (toolCallsUsed >= limit) limitReached = true
      }
    } catch (err) {
      if (options.onStep && currentText) {
        const partial: ChatMessage = { role: 'assistant', content: currentText }
        messages.push(partial)
        currentText = ''
        try { await options.onStep(partial, ++stepIndex) } catch { /* Retain raw history for the caller's final durable flush. */ }
      }
      if (options.onStep) {
        const before = messages.length
        closeUnansweredToolCalls(messages, 'Tool outcome is unconfirmed after interruption. Review the persisted work before repeating this action.')
        for (const message of messages.slice(before)) {
          try { await options.onStep(message, ++stepIndex) } catch { /* The caller still owns the retained result history. */ }
        }
      }
      if (isAbortError(err, signal)) {
        // Calls streamed before the abort never ran, so keep only the text.
        if (currentText) messages.push({ role: 'assistant', content: currentText })
        closeUnansweredToolCalls(messages)
        return finish('cancelled')
      }
      console.error(`[ChatRuntime] turn ${turnId} failed:`, hasImages ? errorMessage(err) : err)
      return finish('error', errorMessage(err))
    }
  }
}
