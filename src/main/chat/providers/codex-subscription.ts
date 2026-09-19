import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatReasoningEffort, ChatUsage } from '../../../shared/chat'
import { findExecutable } from '../../find-executable'
import { applyCodexAuthEnv } from '../../adapters/shared/codex-auth'
import { ChatAbortError, type ChatProvider, type ChatProviderEvent, type ChatProviderRequest } from './types'

/**
 * Commander transport for a Codex agent authenticated with a ChatGPT
 * subscription. The direct OpenAI chat/completions endpoint cannot use those
 * credentials, so this provider delegates the model call to `codex exec`,
 * which reads the same cached login as the normal Codex adapter.
 *
 * Commander remains responsible for its own tools. Codex produces one
 * schema-constrained assistant step; ChatRuntime validates and executes any
 * requested Commander tools, then invokes this provider again with the result.
 */

interface StructuredToolCall {
  id?: string
  name?: string
  input?: unknown
  input_json?: unknown
}

interface StructuredReply {
  response?: unknown
  tool_calls?: unknown
}

export interface CodexExecInput {
  executable: string
  model: string
  reasoningEffort?: ChatReasoningEffort
  prompt: string
  signal: AbortSignal
}

type CodexExecutor = (input: CodexExecInput) => Promise<string>

export interface CodexSubscriptionProviderOptions {
  model: string
  reasoningEffort?: ChatReasoningEffort
  execute?: CodexExecutor
  findExecutable?: () => Promise<string>
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    response: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          // A JSON string keeps this schema strict while still allowing all
          // of the Commander's distinct tool input schemas.
          input_json: { type: 'string' }
        },
        required: ['name', 'input_json'],
        additionalProperties: false
      }
    }
  },
  required: ['response', 'tool_calls'],
  additionalProperties: false
} as const

const MAX_ERROR_CHARS = 4_000

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseReply(raw: string): StructuredReply {
  try {
    const parsed = asObject(JSON.parse(raw))
    if (parsed) return parsed
  } catch {
    // A CLI that could not apply the output schema may still return useful
    // plain text. Keep it as the assistant response instead of losing it.
  }
  return { response: raw, tool_calls: [] }
}

function promptFor(request: ChatProviderRequest): string {
  const tools = request.toolChoice === 'none' ? [] : request.tools
  const instructions = tools.length > 0
    ? [
        'You may answer in response, or request one or more tools in tool_calls.',
        'Only request tools from AVAILABLE_TOOLS and obey each input schema.',
        'Encode each tool input object as JSON in the input_json string.',
        'When tool_calls is not empty, response must be empty: you will see the tool results and write the one reply to the user in the next step.'
      ]
    : [
        'Answer the user in response.',
        'tool_calls must be an empty array because tools are unavailable for this model call.'
      ]

  return [
    'Produce the next assistant step for this chat conversation.',
    'Do not inspect files, run commands, browse, or use any built-in Codex tools.',
    ...instructions,
    '',
    'SYSTEM_INSTRUCTIONS',
    request.system || '',
    '',
    'CONVERSATION_JSON',
    JSON.stringify(request.messages),
    '',
    'AVAILABLE_TOOLS_JSON',
    JSON.stringify(tools)
  ].join('\n')
}

function toolInput(raw: StructuredToolCall): Record<string, unknown> | null {
  const direct = asObject(raw.input)
  if (direct) return direct
  if (typeof raw.input_json !== 'string') return null
  try {
    return asObject(JSON.parse(raw.input_json))
  } catch {
    return null
  }
}

async function findCodexExecutable(): Promise<string> {
  const found = await findExecutable(process.platform === 'win32' ? 'codex.cmd' : 'codex')
  if (!found) throw new Error('Codex CLI not found on PATH')
  return found
}

/** Runs one isolated, non-persistent Codex turn using the existing CLI login. */
async function executeWithCodex(input: CodexExecInput): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), '21x-commander-codex-'))
  const schemaPath = join(dir, 'output-schema.json')
  const outputPath = join(dir, 'last-message.json')
  writeFileSync(schemaPath, JSON.stringify(OUTPUT_SCHEMA), { mode: 0o600 })

  const env: NodeJS.ProcessEnv = { ...process.env }
  // The selected agent says subscription. Strip ambient API keys so they
  // cannot silently switch billing/auth away from the cached ChatGPT login.
  applyCodexAuthEnv(env, { authMethod: 'subscription' })
  const args = [
    'exec',
    '--model', input.model,
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--output-schema', schemaPath,
    '--output-last-message', outputPath,
    '--color', 'never'
  ]
  if (input.reasoningEffort && input.reasoningEffort !== 'max') {
    args.push('--config', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`)
  }
  args.push('-')

  try {
    return await new Promise<string>((resolve, reject) => {
      if (input.signal.aborted) {
        reject(new ChatAbortError())
        return
      }
      const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(input.executable)
      const child = spawn(input.executable, args, {
        cwd: dir,
        env,
        stdio: ['pipe', 'ignore', 'pipe'],
        ...(needsShell ? { shell: true } : {})
      })
      let stderr = ''
      let settled = false
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        input.signal.removeEventListener('abort', abort)
        callback()
      }
      const abort = (): void => {
        child.kill()
        settle(() => reject(new ChatAbortError()))
      }
      input.signal.addEventListener('abort', abort, { once: true })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_ERROR_CHARS) stderr += chunk.toString().slice(0, MAX_ERROR_CHARS - stderr.length)
      })
      child.once('error', (error) => settle(() => reject(error)))
      child.once('close', (code) => {
        settle(() => {
          if (input.signal.aborted) {
            reject(new ChatAbortError())
            return
          }
          if (code !== 0) {
            reject(new Error(stderr.trim() || `Codex CLI exited with code ${code ?? 'unknown'}.`))
            return
          }
          try {
            resolve(readFileSync(outputPath, 'utf8'))
          } catch {
            reject(new Error('Codex CLI ended without a response.'))
          }
        })
      })
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') settle(() => reject(error))
      })
      child.stdin?.end(input.prompt)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export class CodexSubscriptionChatProvider implements ChatProvider {
  readonly id = 'codex-subscription'
  readonly model: string
  private readonly reasoningEffort?: ChatReasoningEffort
  private readonly execute: CodexExecutor
  private readonly resolveExecutable: () => Promise<string>

  constructor(options: CodexSubscriptionProviderOptions) {
    this.model = options.model
    this.reasoningEffort = options.reasoningEffort
    this.execute = options.execute ?? executeWithCodex
    this.resolveExecutable = options.findExecutable ?? findCodexExecutable
  }

  async *stream(request: ChatProviderRequest, signal: AbortSignal): AsyncIterable<ChatProviderEvent> {
    if (signal.aborted) throw new ChatAbortError()
    try {
      const executable = await this.resolveExecutable()
      if (signal.aborted) throw new ChatAbortError()
      const raw = await this.execute({
        executable,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        prompt: promptFor(request),
        signal
      })
      if (signal.aborted) throw new ChatAbortError()

      const reply = parseReply(raw)
      const text = typeof reply.response === 'string' ? reply.response : ''

      const rawCalls = Array.isArray(reply.tool_calls) ? reply.tool_calls as StructuredToolCall[] : []
      const toolCalls: ChatProviderEvent[] = []
      if (request.toolChoice !== 'none') {
        const allowed = new Set(request.tools.map((tool) => tool.name))
        for (const rawCall of rawCalls) {
          const callInput = toolInput(rawCall)
          if (typeof rawCall.name !== 'string' || !allowed.has(rawCall.name) || !callInput) continue
          toolCalls.push({
            type: 'tool_call',
            id: typeof rawCall.id === 'string' && rawCall.id ? rawCall.id : `tool_${randomUUID()}`,
            name: rawCall.name,
            input: callInput
          })
        }
      }
      // The reply belongs after the tool results. Text sent with a tool call
      // is a premature answer that the next step repeats, so drop it.
      if (text && toolCalls.length === 0) yield { type: 'text_delta', text }
      yield* toolCalls
      const usage: ChatUsage = { inputTokens: 0, outputTokens: 0 }
      yield { type: 'message_end', stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn', usage }
    } catch (error) {
      if (signal.aborted || error instanceof ChatAbortError) throw new ChatAbortError()
      throw error
    }
  }
}
