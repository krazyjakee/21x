import { safeStorage } from 'electron'
import { TASK_ROLE_TASK, isCoordinatorRole, type TaskRole } from '../../shared/task-roles'
import type {
  AgentConfigRecord, AgentRecord, AgentRow,
  FileAttachmentRecord,
  InstalledPluginRecord, InstalledPluginRow,
  MarketplaceSourceRecord, MarketplaceSourceRow,
  McpOAuthRegistration, McpServerRecord, McpServerRow, McpServerSource, McpServerToolRecord,
  OAuthTokenRecord, OAuthTokenRow,
  OutputFieldRecord, RecurrencePatternObject,
  SecretRecord, SecretRecordWithValue, SecretRow,
  SkillRecord, SkillRow,
  TaskRecord, TaskRow,
  TaskSourceRecord, TaskSourceRow
} from './types'

/** Columns that can be dynamically updated via updateTask. */
/** Encrypt at rest with the OS keychain when available (plaintext fallback). */
export function encryptSecret(value: string): Buffer {
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8')
}

function decryptSecret(value: Buffer): string {
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(value) : value.toString('utf8')
}

/** Settings rows that hold provider API keys (e.g. `anthropic_api_key`). */
export function isApiKeySetting(key: string): boolean {
  return key.endsWith('_api_key')
}

/** Marks a settings value (TEXT column) as safeStorage ciphertext in base64. */
const ENCRYPTED_SETTING_PREFIX = 'safeStorage:v1:'

export function isEncryptedSettingValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_SETTING_PREFIX)
}

/** Same policy as encryptSecret: keychain when available, plaintext fallback. */
export function encryptSettingValue(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return value
  return ENCRYPTED_SETTING_PREFIX + safeStorage.encryptString(value).toString('base64')
}

/** Plaintext (legacy or fallback) values pass through; unreadable ciphertext yields ''. */
export function decryptSettingValue(value: string): string {
  if (!isEncryptedSettingValue(value)) return value
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_SETTING_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

export const UPDATABLE_COLUMNS = new Set([
  'external_id', 'source_id', 'source',
  'title',
  'description',
  'type',
  'priority',
  'status',
  'assignee',
  'due_date',
  'labels',
  'attachments',
  'repos',
  'output_fields',
  'agent_id',
  'skill_ids',
  'session_id',
  'snoozed_until',
  'resolution',
  'feedback_rating',
  'feedback_comment',
  'is_recurring',
  'recurrence_pattern',
  'last_occurrence_at',
  'next_occurrence_at',
  'heartbeat_enabled',
  'heartbeat_interval_minutes',
  'heartbeat_last_check_at',
  'heartbeat_next_check_at',
  'auto_start_agent',
  'auto_complete_without_review',
  'complete_at_source',
  'parent_task_id',
  'next_subtask_ids',
  'sort_order'
])

export const JSON_COLUMNS = new Set(['labels', 'attachments', 'repos', 'output_fields', 'skill_ids', 'next_subtask_ids'])

/** Guards against double-stringified or scalar values in array columns. */
function ensureArray<T = string>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value != null && value !== '') return [value] as T[]
  return []
}

/** Safely parse a JSON column that should be an array */
export function parseJsonArray<T = string>(raw: string | null | undefined, fallback = '[]'): T[] {
  const parsed = JSON.parse(raw || fallback)
  return ensureArray<T>(parsed)
}

export function deserializeTask(row: TaskRow): TaskRecord {
  return {
    ...row,
    labels: parseJsonArray(row.labels),
    attachments: parseJsonArray<FileAttachmentRecord>(row.attachments),
    repos: parseJsonArray(row.repos),
    output_fields: parseJsonArray<OutputFieldRecord>(row.output_fields),
    agent_id: row.agent_id ?? null,
    external_id: row.external_id ?? null,
    source_id: row.source_id ?? null,
    skill_ids: row.skill_ids ? parseJsonArray(row.skill_ids) : null,
    session_id: row.session_id ?? null,
    snoozed_until: row.snoozed_until ?? null,
    resolution: row.resolution ?? null,
    feedback_rating: row.feedback_rating ?? null,
    feedback_comment: row.feedback_comment ?? null,
    is_recurring: row.is_recurring === 1,
    recurrence_pattern: row.recurrence_pattern
      ? (row.recurrence_pattern.startsWith('{')
          ? JSON.parse(row.recurrence_pattern) as RecurrencePatternObject
          : row.recurrence_pattern as string)
      : null,
    recurrence_parent_id: row.recurrence_parent_id ?? null,
    last_occurrence_at: row.last_occurrence_at ?? null,
    next_occurrence_at: row.next_occurrence_at ?? null,
    heartbeat_enabled: row.heartbeat_enabled === 1,
    heartbeat_interval_minutes: row.heartbeat_interval_minutes ?? null,
    heartbeat_last_check_at: row.heartbeat_last_check_at ?? null,
    heartbeat_next_check_at: row.heartbeat_next_check_at ?? null,
    auto_start_agent: (row.auto_start_agent ?? 0) === 1,
    auto_complete_without_review: (row.auto_complete_without_review ?? 0) === 1,
    complete_at_source: row.complete_at_source == null ? null : row.complete_at_source === 1,
    next_subtask_ids: parseJsonArray(row.next_subtask_ids),
    role: isCoordinatorRole(row.role) ? (row.role as TaskRole) : TASK_ROLE_TASK
  }
}

export function deserializeTaskSource(row: TaskSourceRow): TaskSourceRecord {
  try {
    return {
      ...row,
      config: JSON.parse(row.config || '{}') as Record<string, unknown>,
      list_tool_args: JSON.parse(row.list_tool_args) as Record<string, unknown>,
      update_tool_args: JSON.parse(row.update_tool_args) as Record<string, unknown>,
      enabled: row.enabled === 1
    }
  } catch (err) {
    console.error('[Database] Failed to deserialize task source:', {
      id: row.id,
      name: row.name,
      config: row.config,
      list_tool_args: row.list_tool_args,
      update_tool_args: row.update_tool_args,
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

export function deserializeMcpServer(row: McpServerRow): McpServerRecord {
  const source: McpServerSource = row.source === 'plugin' ? 'plugin' : 'user'
  return {
    ...row,
    type: (row.type as 'local' | 'remote') || 'local',
    args: JSON.parse(row.args) as string[],
    url: row.url ?? '',
    headers: JSON.parse(row.headers || '{}') as Record<string, string>,
    environment: JSON.parse(row.environment || '{}') as Record<string, string>,
    tools: JSON.parse(row.tools || '[]') as McpServerToolRecord[],
    oauth_metadata: JSON.parse(row.oauth_metadata || '{}') as McpOAuthRegistration | Record<string, never>,
    source
  }
}

export function deserializeAgent(row: AgentRow): AgentRecord {
  return {
    ...row,
    config: JSON.parse(row.config) as AgentConfigRecord,
    is_default: row.is_default === 1
  }
}

export function deserializeSkill(row: SkillRow): SkillRecord {
  let tags: string[] = []
  try {
    tags = JSON.parse(row.tags)
  } catch {
    tags = []
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    version: row.version,
    confidence: row.confidence,
    uses: row.uses,
    last_used: row.last_used,
    tags,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export function deserializeSecret(row: SecretRow): SecretRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    env_var_name: row.env_var_name,
    // value intentionally omitted — never sent to renderer
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export function deserializeSecretWithValue(row: SecretRow): SecretRecordWithValue {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    env_var_name: row.env_var_name,
    value: decryptSecret(row.value),
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export function deserializeOAuthToken(row: OAuthTokenRow): OAuthTokenRecord {
  return {
    id: row.id,
    provider: row.provider,
    source_id: row.source_id,
    mcp_server_id: row.mcp_server_id ?? null,
    access_token: decryptSecret(row.access_token),
    refresh_token: row.refresh_token ? decryptSecret(row.refresh_token) || null : null,
    expires_at: row.expires_at,
    scope: row.scope,
    token_type: row.token_type,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export function deserializeMarketplaceSource(row: MarketplaceSourceRow): MarketplaceSourceRecord {
  return {
    id: row.id,
    name: row.name,
    source_type: row.source_type,
    source_url: row.source_url,
    metadata: JSON.parse(row.metadata || '{}'),
    auto_update: row.auto_update === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export function deserializeInstalledPlugin(row: InstalledPluginRow): InstalledPluginRecord {
  return {
    id: row.id,
    name: row.name,
    marketplace_id: row.marketplace_id,
    manifest: JSON.parse(row.manifest || '{}'),
    source: JSON.parse(row.source || '{}'),
    scope: row.scope,
    enabled: row.enabled === 1,
    version: row.version,
    installed_at: row.installed_at,
    updated_at: row.updated_at
  }
}
