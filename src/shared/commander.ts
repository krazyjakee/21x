/**
 * Wire types for Commander chat sessions (docs/commander.md).
 *
 * The Commander is a fast conversational model with no canvas: its UI is a
 * list of persisted chat sessions. These shapes cross IPC between the
 * main-process CommanderService and the renderer.
 */
import type { ChatRuntimeEvent, ChatStopReason, ChatToolCall } from './chat'
import type { CommanderActionResult } from './commander-tools'

/**
 * - `user` / `assistant` / `tool`: the conversation the model sees.
 * - `report`: an incoming Captain report for a project (#62). Counts as
 *   unread until the session is read; fed to the model as a user-side note.
 * - `summary`: a rolling summary of older turns, written by the chat model.
 *   Its `correlation_id` is the id of the last message it folds in.
 */
export type CommanderMessageRole = 'user' | 'assistant' | 'tool' | 'report' | 'summary'

export const COMMANDER_MESSAGE_ROLES: readonly CommanderMessageRole[] = ['user', 'assistant', 'tool', 'report', 'summary']

export type CommanderInputMode = 'voice' | 'typed'

export interface CommanderSession {
  id: string
  /** Empty until the model (or the fallback) names it after the first exchange. */
  title: string
  /** Epoch ms. */
  created_at: number
  updated_at: number
  archived: boolean
  /** Epoch ms of the last time the user had the session open; null when never. */
  last_read_at: number | null
  /** Reports newer than `last_read_at`. */
  unread_count: number
}

export interface CommanderMessage {
  id: string
  session_id: string
  role: CommanderMessageRole
  content: string
  /** Assistant messages: the tool calls the model made (rendered as chips). */
  tool_calls: ChatToolCall[] | null
  /** Tool messages: which call this answers. */
  tool_call_id: string | null
  /** Tool messages: the tool's name. */
  tool_name: string | null
  /** Tool messages: whether the result was an error. */
  is_error: boolean
  /** The project a delegation or report concerns (no FK until projects exist). */
  project_id: string | null
  /** Ties a delegation to the report that answers it (#61/#62). */
  correlation_id: string | null
  /** User messages only. Null is a readable record written before migration 25. */
  input_mode?: CommanderInputMode | null
  /** Epoch ms. */
  created_at: number
}

/** One successful Commander mutation, persisted as soon as its tool finishes. */
export interface CommanderActionExecution {
  /** App-generated identity. Unlike a provider call id, unique across every session and turn. */
  execution_id: string
  session_id: string
  turn_id: string
  request_message_id: string
  /** Untrusted provider id retained only for model/tool transcript compatibility. */
  provider_call_id: string
  tool_name: string
  input: Record<string, unknown>
  result: CommanderActionResult
  /** Epoch ms. Null until an exact reversal commits. */
  undone_at: number | null
  undo_message_id: string | null
  created_at: number
}

export interface CommanderListSessionsRequest {
  search?: string
  includeArchived?: boolean
}

/** Events on `commander:event`. */
export type CommanderEvent =
  /** A turn started for a session. */
  | { type: 'turn_started'; sessionId: string; turnId: string }
  /** A streaming runtime event, minus the `done` payload's full history. */
  | {
      type: 'turn_event'
      sessionId: string
      turnId: string
      event: Exclude<ChatRuntimeEvent, { type: 'done' }> | { type: 'done'; stopReason: ChatStopReason }
    }
  /** A mutation result became durable; available before the model's final reply. */
  | { type: 'action_completed'; sessionId: string; action: CommanderActionExecution }
  /** An exact reversal and its consumption marker committed together. */
  | { type: 'action_updated'; sessionId: string; action: CommanderActionExecution }
  /** Messages were stored (user, assistant, tool, report, summary). */
  | { type: 'messages_appended'; sessionId: string; messages: CommanderMessage[] }
  /** Title, archive state, unread count or timestamps changed. */
  | { type: 'session_updated'; session: CommanderSession }

export const COMMANDER_EVENT_CHANNEL = 'commander:event'
