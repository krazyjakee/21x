/**
 * Reads and repairs Claude Code's on-disk session history
 * (~/.claude/projects/<encoded-workspace>/<sessionId>.jsonl).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { MessagePart, SessionMessage } from './coding-agent-adapter'
import { MessagePartType, MessageRole } from './coding-agent-adapter'
import { buildToolTitle, normalizeTodos } from './claude-code-message-converter'
import { parseMaybeJson } from './shared/parse-maybe-json'

const MAX_PLAN_CHARS = 50_000
const MAX_TOOL_OUTPUT_CHARS = 2_000

/**
 * Claude Code session IDs are random (version 4) UUIDs. The version matters:
 * Codex thread IDs are version 7 UUIDs, and accepting one here "resumed" a
 * Codex conversation that then failed only when the first message was sent.
 */
export function isValidClaudeSessionId(sessionId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
}

function sessionFilePath(sessionId: string, workspaceDir: string): string {
  // The CLI encodes workspace paths by replacing every non-alphanumeric/non-hyphen char with '-'
  const encodedWorkspace = workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-')
  return join(homedir(), '.claude', 'projects', encodedWorkspace, `${sessionId}.jsonl`)
}

/** Plain-text user prompts are stored with string content; only block arrays are inspected. */
function contentBlocks<T>(content: unknown): T[] {
  return Array.isArray(content) ? content : []
}

function hasEmptyTextBlock(entry: { message?: { content?: unknown } }): boolean {
  return contentBlocks<{ type?: string; text?: string }>(entry.message?.content).some((part) =>
    part.type === 'text' && (!part.text || part.text.trim() === '')
  )
}

/**
 * Removes user/assistant messages with empty text blocks, which make the API
 * reject a resumed session. Never throws: resume proceeds even if cleaning fails.
 */
export function cleanSessionFile(sessionId: string, workspaceDir: string): void {
  const sessionFile = sessionFilePath(sessionId, workspaceDir)
  try {
    if (!existsSync(sessionFile)) {
      console.log(`[ClaudeCodeAdapter] Session file not found, skipping clean: ${sessionFile}`)
      return
    }

    const lines = readFileSync(sessionFile, 'utf-8').trim().split('\n')
    const cleanedLines = lines.filter((line) => {
      const entry = JSON.parse(line)
      if (entry.type !== 'user' && entry.type !== 'assistant') return true
      if (!hasEmptyTextBlock(entry)) return true
      console.log(`[ClaudeCodeAdapter] Removing message with empty text block: ${entry.uuid}`)
      return false
    })

    writeFileSync(sessionFile, cleanedLines.join('\n') + '\n', 'utf-8')
    console.log(`[ClaudeCodeAdapter] Session file cleaned: ${lines.length} -> ${cleanedLines.length} lines`)
  } catch (error) {
    console.warn(`[ClaudeCodeAdapter] Failed to clean session file:`, error)
  }
}

const isPlanTool = (name?: string): boolean => name === 'ExitPlanMode' || name === 'EnterPlanMode'

/** Plan tools echo a confirmation prompt ("Exit plan mode?") that is not useful output. */
function toolResultOutput(toolName: string, content: unknown): string | undefined {
  const raw = content ? String(content) : undefined
  if (!raw) return undefined
  if (!isPlanTool(toolName)) return raw.slice(0, MAX_TOOL_OUTPUT_CHARS)
  return /^(exit|enter) plan mode\??$/i.test(raw.trim()) ? undefined : raw.slice(0, MAX_PLAN_CHARS)
}

type ContentBlock = {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

function toolUsePart(block: ContentBlock, partId: string): MessagePart {
  const rawInput = block.input as Record<string, unknown> | undefined
  const toolName = block.name || 'unknown'
  const tool: NonNullable<MessagePart['tool']> = {
    name: toolName,
    status: 'pending',
    title: buildToolTitle(toolName, rawInput),
    input: rawInput ? JSON.stringify(rawInput, null, 2) : undefined,
  }

  let partType: string = MessagePartType.TOOL
  const todos = normalizeTodos(rawInput?.todos)
  if (todos) {
    partType = 'todowrite'
    tool.todos = todos
  }
  const questions = parseMaybeJson(rawInput?.questions)
  if (Array.isArray(questions) && questions.length > 0) {
    partType = 'question'
    tool.questions = questions
  }
  // ExitPlanMode carries the plan in input.plan, not in the tool_result.
  if (isPlanTool(toolName)) {
    partType = 'planreview'
    tool.title = toolName === 'EnterPlanMode' ? 'Enter plan mode' : 'Exit plan mode'
    if (toolName === 'ExitPlanMode' && rawInput?.plan) {
      tool.output = String(rawInput.plan).slice(0, MAX_PLAN_CHARS)
    }
  }
  return { id: partId, type: partType as MessagePartType, tool }
}

/**
 * Loads the persisted conversation. Throws SESSION_FILE_NOT_FOUND when the file
 * is missing; other failures are logged and yield [].
 */
export function loadSessionHistory(sessionId: string, workspaceDir: string): SessionMessage[] {
  const sessionFile = sessionFilePath(sessionId, workspaceDir)
  console.log(`[ClaudeCodeAdapter] Loading session history from: ${sessionFile}`)

  if (!existsSync(sessionFile)) {
    console.warn(`[ClaudeCodeAdapter] Session file not found: ${sessionFile}`)
    throw new Error('SESSION_FILE_NOT_FOUND: The Claude Code session file does not exist. This may happen if the session was deleted or never synced.')
  }

  try {
    const lines = readFileSync(sessionFile, 'utf-8').trim().split('\n')
    const messages: SessionMessage[] = []
    // tool_use_id → tool, so a later tool_result merges into its tool_use part
    const toolUseParts = new Map<string, NonNullable<MessagePart['tool']>>()

    for (const line of lines) {
      const entry = JSON.parse(line)
      if (entry.type !== 'user' && entry.type !== 'assistant') continue

      const message: SessionMessage = {
        id: entry.uuid,
        role: entry.type === 'user' ? MessageRole.USER : MessageRole.ASSISTANT,
        parts: []
      }

      // Part IDs use the stable API message ID, matching convertSDKMessageToParts,
      // so dedup state from history prevents re-emission during streaming replay.
      const stableId = entry.message?.id || entry.uuid || entry.type
      const blocks = contentBlocks<ContentBlock>(entry.message?.content)
      blocks.forEach((block, blockIdx) => {
        if (block.type === 'text') {
          if (!block.text || block.text.trim() === '') return
          message.parts.push({ id: `${stableId}-text-${blockIdx}`, type: MessagePartType.TEXT, text: block.text, content: block.text })
        } else if (block.type === 'thinking') {
          if (!block.thinking || block.thinking.trim() === '') return
          message.parts.push({ id: `${stableId}-thinking-${blockIdx}`, type: MessagePartType.REASONING, text: block.thinking, content: block.thinking })
        } else if (block.type === 'tool_use') {
          const part = toolUsePart(block, block.id ? `tool-${block.id}` : `${stableId}-tool_use-${blockIdx}`)
          message.parts.push(part)
          if (block.id) toolUseParts.set(block.id, part.tool!)
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          const matchingTool = toolUseParts.get(block.tool_use_id)
          if (matchingTool) {
            matchingTool.status = 'success'
            matchingTool.output = toolResultOutput(matchingTool.name, block.content)
          }
        }
      })

      if (message.parts.length > 0) {
        // Keep the original event time so replay and the durable projection
        // show real timestamps instead of "now" on every reload.
        const receivedAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN
        if (!Number.isNaN(receivedAt)) {
          for (const part of message.parts) part.receivedAt = receivedAt
        }
        messages.push(message)
      }
    }

    console.log(`[ClaudeCodeAdapter] Loaded ${messages.length} messages from session history`)
    return messages
  } catch (error: unknown) {
    console.warn(`[ClaudeCodeAdapter] Failed to load session history:`, error instanceof Error ? error.message : String(error))
    return []
  }
}
