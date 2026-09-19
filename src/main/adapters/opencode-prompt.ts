/**
 * Building and sending OpenCode session.prompt() calls.
 */

import { setTimeout as sleep } from 'timers/promises'
import type { MessagePart, SessionConfig } from './coding-agent-adapter'
import type { OpencodeClient } from './opencode-server'

type PromptBody = import('@opencode-ai/sdk').SessionPromptData['body']

const PROMPT_MAX_RETRIES = 3
const PROMPT_RETRY_BASE_DELAY_MS = 2_000

/** `provider/model` → OpenCode's model reference; undefined when there is no provider prefix. */
function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  const slashIdx = model ? model.indexOf('/') : -1
  if (!model || slashIdx <= 0) return undefined
  return { providerID: model.slice(0, slashIdx), modelID: model.slice(slashIdx + 1) }
}

/**
 * Transient failures worth retrying: the server aborted the session processor
 * (e.g. because of a config push) or the provider is temporarily overloaded.
 */
function isRetryablePromptError(msg: string): boolean {
  const lower = msg.toLowerCase()
  return lower.includes('aborted') || lower.includes('overloaded') || lower.includes('service unavailable')
}

/**
 * The optional `system` field is OpenCode's programmatic channel for the agent
 * settings system prompt. The server APPENDS it to its built-in system prompt
 * (packages/opencode/src/session/llm/request.ts) rather than replacing it, and
 * reads it from the LAST user message of the call, so it is sent on every
 * prompt, not just the first.
 */
export function buildPromptBody(parts: MessagePart[], config: SessionConfig): PromptBody {
  const model = parseModel(config.model)
  return {
    parts: parts as unknown as Array<import('@opencode-ai/sdk').TextPartInput>,
    ...(model && { model }),
    ...(config.tools && { tools: config.tools }),
    ...(config.systemPrompt?.trim() && { system: config.systemPrompt.trim() })
  } as PromptBody
}

/**
 * Runs session.prompt(), retrying transient errors with exponential backoff.
 * The HTTP call stays open until the whole agent loop (tool calls included)
 * completes. Resolves with the error to surface to the user, or null on
 * success or a user abort.
 */
export async function runPromptWithRetry(
  ocClient: OpencodeClient,
  sessionId: string,
  parts: MessagePart[],
  config: SessionConfig,
  signal: AbortSignal
): Promise<string | null> {
  const body = buildPromptBody(parts, config)
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) return null
    if (attempt > 0) console.log(`[OpencodeAdapter] Retry attempt ${attempt}/${PROMPT_MAX_RETRIES} for session ${sessionId}`)

    const promptStartTime = Date.now()
    let errorMsg: string
    let kind: string
    try {
      const result = await ocClient.session.prompt({
        path: { id: sessionId },
        body,
        ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
        signal
      }) as { data?: { parts?: Array<Record<string, unknown>>; info?: { error?: { name?: string; data?: { message?: string } } } } } | undefined
      console.log(`[OpencodeAdapter] Prompt completed for session ${sessionId} after ${Date.now() - promptStartTime}ms`)

      const toolParts = result?.data?.parts?.filter((p) => p.type === 'tool') ?? []
      if (toolParts.length > 0) {
        console.log(`[OpencodeAdapter] Response contains ${toolParts.length} tool part(s):`,
          toolParts.map((p) => ({ tool: p.tool, status: (p.state as Record<string, unknown> | undefined)?.status })))
      }

      // Provider errors (quota, payment required, rate limit) come back in
      // data.info.error WITHOUT a message carrying the text, so polling alone
      // would show a silent idle session.
      const promptError = result?.data?.info?.error
      if (!promptError) return null
      errorMsg = promptError.data?.message || promptError.name || 'Unknown provider error'
      kind = 'provider'
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return null
      errorMsg = err instanceof Error ? err.message : String(err)
      kind = 'HTTP'
    }

    if (!isRetryablePromptError(errorMsg) || attempt >= PROMPT_MAX_RETRIES) {
      console.error(`[OpencodeAdapter] ${kind} prompt error for ${sessionId}: ${errorMsg}`)
      return errorMsg
    }
    const delay = PROMPT_RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
    console.warn(`[OpencodeAdapter] Retryable ${kind} error "${errorMsg}" for ${sessionId}, retrying (${attempt + 1}/${PROMPT_MAX_RETRIES}) after ${delay}ms`)
    await sleep(delay)
  }
}
