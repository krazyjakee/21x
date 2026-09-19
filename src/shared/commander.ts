/**
 * Wire types for Commander chat sessions (docs/commander.md).
 *
 * The Commander's UI is a list of persisted chat sessions. Each session's
 * conversation is an ordinary agent session on a hidden task row whose id is
 * the session id, so its transcript travels on the normal agent channels.
 * These shapes cover the rest: the session list and Captain reports.
 */

/** A tool call recorded on a message written by the old chat runtime. */
export interface ChatToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * - `report`: an incoming Captain report for a project (#62). Counts as
 *   unread until the session is read; handed to the session's agent.
 * - `tool`: an `ask_captain` delegation, kept so the report answering it is
 *   routed back to this session.
 * - `user` / `assistant` / `summary`: history written by the old chat
 *   runtime, before sessions ran on agents. Never written any more.
 */
export type CommanderMessageRole = 'user' | 'assistant' | 'tool' | 'report' | 'summary'

export const COMMANDER_MESSAGE_ROLES: readonly CommanderMessageRole[] = ['user', 'assistant', 'tool', 'report', 'summary']

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
  /** Epoch ms: reports stored up to then have been handed to the session's agent. */
  relayed_at?: number | null
  /** Reports newer than `last_read_at`. */
  unread_count: number
}

export interface CommanderMessage {
  id: string
  session_id: string
  role: CommanderMessageRole
  content: string
  /** Old assistant messages: the tool calls the model made. */
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
  /** Epoch ms. */
  created_at: number
}

export interface CommanderListSessionsRequest {
  search?: string
  includeArchived?: boolean
}

/** Events on `commander:event`. The conversation itself streams on the agent channels. */
export type CommanderEvent =
  /** Reports or delegations were stored. */
  | { type: 'messages_appended'; sessionId: string; messages: CommanderMessage[] }
  /** Title, archive state, unread count or timestamps changed. */
  | { type: 'session_updated'; session: CommanderSession }

export const COMMANDER_EVENT_CHANNEL = 'commander:event'

/** App setting: the agent every Commander session runs on. Unset means the default agent. */
export const COMMANDER_AGENT_SETTING = 'commander_agent_id'
