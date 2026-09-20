/**
 * Row types for the Commander tables (commander_sessions / commander_messages).
 * Records returned to callers are the shared wire types.
 */
export type { CommanderMessage, CommanderMessageRole, CommanderSession } from '../../shared/commander'

export interface CommanderSessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  archived: number
  last_read_at: number | null
  unread_count?: number
}

export interface CommanderMessageRow {
  id: string
  session_id: string
  role: string
  content: string
  tool_calls: string | null
  tool_call_id: string | null
  tool_name: string | null
  is_error: number
  project_id: string | null
  correlation_id: string | null
  input_mode: string | null
  created_at: number
}
