/**
 * Types shared by the main-process global CLI MCP config manager
 * (src/main/cli-mcp-config) and the renderer "Global MCP (CLIs)" settings
 * section. Nothing here touches the filesystem.
 */

/** The coding-agent CLIs whose global MCP configuration 20x can manage. */
export type CliId = 'claude-code' | 'opencode' | 'codex'

export const CLI_IDS: readonly CliId[] = ['claude-code', 'opencode', 'codex'] as const

export const CLI_LABELS: Record<CliId, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex'
}

export type McpTransport = 'stdio' | 'http' | 'sse'

/**
 * The placeholder the renderer receives instead of a secret-looking value.
 * Sending it back unchanged in an upsert keeps the value already on disk.
 */
export const MASKED_SECRET = '••••••••'

/**
 * How a CLI implements a switch:
 *  - `native`: a dedicated flag in its own config (`enabled`, `disabled_tools`).
 *  - `deny-rule`: a permission deny rule; the server still launches but the
 *    tool(s) are never exposed to the model.
 *  - `none`: not expressible in that CLI's global config.
 */
export type SwitchSupport = 'native' | 'deny-rule' | 'none'

export interface CliCapabilities {
  serverToggle: SwitchSupport
  toolToggle: SwitchSupport
  /** The env-reference syntax the CLI expands, shown in the UI as a hint. */
  envReferenceSyntax: string
}

export const CLI_CAPABILITIES: Record<CliId, CliCapabilities> = {
  'claude-code': { serverToggle: 'deny-rule', toolToggle: 'deny-rule', envReferenceSyntax: '${VAR}' },
  opencode: { serverToggle: 'native', toolToggle: 'native', envReferenceSyntax: '{env:VAR}' },
  codex: { serverToggle: 'native', toolToggle: 'native', envReferenceSyntax: 'env_vars / env_http_headers' }
}

/**
 * A transport-level server definition in 20x's unified shape. `env` and
 * `headers` values may be references written as `${VAR}`; each CLI store
 * translates them to and from its own syntax.
 */
export interface McpServerDefinition {
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpToolInfo {
  name: string
  description: string
}

export interface McpProbeState {
  status: 'connected' | 'failed'
  error?: string
  errorDetail?: string
  toolCount?: number
  checkedAt: string
}

/** One MCP server as configured globally for one CLI. */
export interface GlobalMcpServer {
  cli: CliId
  name: string
  definition: McpServerDefinition
  enabled: boolean
  /** Tool names the CLI will refuse to expose / invoke. */
  disabledTools: string[]
  /** Codex `enabled_tools` allowlist, when present: only these tools are exposed. */
  enabledToolsOnly?: string[]
  /** Keys in env/headers whose values were masked before crossing IPC. */
  maskedKeys: { env: string[]; headers: string[] }
  /** Validation problems with the entry as it exists on disk. */
  issues: string[]
  /** Tools learned from the last probe in this app run, if any. */
  tools?: McpToolInfo[]
  probe?: McpProbeState
}

export interface CliConfigFileState {
  path: string
  exists: boolean
  /** The role the file plays for the CLI (e.g. "servers", "permissions"). */
  role: string
}

export interface CliConfigState {
  cli: CliId
  label: string
  files: CliConfigFileState[]
  /** Hash of every file's content; changes whenever any of them changes. */
  fingerprint: string
  capabilities: CliCapabilities
  /** A parse error or other reason the CLI's config could not be read. */
  error?: string
  /** Non-fatal notes, e.g. "comments will be dropped on write". */
  notes: string[]
}

export interface CliMcpSnapshot {
  clis: CliConfigState[]
  servers: GlobalMcpServer[]
  loadedAt: string
}

export interface CliMcpConflict {
  cli: CliId
  paths: string[]
  expectedFingerprint: string
  currentFingerprint: string
}

export interface CliMcpApplyResult {
  cli: CliId
  ok: boolean
  conflict?: CliMcpConflict
  error?: string
  warnings: string[]
}

export interface CliMcpMutationResult {
  results: CliMcpApplyResult[]
  snapshot: CliMcpSnapshot
}

export interface CliMcpUpsertRequest {
  targets: CliId[]
  name: string
  /** When renaming, the previous name in each target CLI. */
  previousName?: string
  definition: McpServerDefinition
  /** Fingerprint per target as seen by the UI; omit a CLI to force-write it. */
  expectedFingerprints?: Partial<Record<CliId, string>>
}

export interface CliMcpServerRef {
  cli: CliId
  name: string
  expectedFingerprint?: string
}

export interface CliMcpProbeResult extends McpProbeState {
  tools?: McpToolInfo[]
  /** Env reference names that were not set when probing. */
  unresolvedReferences?: string[]
}
