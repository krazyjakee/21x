import type { ReasoningEffort } from '../../shared/reasoning-effort'

export interface AgentRow {
  id: string
  name: string
  server_url: string
  config: string
  is_default: number
  created_at: string
  updated_at: string
}

export interface AgentRecord {
  id: string
  name: string
  server_url: string
  config: AgentConfigRecord
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface AgentMcpServerEntry {
  serverId: string
  enabledTools?: string[]
}

export interface AgentConfigRecord {
  coding_agent?: 'opencode' | 'claude-code' | 'codex' | 'cursor' | 'pi'
  model?: string
  reasoning_effort?: ReasoningEffort
  auth_method?: 'subscription' | 'api_key'
  permission_mode?: 'ask' | 'allow'
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  system_prompt?: string
  mcp_servers?: Array<string | AgentMcpServerEntry>
  skill_ids?: string[]
  secret_ids?: string[]
  api_keys?: {
    openai?: string
    anthropic?: string
    cursor?: string
  }
}

export interface McpServerConfigRecord {
  name: string
  command: string
  args: string[]
}

export interface McpServerToolRecord {
  name: string
  description: string
}

export interface McpOAuthRegistration {
  // Discovered metadata (RFC 9728 + RFC 8414)
  resource_url: string
  authorization_server_url: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  scopes?: string
  code_challenge_methods_supported?: string[]

  // Client registration result (DCR or manual)
  client_id: string
  client_secret?: string
  registration_method: 'dcr' | 'manual'

  discovered_at: string
}

/**
 * Provenance of an MCP server row:
 * - 'user'       — added by the user through the 20x UI / IPC.
 * - 'plugin'     — materialised from a Claude plugin (.mcp.json or manifest).
 *
 * This is the authoritative signal for "is this a plugin-managed MCP?"
 * Do NOT rely on name prefixes or URL heuristics — those are display details
 * that the user can edit. `source` is set at create time and never changes.
 */
export type McpServerSource = 'user' | 'plugin'

export interface McpServerRow {
  id: string
  name: string
  type: string
  command: string
  args: string
  url: string | null
  headers: string
  environment: string
  tools: string
  oauth_metadata: string
  source: string
  created_at: string
  updated_at: string
}

export interface McpServerRecord {
  id: string
  name: string
  type: 'local' | 'remote'
  command: string
  args: string[]
  url: string
  headers: Record<string, string>
  environment: Record<string, string>
  tools: McpServerToolRecord[]
  oauth_metadata: McpOAuthRegistration | Record<string, never>
  source: McpServerSource
  created_at: string
  updated_at: string
}

export interface CreateMcpServerData {
  name: string
  type?: 'local' | 'remote'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  environment?: Record<string, string>
  oauth_metadata?: McpOAuthRegistration
  /** Defaults to 'user' when omitted — see McpServerSource. */
  source?: McpServerSource
}

export interface UpdateMcpServerData {
  name?: string
  type?: 'local' | 'remote'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  environment?: Record<string, string>
  oauth_metadata?: McpOAuthRegistration
  /**
   * Provenance is set at create time and generally immutable. This field is
   * exposed for migrations and tests only — UI/IPC paths should never write it.
   */
  source?: McpServerSource
}

export interface CreateAgentData {
  name: string
  server_url?: string
  config?: AgentConfigRecord
  is_default?: boolean
}

export interface UpdateAgentData {
  name?: string
  server_url?: string
  config?: AgentConfigRecord
  is_default?: boolean
}

export interface TaskSourceRow {
  id: string
  mcp_server_id: string | null
  name: string
  plugin_id: string
  config: string
  list_tool: string
  list_tool_args: string
  update_tool: string
  update_tool_args: string
  last_synced_at: string | null
  enabled: number
  created_at: string
  updated_at: string
}

export interface TaskSourceRecord {
  id: string
  mcp_server_id: string | null
  name: string
  plugin_id: string
  config: Record<string, unknown>
  list_tool: string
  list_tool_args: Record<string, unknown>
  update_tool: string
  update_tool_args: Record<string, unknown>
  last_synced_at: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface CreateTaskSourceData {
  mcp_server_id: string | null
  name: string
  plugin_id: string
  config?: Record<string, unknown>
  list_tool?: string
  list_tool_args?: Record<string, unknown>
  update_tool?: string
  update_tool_args?: Record<string, unknown>
}

export interface UpdateTaskSourceData {
  name?: string
  plugin_id?: string
  config?: Record<string, unknown>
  mcp_server_id?: string
  list_tool?: string
  list_tool_args?: Record<string, unknown>
  update_tool?: string
  update_tool_args?: Record<string, unknown>
  enabled?: boolean
}

export interface OutputFieldRecord {
  id: string
  name: string
  type: string
  multiple?: boolean
  options?: string[]
  required?: boolean
  value?: unknown
}

export interface TaskRow {
  id: string
  title: string
  description: string
  type: string
  priority: string
  status: string
  assignee: string
  due_date: string | null
  labels: string
  checklist: string
  attachments: string
  repos: string
  output_fields: string
  agent_id: string | null
  external_id: string | null
  source_id: string | null
  source: string
  skill_ids: string | null
  session_id: string | null
  snoozed_until: string | null
  resolution: string | null
  feedback_rating: number | null
  feedback_comment: string | null
  is_recurring: number
  recurrence_pattern: string | null
  recurrence_parent_id: string | null
  last_occurrence_at: string | null
  next_occurrence_at: string | null
  heartbeat_enabled: number
  heartbeat_interval_minutes: number | null
  heartbeat_last_check_at: string | null
  heartbeat_next_check_at: string | null
  auto_start_agent: number
  auto_complete_without_review: number
  complete_at_source: number | null
  parent_task_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface HeartbeatLogRecord {
  id: string
  task_id: string
  status: string
  summary: string | null
  session_id: string | null
  created_at: string
}

export interface RecurrencePatternObject {
  type: 'daily' | 'weekly' | 'monthly' | 'custom'
  interval: number
  time: string
  weekdays?: number[]
  monthDay?: number
  endDate?: string
  maxOccurrences?: number
}

/** A cron expression string OR a legacy JSON object */
export type RecurrencePatternRecord = RecurrencePatternObject | string

/** Input shape for persisting a transcript part (mirrors agent:output payloads). */
export interface TranscriptPartInput {
  id: string
  role?: string
  content?: string
  partType?: string
  tool?: unknown
  payload?: unknown
  /** Original time the part was produced (ms epoch). Persisted as created_at so a
   *  bulk seed/replay keeps real chronology instead of a single write-time. */
  receivedAt?: number
}

/** Persisted transcript part returned by snapshot queries. */
export type { TranscriptPartRecord } from '../../shared/transcript/types'

export interface TaskRecord {
  id: string
  title: string
  description: string
  type: string
  priority: string
  status: string
  assignee: string
  due_date: string | null
  labels: string[]
  attachments: FileAttachmentRecord[]
  repos: string[]
  output_fields: OutputFieldRecord[]
  agent_id: string | null
  external_id: string | null
  source_id: string | null
  source: string
  skill_ids: string[] | null
  session_id: string | null
  snoozed_until: string | null
  resolution: string | null
  feedback_rating: number | null
  feedback_comment: string | null
  is_recurring: boolean
  recurrence_pattern: RecurrencePatternRecord | null
  recurrence_parent_id: string | null
  last_occurrence_at: string | null
  next_occurrence_at: string | null
  heartbeat_enabled: boolean
  heartbeat_interval_minutes: number | null
  heartbeat_last_check_at: string | null
  heartbeat_next_check_at: string | null
  auto_start_agent: boolean
  auto_complete_without_review: boolean
  /**
   * How the user chose to complete a task that came from an external source.
   * null = not answered yet, true = close it at the source, false = the user
   * updates the source themselves.
   */
  complete_at_source: boolean | null
  parent_task_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface FileAttachmentRecord {
  id: string
  filename: string
  size: number
  mime_type: string
  added_at: string
}

export interface CreateTaskData {
  title: string
  description?: string
  type?: string
  priority?: string
  status?: string
  assignee?: string
  due_date?: string | null
  labels?: string[]
  attachments?: FileAttachmentRecord[]
  repos?: string[]
  output_fields?: OutputFieldRecord[]
  external_id?: string
  source_id?: string
  source?: string
  is_recurring?: boolean
  recurrence_pattern?: RecurrencePatternRecord | null
  recurrence_parent_id?: string | null
  auto_start_agent?: boolean
  auto_complete_without_review?: boolean
  complete_at_source?: boolean | null
  parent_task_id?: string | null
  /** Cron expression — if provided, sets is_recurring=true and stores as recurrence_pattern */
  cron?: string
}

export interface UpdateTaskData {
  external_id?: string | null
  source_id?: string | null
  source?: string
  title?: string
  description?: string
  type?: string
  priority?: string
  status?: string
  assignee?: string
  due_date?: string | null
  labels?: string[]
  attachments?: FileAttachmentRecord[]
  repos?: string[]
  output_fields?: OutputFieldRecord[]
  agent_id?: string | null
  skill_ids?: string[] | null
  session_id?: string | null
  snoozed_until?: string | null
  resolution?: string | null
  feedback_rating?: number | null
  feedback_comment?: string | null
  is_recurring?: boolean
  recurrence_pattern?: RecurrencePatternRecord | null
  last_occurrence_at?: string | null
  next_occurrence_at?: string | null
  heartbeat_enabled?: boolean
  heartbeat_interval_minutes?: number | null
  heartbeat_last_check_at?: string | null
  heartbeat_next_check_at?: string | null
  auto_start_agent?: boolean
  auto_complete_without_review?: boolean
  complete_at_source?: boolean | null
  parent_task_id?: string | null
  sort_order?: number
}

export interface SkillRow {
  id: string
  name: string
  description: string
  content: string
  version: number
  confidence: number
  uses: number
  last_used: string | null
  tags: string
  is_deleted: number
  created_at: string
  updated_at: string
}

export interface SkillRecord {
  id: string
  name: string
  description: string
  content: string
  version: number
  confidence: number
  uses: number
  last_used: string | null
  tags: string[]
  created_at: string
  updated_at: string
}

export interface CreateSkillData {
  name: string
  description: string
  content: string
  confidence?: number
  uses?: number
  last_used?: string | null
  tags?: string[]
}

export interface UpdateSkillData {
  name?: string
  description?: string
  content?: string
  confidence?: number
  uses?: number
  last_used?: string | null
  tags?: string[]
}

export interface SecretRow {
  id: string
  name: string
  description: string
  env_var_name: string
  value: Buffer
  created_at: string
  updated_at: string
}

export interface SecretRecord {
  id: string
  name: string
  description: string
  env_var_name: string
  // value intentionally omitted — never crosses IPC boundary
  created_at: string
  updated_at: string
}

export interface SecretRecordWithValue extends SecretRecord {
  value: string  // Decrypted plaintext — only used internally in main process
}

export interface CreateSecretData {
  name: string
  description: string
  env_var_name: string
  value: string
}

export interface UpdateSecretData {
  name?: string
  description?: string
  env_var_name?: string
  value?: string
}

export interface MarketplaceSourceRow {
  id: string
  name: string
  source_type: string
  source_url: string
  metadata: string
  auto_update: number
  created_at: string
  updated_at: string
}

export interface MarketplaceSourceRecord {
  id: string
  name: string
  source_type: string
  source_url: string
  metadata: Record<string, unknown>
  auto_update: boolean
  created_at: string
  updated_at: string
}

export interface CreateMarketplaceSourceData {
  name: string
  source_type?: string
  source_url: string
  metadata?: Record<string, unknown>
  auto_update?: boolean
}

export interface ClaudePluginManifest {
  name: string
  version?: string
  description?: string
  author?: { name: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  commands?: string | string[]
  agents?: string | string[]
  skills?: string | string[]
  hooks?: string | Record<string, unknown>
  mcpServers?: string | Record<string, unknown>
  lspServers?: string | Record<string, unknown>
}

export interface ClaudePluginSource {
  source?: string
  repo?: string
  url?: string
  ref?: string
  sha?: string
  path?: string
  package?: string
  version?: string
  registry?: string
}

export interface InstalledPluginRow {
  id: string
  name: string
  marketplace_id: string
  manifest: string
  source: string
  scope: string
  enabled: number
  version: string
  installed_at: string
  updated_at: string
}

export interface InstalledPluginRecord {
  id: string
  name: string
  marketplace_id: string
  manifest: ClaudePluginManifest
  source: ClaudePluginSource
  scope: string
  enabled: boolean
  version: string
  installed_at: string
  updated_at: string
}

export interface CreateInstalledPluginData {
  name: string
  marketplace_id: string
  manifest?: ClaudePluginManifest
  source?: ClaudePluginSource
  scope?: string
  version?: string
}

export interface UpdateInstalledPluginData {
  enabled?: boolean
  manifest?: ClaudePluginManifest
  version?: string
  scope?: string
}

export interface OAuthTokenRow {
  id: string
  provider: string
  source_id: string | null
  mcp_server_id: string | null
  access_token: Buffer
  refresh_token: Buffer | null
  expires_at: string
  scope: string | null
  token_type: string
  created_at: string
  updated_at: string
}

export interface OAuthTokenRecord {
  id: string
  provider: string
  source_id: string | null
  mcp_server_id: string | null
  access_token: string
  refresh_token: string | null
  expires_at: string
  scope: string | null
  token_type: string
  created_at: string
  updated_at: string
}

export interface CreateOAuthTokenData {
  provider: string
  source_id?: string | null
  mcp_server_id?: string | null
  access_token: string
  refresh_token: string | null
  expires_in: number
  scope: string | null
}
