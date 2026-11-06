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
 * and disappear. A result answers the nearest assistant message that made a
 * call with its id, and the earliest such call in that message. A newer message
 * replaces older waiting calls: a turn cut short leaves calls unanswered for
 * good, and a later result must not be handed to one of those.
 */
export function pairToolResults(messages: readonly CommanderMessage[]): Map<string, CommanderMessage> {
  const waiting = new Map<string, string[]>()
  const results = new Map<string, CommanderMessage>()
  for (const message of messages) {
    const declared = new Set<string>()
    message.tool_calls?.forEach((call, index) => {
      if (!declared.has(call.id)) waiting.set(call.id, [])
      declared.add(call.id)
      waiting.get(call.id)!.push(toolRunKey(message.id, index))
    })
    if (message.role !== 'tool' || !message.tool_call_id) continue
    const key = waiting.get(message.tool_call_id)?.shift()
    if (key) results.set(key, message)
  }
  return results
}
