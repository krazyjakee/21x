import type { ChatToolCall } from '@shared/chat'
import type { CommanderActionExecution, CommanderMessage } from '@shared/commander'
import type { CommanderActionResult } from '@shared/commander-tools'

export interface CommanderActionItem {
  call: ChatToolCall
  execution: CommanderActionExecution
  request: CommanderMessage | null
  action: CommanderActionResult
  undone: boolean
}

/**
 * Builds cards only from main's durable execution records. Legacy messages
 * with provider ids alone are deliberately rejected: those ids may repeat,
 * and assistant prose or an ambiguous transcript must never authorize Undo.
 */
export function collectCommanderActions(
  messages: CommanderMessage[],
  executions: CommanderActionExecution[]
): CommanderActionItem[] {
  const requests = new Map(messages.map((message) => [message.id, message]))
  return executions.map((execution) => ({
    execution,
    call: {
      id: execution.provider_call_id,
      execution_id: execution.execution_id,
      name: execution.tool_name,
      input: execution.input
    },
    request: requests.get(execution.request_message_id) ?? null,
    action: execution.result,
    undone: execution.undone_at !== null
  }))
}
