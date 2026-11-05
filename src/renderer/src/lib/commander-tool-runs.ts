import type { CommanderMessage } from '@shared/commander'

/** Identifies one call inside one assistant message. */
export function toolRunKey(messageId: string, callIndex: number): string {
  return `${messageId}:${callIndex}`
}

/**
 * Tool calls paired with their stored results, in transcript order.
 *
 * Provider call ids can repeat between turns, so an id alone does not identify
 * an execution: keyed by id, an earlier action would show a later one's result
 * and disappear. Each result belongs to the earliest call with its id that is
 * still waiting for one.
 */
export function pairToolResults(messages: readonly CommanderMessage[]): Map<string, CommanderMessage> {
  const waiting = new Map<string, string[]>()
  const results = new Map<string, CommanderMessage>()
  for (const message of messages) {
    message.tool_calls?.forEach((call, index) => {
      const queue = waiting.get(call.id)
      if (queue) queue.push(toolRunKey(message.id, index))
      else waiting.set(call.id, [toolRunKey(message.id, index)])
    })
    if (message.role !== 'tool' || !message.tool_call_id) continue
    const key = waiting.get(message.tool_call_id)?.shift()
    if (key) results.set(key, message)
  }
  return results
}
