import type { DatabaseManager, TaskRecord } from '../database'
import type { OAuthManager } from '../oauth/oauth-manager'
import type { SourceUser, ReassignResult } from '../../shared/types'

// ── Config Schema (declarative, JSON-serializable) ──────────

export type ConfigFieldType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'dynamic-select'
  | 'key-value'
  | 'password'

export interface ConfigFieldOption {
  value: string
  label: string
}

export interface ConfigFieldSchema {
  key: string
  label: string
  type: ConfigFieldType
  placeholder?: string
  required?: boolean
  default?: unknown
  description?: string
  options?: ConfigFieldOption[]
  /** For 'dynamic-select': calls plugin.resolveOptions(resolverKey, ...) */
  optionsResolver?: string
  /** For 'dynamic-select': store value as string[] instead of string */
  multiSelect?: boolean
  /** Conditional visibility */
  dependsOn?: { field: string; value: unknown }
}

export type PluginConfigSchema = ConfigFieldSchema[]

// ── Actions ─────────────────────────────────────────────────

export { PluginActionId } from '../../shared/constants'

export interface PluginAction {
  id: import('../../shared/constants').PluginActionId | string
  label: string
  icon?: string
  variant?: 'default' | 'destructive'
  requiresInput?: boolean
  inputLabel?: string
  inputPlaceholder?: string
  /**
   * For 'requiresInput' actions: the values the user can choose from. When the
   * plugin supplies these, the UI shows a picker instead of a free-text box.
   */
  inputOptions?: ConfigFieldOption[]
}

export interface ActionResult {
  success: boolean
  error?: string
  /** Fields to apply to local task after action */
  taskUpdate?: Record<string, unknown>
}

// ── Sync Result ─────────────────────────────────────────────

export interface PluginSyncResult {
  imported: number
  updated: number
  errors: string[]
}

// ── Plugin Context ──────────────────────────────────────────

export interface PluginContext {
  db: DatabaseManager
  oauthManager?: OAuthManager
  sourceId?: string
}

// ── Plugin Interface ────────────────────────────────────────

export interface TaskSourcePlugin {
  id: string
  displayName: string
  description: string
  icon: string

  getConfigSchema(): PluginConfigSchema

  resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ConfigFieldOption[]>

  getActions(config: Record<string, unknown>): PluginAction[]

  importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult>

  exportUpdate(
    task: TaskRecord,
    changedFields: Record<string, unknown>,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<void>

  executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ActionResult>

  getUsers?(
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<SourceUser[]>

  reassignTask?(
    task: TaskRecord,
    userIds: string[],
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ReassignResult>

  /** Returns markdown documentation for setting up this task source */
  getSetupDocumentation?(): string
}
