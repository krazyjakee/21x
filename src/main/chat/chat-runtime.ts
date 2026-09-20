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
 * The failed result an unanswered tool call gets when its turn ends, by stop
 * reason. Exported for the tests.
 */
export const UNANSWERED_TOOL_CALL_RESULTS: Record<ChatStopReason, string> = {
  cancelled: 'Cancelled before this tool ran.',
  max_tokens: 'Not run: the reply was cut off before this tool call was complete.',
  tool_limit: 'Not run: the tool-call limit for this turn was reached.',
  error: 'Not run: the turn failed before this tool ran.',
  end_turn: 'Not run: the turn ended before this tool ran.'
}

/**
 * Providers reject a history where an assistant tool call has no result, and
 * the chat shows a call without a result as still running. A turn can end with
 * such calls in four ways: cancelled while its tools run, cut off by
 * `max_tokens`, the model still calling tools after the limit, or a failure
 * between two tools. Adds a failed "not run" result for every call of the last
 * assistant message that lacks one, so the returned history can be sent again
 * and nothing keeps spinning. These are never successful or empty results.
 */
function closeUnansweredToolCalls(messages: ChatMessage[], stopReason: ChatStopReason): void {
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
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: UNANSWERED_TOOL_CALL_RESULTS[stopReason], isError: true })
  }
}

function clampToolLimit(requested: number | undefined): number {
  const value = Number.isFinite(requested) ? Math.floor(requested as number) : DEFAULT_MAX_TOOL_CALLS_PER_TURN
  return Math.max(0, Math.min(MAX_TOOL_CALLS_PER_TURN_CAP, value))
}

export class ChatRuntime {
  private readonly turns = new Map<string, AbortController>()

  /** Turn ids currently running. */
  get activeTurnIds(): string[] {
    return [...this.turns.keys()]
  }

  startTurn(options: ChatTurnOptions, listener: ChatEventListener): ChatTurnHandle {
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

  private async run(
    turnId: string,
    options: ChatTurnOptions,
    signal: AbortSignal,
    listener: ChatEventListener
  ): Promise<ChatTurnResult> {
    const messages: ChatMessage[] = [...options.messages]
    const usage: ChatUsage = { inputTokens: 0, outputTokens: 0 }
    const emit = (event: ChatRuntimeEvent): void => {
      try {
        listener(event)
      } catch (err) {
        console.error('[ChatRuntime] listener threw:', err)
      }
    }
    const finish = (stopReason: ChatStopReason, error?: string): ChatTurnResult => {
      // Every exit, not only cancellation: see closeUnansweredToolCalls.
      closeUnansweredToolCalls(messages, stopReason)
      if (error !== undefined) emit({ type: 'error', message: error })
      emit({ type: 'done', stopReason, messages, usage })
      return { turnId, stopReason, messages, usage, ...(error !== undefined ? { error } : {}) }
    }

    let toolsByName: Map<string, ChatToolDefinition>
    try {
      toolsByName = validateTools(options.tools ?? [])
    } catch (err) {
      return finish('error', err instanceof Error ? err.message : String(err))
    }
    const providerTools = [...toolsByName.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    const limit = clampToolLimit(options.maxToolCalls)
    let toolCallsUsed = 0
    let limitReached = false

    // Partial assistant text is kept on cancel so the caller can show what arrived.
    let currentText = ''
    let currentCalls: ChatToolCall[] = []

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

        messages.push({ role: 'assistant', content: currentText, ...(currentCalls.length > 0 ? { toolCalls: currentCalls } : {}) })
        currentText = ''
        const calls = currentCalls
        currentCalls = []

        if (calls.length === 0) {
          if (limitReached) return finish('tool_limit')
          return finish(stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn')
        }
        if (stopReason === 'max_tokens') {
          // A truncated tool input parses as a plausible partial object; never run it.
          return finish('max_tokens')
        }
        if (limitReached) {
          // Asked for a text answer and still got tool calls: stop rather than loop.
          return finish('tool_limit')
        }

        for (const call of calls) {
          if (signal.aborted) throw new DOMException('Chat turn cancelled', 'AbortError')
          emit({ type: 'tool_call_start', id: call.id, name: call.name, input: call.input })
          let result: { content: string; isError?: boolean }
          if (toolCallsUsed >= limit) {
            limitReached = true
            result = {
              content: `Tool-call limit reached for this turn (${limit}). Answer with what you have.`,
              isError: true
            }
          } else {
            toolCallsUsed++
            result = await runTool(toolsByName.get(call.name), call.name, call.input, { signal, toolCallId: call.id })
          }
          const isError = result.isError === true
          emit({ type: 'tool_call_result', id: call.id, name: call.name, content: result.content, isError })
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.content, isError })
        }
        if (toolCallsUsed >= limit) limitReached = true
      }
    } catch (err) {
      if (isAbortError(err, signal)) {
        // Calls streamed before the abort never ran, so keep only the text.
        if (currentText) messages.push({ role: 'assistant', content: currentText })
        return finish('cancelled')
      }
      console.error(`[ChatRuntime] turn ${turnId} failed:`, err)
      return finish('error', err instanceof Error ? err.message : String(err))
    }
  }
}
