/**
 * Converts Claude Agent SDK stream messages into transcript parts.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessagePart } from './coding-agent-adapter'
import { MessagePartType } from './coding-agent-adapter'
import { parseMaybeJson } from './shared/parse-maybe-json'

export enum ClaudeSystemSubtype {
  INIT = 'init',
  TASK_STARTED = 'task_started',
  TASK_PROGRESS = 'task_progress',
  TASK_NOTIFICATION = 'task_notification',
  TASK_UPDATED = 'task_updated',
  /** Authoritative in-flight background-task list. Emitted by the CLI but NOT
   *  surfaced by SDK >= 0.3.x (absent from the SDKMessage union) — older bundled
   *  SDKs (e.g. 0.2.x) do pass it through, so it is handled defensively both as a
   *  status source and as a transcript-suppression case. */
  BACKGROUND_TASKS_CHANGED = 'background_tasks_changed',
  STATUS = 'status',
  THINKING_TOKENS = 'thinking_tokens',
}

/** Todo items from a TodoWrite input, each given an id (the SDK omits it); null when there are none. */
export function normalizeTodos(rawTodos: unknown): Array<Record<string, unknown>> | null {
  const todos = parseMaybeJson(rawTodos)
  if (!Array.isArray(todos) || todos.length === 0) return null
  return todos.map((t: Record<string, unknown>, i: number) => ({
    id: t.id || `todo-${i}`,
    content: t.content || '',
    status: t.status || 'pending',
    priority: t.priority,
  }))
}

/**
 * Error text of an error `result` message: `result` (string), `errors` (array)
 * or `error` (string), then a JSON dump of an object `result`. Null when none is set.
 */
export function resultErrorText(raw: Record<string, unknown>): string | null {
  const resultField = raw.result
  if (typeof resultField === 'string' && resultField.length > 0) return resultField
  if (Array.isArray(raw.errors) && raw.errors.length > 0) return raw.errors.map(String).join('; ')
  if (typeof raw.error === 'string' && raw.error) return raw.error
  if (resultField && typeof resultField === 'object') return JSON.stringify(resultField)
  return null
}

export function convertSDKMessageToParts(
  msg: SDKMessage,
  seenPartIds: Set<string>,
  partContentLengths: Map<string, string>
): MessagePart[] {
  const parts: MessagePart[] = []
  const msgWithProps = msg as {
    type?: string
    uuid?: string
    content?: unknown[]
    message?: {
      content?: unknown[]
      text?: string
      role?: string
      id?: string
    }
    tool_use_id?: string
    tool_name?: string
    status?: string | null
    output?: unknown
    subtype?: string
    text?: string
    tool_use_result?: {
      content?: string
      filenames?: string[]
      mode?: string
      durationMs?: number
    }
    // SDKToolProgressMessage fields
    elapsed_time_seconds?: number
    parent_tool_use_id?: string | null
    // SDKThinkingTokensMessage fields
    estimated_tokens?: number
    estimated_tokens_delta?: number
    session_id?: string
    // SDKTaskNotificationMessage / SDKTaskProgressMessage / SDKTaskStartedMessage fields
    task_id?: string
    summary?: string
    output_file?: string
    description?: string
    last_tool_name?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
    task_type?: string
    prompt?: string
    isApiErrorMessage?: boolean
  }

  // ── Skip messages from inside a subtask ──
  // Messages originating from a subagent task have a non-null parent_tool_use_id.
  // These would otherwise leak as top-level user messages / tool calls in the
  // transcript.  The task_started / task_progress / task_notification events
  // already provide the high-level summary, so we suppress the inner messages.
  // Exception: system messages (task_started, task_progress, task_notification,
  // status) do NOT carry parent_tool_use_id and must always be processed.
  if (msgWithProps.parent_tool_use_id) {
    return parts
  }

  if (msgWithProps.type === 'assistant' || msgWithProps.type === 'assistant_message') {
    // Content is nested inside message.content for Claude Code SDK format
    const content = msgWithProps.message?.content || (Array.isArray(msgWithProps.content) ? msgWithProps.content : [])
    const partType = msgWithProps.isApiErrorMessage ? MessagePartType.ERROR : MessagePartType.TEXT

    // Use the stable API message ID (e.g. msg_01FG7...) for dedup, not the streaming UUID.
    // Claude Code sends multiple streaming chunks with different UUIDs but the same API message ID
    // and the same text block, which would otherwise create duplicate text bubbles in the UI.
    const stableId = msgWithProps.message?.id || msgWithProps.uuid || msgWithProps.type

    for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
      const block = content[blockIdx]
      const blockWithProps = block as { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; id?: string }
      // For text blocks (no id), use stable message ID + block index for consistent dedup.
      // For tool_use blocks, blockWithProps.id is the tool_use_id which is already stable.
      const partId = `${stableId}-${blockWithProps.type}-${blockWithProps.id || blockIdx}`

      if (blockWithProps.type === 'text') {
        const text = blockWithProps.text || ''
        if (seenPartIds.has(partId)) {
          // Check if text content has grown since last seen (streaming update).
          // Without this, the first chunk (possibly empty/partial) gets recorded
          // and all subsequent chunks with the actual text are silently dropped,
          // causing missing assistant responses in the UI.
          const previousLength = partContentLengths.get(partId)
          if (previousLength !== undefined && String(text.length) !== previousLength && text.length > 0) {
            partContentLengths.set(partId, String(text.length))
            parts.push({
              id: partId,
              type: partType,
              text,
              update: true,
            })
          }
          continue
        }
        seenPartIds.add(partId)
        partContentLengths.set(partId, String(text.length))
        parts.push({
          id: partId,
          type: partType,
          text,
        })
      } else if (blockWithProps.type === 'thinking') {
        const thinking = blockWithProps.thinking || ''
        if (seenPartIds.has(partId)) {
          const previousLength = partContentLengths.get(partId)
          if (previousLength !== undefined && String(thinking.length) !== previousLength && thinking.length > 0) {
            partContentLengths.set(partId, String(thinking.length))
            parts.push({
              id: partId,
              type: MessagePartType.REASONING,
              text: thinking,
              role: 'assistant',
              update: true,
            })
          }
          continue
        }
        seenPartIds.add(partId)
        partContentLengths.set(partId, String(thinking.length))
        parts.push({
          id: partId,
          type: MessagePartType.REASONING,
          text: thinking,
          role: 'assistant',
        })
      } else if (seenPartIds.has(partId)) {
        continue
      } else if (blockWithProps.type === 'tool_use') {
        seenPartIds.add(partId)
        const toolName = blockWithProps.name || 'unknown'
        const rawInput = blockWithProps.input as Record<string, unknown> | undefined
        const input = rawInput ? JSON.stringify(rawInput, null, 2) : undefined
        const toolUseId = blockWithProps.id || ''

        // Keyed by tool_use_id so the tool result can update this part.
        const toolPartId = `tool-${toolUseId}`
        if (seenPartIds.has(toolPartId)) continue
        seenPartIds.add(toolPartId)

        const title = buildToolTitle(toolName, rawInput)

        const questions = parseMaybeJson(rawInput?.questions)
        if (Array.isArray(questions) && questions.length > 0) {
          partContentLengths.set(toolPartId, `pending:${toolName}`)
          parts.push({
            id: toolPartId,
            type: 'question' as MessagePartType,
            content: title || 'Question',
            tool: { name: toolName, status: 'pending', title, input, questions },
          })
          continue
        }

        const normalizedTodos = normalizeTodos(rawInput?.todos)
        if (normalizedTodos) {
          partContentLengths.set(toolPartId, `pending:${toolName}`)
          parts.push({
            id: toolPartId,
            type: 'todowrite' as MessagePartType,
            content: title || 'Todo List',
            tool: { name: toolName, status: 'pending', title, input, todos: normalizedTodos },
          })
          continue
        }

        // ExitPlanMode carries the plan in input.plan, not in the tool result.
        if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
          const planTitle = toolName === 'EnterPlanMode' ? 'Enter plan mode' : 'Exit plan mode'
          const planContent = toolName === 'ExitPlanMode' && rawInput?.plan
            ? String(rawInput.plan).slice(0, 50000) : undefined
          partContentLengths.set(toolPartId, `pending:${toolName}`)
          parts.push({
            id: toolPartId,
            type: 'planreview' as MessagePartType,
            content: planTitle,
            tool: { name: toolName, status: 'pending', title: planTitle, input, output: planContent },
          })
          continue
        }

        partContentLengths.set(toolPartId, `pending:${toolName}`)
        parts.push({
          id: toolPartId,
          type: MessagePartType.TOOL,
          content: title ? `${toolName} — ${title}` : toolName,
          tool: { name: toolName, status: 'pending', title, input },
        })
      }
    }
  } else if (msgWithProps.type === 'user' || msgWithProps.type === 'user_message') {
    const content = msgWithProps.message?.content || (Array.isArray(msgWithProps.content) ? msgWithProps.content : [])

    for (const block of content) {
      const blockWithProps = block as {
        type?: string
        tool_use_id?: string
        content?: string
        text?: string
      }

      if (blockWithProps.type === 'text' && blockWithProps.text) {
        const partId = `${msgWithProps.uuid || 'user'}-text`
        if (!seenPartIds.has(partId)) {
          seenPartIds.add(partId)
          const text = blockWithProps.text
          partContentLengths.set(partId, String(text.length))
          parts.push({
            id: partId,
            type: MessagePartType.TEXT,
            text,
            role: 'user',
          })
        }
      } else if (blockWithProps.type === 'tool_result' && blockWithProps.tool_use_id) {
        const toolPartId = `tool-${blockWithProps.tool_use_id}`
        const resultContent = blockWithProps.content || ''

        const previousContent = partContentLengths.get(toolPartId)
        // Plan mode tools should not be truncated (cap at 50K for safety)
        const isPlanReview = previousContent?.endsWith(':ExitPlanMode') || previousContent?.endsWith(':EnterPlanMode')
        // Filter out confirmation prompts like "Exit plan mode?" / "Enter plan mode?" — not useful content
        const sanitizedResult = isPlanReview && /^(exit|enter) plan mode\??$/i.test(resultContent.trim())
          ? '' : resultContent
        const outputContent = isPlanReview
          ? sanitizedResult.slice(0, 50000)
          : resultContent.slice(0, 2000)

        if (previousContent) {
          const toolName = previousContent.split(':')[1] || 'tool'
          partContentLengths.set(toolPartId, `success:${resultContent.length}`)
          // For plan review: don't send empty output (would overwrite plan from input.plan)
          parts.push({
            id: toolPartId,
            type: isPlanReview ? ('planreview' as MessagePartType) : MessagePartType.TOOL,
            content: isPlanReview ? (toolName === 'EnterPlanMode' ? 'Enter plan mode' : 'Exit plan mode') : `Tool completed`,
            tool: {
              name: toolName,
              status: 'success',
              ...(outputContent ? { output: outputContent } : {}),
            },
            update: true, // Mark as update to existing message
          })
        } else {
          // Tool call wasn't seen yet, send result only
          if (!seenPartIds.has(toolPartId)) {
            seenPartIds.add(toolPartId)
            partContentLengths.set(toolPartId, `success:${resultContent.length}`)
            parts.push({
              id: toolPartId,
              type: isPlanReview ? ('planreview' as MessagePartType) : MessagePartType.TOOL,
              content: isPlanReview ? 'Plan mode' : `Tool result`,
              tool: {
                name: isPlanReview ? 'ExitPlanMode' : 'tool',
                status: 'success',
                output: outputContent,
              },
            })
          }
        }
      }
    }
  } else if (msgWithProps.type === 'tool_use_summary') {
    const partId = `tool-${msgWithProps.tool_use_id || Date.now()}`
    const toolName = msgWithProps.tool_name || 'unknown'
    const status = msgWithProps.status || 'unknown'
    const isPlanReview = toolName === 'ExitPlanMode' || toolName === 'EnterPlanMode'
    const rawOutput = msgWithProps.output ? String(msgWithProps.output) : undefined
    // Filter out confirmation prompts like "Exit/Enter plan mode?"
    const sanitizedOutput = isPlanReview && rawOutput && /^(exit|enter) plan mode\??$/i.test(rawOutput.trim())
      ? undefined : rawOutput
    const output = sanitizedOutput
      ? (isPlanReview ? sanitizedOutput.slice(0, 50000) : sanitizedOutput.slice(0, 2000))
      : undefined
    const partType = isPlanReview ? ('planreview' as MessagePartType) : MessagePartType.TOOL
    const planLabel = toolName === 'EnterPlanMode' ? 'Enter plan mode' : 'Exit plan mode'

    if (seenPartIds.has(partId)) {
      // Tool_use was already emitted — send an UPDATE to merge the result into it
      partContentLengths.set(partId, `${status}:${output?.length || 0}`)
      parts.push({
        id: partId,
        type: partType,
        content: isPlanReview ? planLabel : `${toolName} — ${status}`,
        tool: { name: toolName, status, output },
        update: true,
      })
    } else {
      seenPartIds.add(partId)
      partContentLengths.set(partId, `${status}:${output?.length || 0}`)
      parts.push({
        id: partId,
        type: partType,
        content: isPlanReview ? planLabel : `${toolName} — ${status}`,
        tool: { name: toolName, status, output },
      })
    }
  } else if (msgWithProps.type === 'tool_progress') {
    // Periodic progress for a running tool: shows elapsed time on its part.
    const toolUseId = msgWithProps.tool_use_id
    if (toolUseId) {
      const partId = `tool-${toolUseId}`
      const toolName = msgWithProps.tool_name || 'tool'
      const elapsed = msgWithProps.elapsed_time_seconds ?? 0
      const elapsedLabel = elapsed >= 60
        ? `${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s`
        : `${Math.round(elapsed)}s`

      if (seenPartIds.has(partId)) {
        parts.push({
          id: partId,
          type: MessagePartType.TOOL,
          tool: {
            name: toolName,
            status: 'running',
            title: `Running… ${elapsedLabel}`,
          },
          update: true,
        })
      }
    }
  } else if (msgWithProps.type === 'result') {
    const resultMsg = msg as Record<string, unknown>
    if (resultMsg.is_error) {
      const errorText = resultErrorText(resultMsg) ?? 'An error occurred (no details available)'

      const partId = `result-error-${msgWithProps.uuid || Date.now()}`
      if (!seenPartIds.has(partId)) {
        seenPartIds.add(partId)
        partContentLengths.set(partId, String(errorText.length))
        parts.push({
          id: partId,
          type: MessagePartType.ERROR,
          text: errorText,
          role: 'system',
        })
      }
    } else {
      // Safety net: when the first streaming chunk had empty text and no later
      // chunk updated it, the result message is the only source of the final
      // response. Emitted only if no non-empty assistant text was shown.
      const resultText = typeof resultMsg.result === 'string' ? resultMsg.result : ''
      if (resultText) {
        let hasNonEmptyText = false
        for (const [pid, len] of partContentLengths) {
          if (pid.includes('-text-') && parseInt(len, 10) > 0) {
            hasNonEmptyText = true
            break
          }
        }
        if (!hasNonEmptyText) {
          const partId = `result-text-${msgWithProps.uuid || Date.now()}`
          if (!seenPartIds.has(partId)) {
            seenPartIds.add(partId)
            partContentLengths.set(partId, String(resultText.length))
            parts.push({
              id: partId,
              type: MessagePartType.TEXT,
              text: resultText,
            })
          }
        }
      }
    }
  } else if (msgWithProps.type === 'system') {
    if (msgWithProps.subtype === ClaudeSystemSubtype.INIT) {
      return parts
    }

    if (msgWithProps.subtype === ClaudeSystemSubtype.TASK_STARTED) {
      const taskId = msgWithProps.task_id || msgWithProps.uuid || `task-${Date.now()}`
      const partId = `task-${taskId}`
      if (!seenPartIds.has(partId)) {
        seenPartIds.add(partId)
        partContentLengths.set(partId, `started:${taskId}`)
        parts.push({
          id: partId,
          type: MessagePartType.TASK_PROGRESS,
          content: msgWithProps.description || 'Subagent task started',
          taskProgress: {
            taskId,
            status: 'started',
            description: msgWithProps.description || '',
          }
        })
      }
      return parts
    }

    // SDKTaskProgressMessage — periodic progress updates for running subagent tasks
    if (msgWithProps.subtype === ClaudeSystemSubtype.TASK_PROGRESS) {
      const taskId = msgWithProps.task_id || `task-${Date.now()}`
      const partId = `task-${taskId}`
      const usage = msgWithProps.usage
      const alreadySeen = seenPartIds.has(partId)

      if (!alreadySeen) {
        seenPartIds.add(partId)
      }
      partContentLengths.set(partId, `running:${taskId}`)
      parts.push({
        id: partId,
        type: MessagePartType.TASK_PROGRESS,
        content: msgWithProps.description || 'Subagent task in progress',
        taskProgress: {
          taskId,
          status: 'running',
          description: msgWithProps.description || '',
          lastToolName: msgWithProps.last_tool_name,
          summary: msgWithProps.summary,
          usage,
        },
        update: alreadySeen,
      })
      return parts
    }

    // SDKTaskNotificationMessage — subtask completion notifications
    if (msgWithProps.subtype === ClaudeSystemSubtype.TASK_NOTIFICATION) {
      const taskId = msgWithProps.task_id || `task-${Date.now()}`
      const partId = `task-${taskId}`
      const taskStatus = (msgWithProps.status || 'completed') as 'completed' | 'failed' | 'stopped'
      const summary = msgWithProps.summary || `Task ${taskStatus}`
      const usage = msgWithProps.usage
      const alreadySeen = seenPartIds.has(partId)

      if (!alreadySeen) {
        seenPartIds.add(partId)
      }
      partContentLengths.set(partId, `${taskStatus}:${taskId}`)
      parts.push({
        id: partId,
        type: MessagePartType.TASK_PROGRESS,
        content: summary,
        taskProgress: {
          taskId,
          status: taskStatus,
          description: summary,
          summary,
          usage,
        },
        update: alreadySeen,
      })
      return parts
    }

    // ── Internal background-task bookkeeping — never rendered ──
    // `task_updated` carries wire-level status patches and `background_tasks_changed`
    // carries the in-flight list. Both are consumed by trackBackgroundTask(); the
    // user-visible progress is already covered by task_started / task_progress /
    // task_notification. Without this they fall through to the generic system
    // handler below, which pushes the raw subtype string as a text bubble —
    // spamming the transcript with literal "task_updated" /
    // "background_tasks_changed" messages between every subagent update.
    if (
      msgWithProps.subtype === ClaudeSystemSubtype.TASK_UPDATED ||
      msgWithProps.subtype === ClaudeSystemSubtype.BACKGROUND_TASKS_CHANGED
    ) {
      return parts
    }

    // SDKStatusMessage — transient status indicators (e.g. 'compacting')
    if (msgWithProps.subtype === ClaudeSystemSubtype.STATUS) {
      // null status means "cleared" — skip
      if (!msgWithProps.status) return parts
      const partId = `system-status-${msgWithProps.uuid || Date.now()}`
      if (!seenPartIds.has(partId)) {
        seenPartIds.add(partId)
        const statusLabel = msgWithProps.status === 'compacting'
          ? 'Compacting conversation history…'
          : String(msgWithProps.status)
        partContentLengths.set(partId, String(statusLabel.length))
        parts.push({
          id: partId,
          type: 'system-status' as MessagePartType,
          content: statusLabel,
          role: 'system',
        })
      }
      return parts
    }

    // SDKThinkingTokensMessage — reasoning/thinking token updates from Claude Code
    if (msgWithProps.subtype === ClaudeSystemSubtype.THINKING_TOKENS) {
      const partId = `thinking-tokens-${msgWithProps.session_id || 'session'}`
      const alreadySeen = seenPartIds.has(partId)
      const estimatedTokens = typeof msgWithProps.estimated_tokens === 'number'
        ? msgWithProps.estimated_tokens
        : undefined
      const content = estimatedTokens !== undefined
        ? `Estimated thinking tokens: ${estimatedTokens}`
        : 'Estimating thinking tokens...'

      if (!alreadySeen) {
        seenPartIds.add(partId)
      }
      partContentLengths.set(partId, String(content.length))
      parts.push({
        id: partId,
        type: MessagePartType.REASONING,
        text: content,
        role: 'assistant',
        update: alreadySeen,
      })
      return parts
    }

    const partId = `system-${msgWithProps.uuid || Date.now()}`
    if (!seenPartIds.has(partId)) {
      seenPartIds.add(partId)

      const content = msgWithProps.subtype || 'System message'
      partContentLengths.set(partId, String(content.length))
      parts.push({
        id: partId,
        type: MessagePartType.TEXT,
        content,
      })
    }
  }

  return parts
}

/**
 * Builds a human-readable title for a tool call from its input.
 * Mirrors the titles OpenCode supplies in `state.title` (passed through by
 * transformToolPart in opencode-messages.ts).
 */
export function buildToolTitle(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return ''

  switch (toolName) {
    case 'Bash':
      return input.command ? String(input.command) : (input.description ? String(input.description) : '')
    case 'Read':
      return input.file_path ? String(input.file_path) : ''
    case 'Edit':
    case 'Write':
      return input.file_path ? String(input.file_path) : ''
    case 'Grep':
      return input.pattern
        ? `${input.pattern}${input.path ? ` in ${input.path}` : ''}`
        : ''
    case 'Glob':
      return input.pattern ? String(input.pattern) : ''
    case 'Task':
      return input.description ? String(input.description) : ''
    case 'WebFetch':
      return input.url ? String(input.url) : ''
    case 'WebSearch':
      return input.query ? String(input.query) : ''
    case 'TodoWrite':
      return 'Todo List'
    case 'AskUserQuestion':
      return 'Question'
    case 'EnterPlanMode':
      return 'Enter plan mode'
    case 'ExitPlanMode':
      return 'Exit plan mode'
    default:
      return ''
  }
}
