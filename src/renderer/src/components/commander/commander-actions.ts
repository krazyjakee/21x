import type { ChatToolCall } from '@shared/chat'
import type { CommanderMessage } from '@shared/commander'
import {
  commanderUndoCallId,
  isCommanderAdminTool,
  parseCommanderActionResult,
  type CommanderActionResult
} from '@shared/commander-tools'

export interface CommanderActionItem {
  call: ChatToolCall
  result: CommanderMessage
  request: CommanderMessage | null
  action: CommanderActionResult | null
  undone: boolean
}

function isLegacySuccess(content: string): boolean {
  try {
    const value = JSON.parse(content) as { status?: unknown }
    return value?.status === 'ok'
  } catch {
    return false
  }
}

/**
 * Joins model calls to main-process results. A claim in assistant text alone
 * can never produce an action: the persisted, non-error tool result is required.
 */
export function collectCommanderActions(messages: CommanderMessage[]): CommanderActionItem[] {
  const results = new Map<string, CommanderMessage>()
  const undone = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) results.set(message.tool_call_id, message)
    const undoneCall = commanderUndoCallId(message.correlation_id)
    if (undoneCall) undone.add(undoneCall)
  }

  let request: CommanderMessage | null = null
  const actions: CommanderActionItem[] = []
  for (const message of messages) {
    if (message.role === 'user' && !commanderUndoCallId(message.correlation_id)) request = message
    if (message.role !== 'assistant') continue
    for (const call of message.tool_calls ?? []) {
      if (!isCommanderAdminTool(call.name)) continue
      const toolResult = results.get(call.id)
      if (!toolResult || toolResult.is_error || toolResult.tool_name !== call.name) continue
      const action = parseCommanderActionResult(toolResult.content)
      if (!action && !isLegacySuccess(toolResult.content)) continue
      actions.push({ call, result: toolResult, request, action, undone: undone.has(call.id) })
    }
  }
  return actions
}
