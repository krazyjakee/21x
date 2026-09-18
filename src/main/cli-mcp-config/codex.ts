/**
 * Codex global MCP config.
 *
 *   $CODEX_HOME/config.toml, else ~/.codex/config.toml
 *
 *   [mcp_servers.<name>]
 *   command = "npx"            args = ["-y", "pkg"]
 *   env = { KEY = "value" }    env_vars = ["FORWARDED_FROM_PARENT"]
 *   url = "https://…"          http_headers = { X = "v" }
 *   env_http_headers = { Authorization = "VAR" }   bearer_token_env_var = "VAR"
 *   enabled = false            disabled_tools = ["tool"]   enabled_tools = ["tool"]
 *
 * Codex has no `${VAR}` substitution; references are expressed through the
 * env-forwarding keys instead. Unified `${VAR}` values map to `env_vars`
 * (stdio env), `env_http_headers` (headers) or `bearer_token_env_var`
 * (`Authorization: Bearer ${VAR}`), and back again on read.
 */

import { homedir } from 'os'
import { join } from 'path'
import type { CliId, McpServerDefinition } from '../../shared/cli-mcp-config'
import { isPureReference } from './secrets'
import { readFileSnapshot, type FileSnapshot } from './file-store'
import { BaseCliMcpStore, type CliFileRole, type CliMcpMutation, type CliStateBundle, type LoadedServer, type MutationOutcome } from './store'
import { parseTomlMcpDocument, removeTomlMcpServer, upsertTomlMcpServer, type TomlMcpDocument, type TomlMcpServerTable, type TomlValue } from './toml-mcp'
import { validateDefinition, validateServerName } from './validate'

interface CodexState {
  content: string
  doc: TomlMcpDocument
}

export interface CodexStoreOptions {
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

const MANAGED_KEYS = ['command', 'args', 'env', 'env_vars', 'url', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'enabled', 'disabled_tools']

export function resolveCodexConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.CODEX_HOME || join(home, '.codex'), 'config.toml')
}

function stringTable(value: TomlValue | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(value)) out[key] = typeof entry === 'string' ? entry : String(entry)
  return out
}

function stringArray(value: TomlValue | undefined): string[] {
  return Array.isArray(value) ? value.map((entry) => (typeof entry === 'string' ? entry : String(entry))) : []
}

export class CodexMcpStore extends BaseCliMcpStore<CodexState> {
  readonly cli: CliId = 'codex'
  private readonly configPath: string

  constructor(options: CodexStoreOptions = {}) {
    super()
    this.configPath = resolveCodexConfigPath(options.env ?? process.env, options.homeDir ?? homedir())
  }

  describeFiles(): CliFileRole[] {
    return [{ path: this.configPath, role: 'servers + tools' }]
  }

  protected readFilesOnly(): FileSnapshot[] {
    return [readFileSnapshot(this.configPath)]
  }

  protected readState(): CliStateBundle<CodexState> {
    const files = this.readFilesOnly()
    const doc = parseTomlMcpDocument(files[0].content)
    return { files, state: { content: files[0].content, doc }, notes: [] }
  }

  protected serversFrom(state: CodexState): LoadedServer[] {
    const servers: LoadedServer[] = []
    for (const table of state.doc.servers.values()) {
      const v = table.values
      const issues: string[] = []
      let definition: McpServerDefinition
      if (typeof v.url === 'string') {
        const headers = stringTable(v.http_headers)
        for (const [header, variable] of Object.entries(stringTable(v.env_http_headers))) headers[header] = `\${${variable}}`
        if (typeof v.bearer_token_env_var === 'string') headers.Authorization = `Bearer \${${v.bearer_token_env_var}}`
        definition = { transport: 'http', url: v.url, headers }
      } else {
        const env = stringTable(v.env)
        for (const variable of stringArray(v.env_vars)) env[variable] = `\${${variable}}`
        definition = {
          transport: 'stdio',
          command: typeof v.command === 'string' ? v.command : undefined,
          args: stringArray(v.args),
          env
        }
      }
      issues.push(...validateDefinition(definition))
      if (table.rawLines.length > 0) issues.push(`${table.rawLines.length} line(s) in this table were not understood and are preserved verbatim.`)
      servers.push({
        name: table.name,
        definition,
        enabled: v.enabled !== false,
        disabledTools: stringArray(v.disabled_tools),
        enabledToolsOnly: Array.isArray(v.enabled_tools) ? stringArray(v.enabled_tools) : undefined,
        issues
      })
    }
    return servers
  }

  protected mutate(state: CodexState, mutation: CliMcpMutation): MutationOutcome {
    const warnings: string[] = []
    const { doc } = state
    const requireServer = (name: string): TomlMcpServerTable => {
      const table = doc.servers.get(name)
      if (!table) throw new Error(`Codex has no MCP server named "${name}".`)
      return table
    }

    switch (mutation.kind) {
      case 'upsert': {
        const nameIssues = validateServerName('codex', mutation.name)
        if (nameIssues.length > 0) throw new Error(nameIssues.join(' '))
        const sourceName = mutation.previousName ?? mutation.name
        const existing = doc.servers.get(sourceName)
        const values: Record<string, TomlValue> = { ...(existing?.values ?? {}) }
        for (const key of MANAGED_KEYS) delete values[key]
        Object.assign(values, this.valuesFromDefinition(mutation.name, mutation.definition, warnings))
        if (existing?.values.enabled === false) values.enabled = false
        if (Array.isArray(existing?.values.disabled_tools)) values.disabled_tools = existing.values.disabled_tools
        const table: TomlMcpServerTable = { name: mutation.name, values, rawLines: existing?.rawLines ?? [] }
        let content = state.content
        if (mutation.previousName && mutation.previousName !== mutation.name && existing) {
          content = removeTomlMcpServer(doc, mutation.previousName)
          state.doc = parseTomlMcpDocument(content)
        }
        state.content = upsertTomlMcpServer(state.doc, table)
        break
      }
      case 'remove': {
        requireServer(mutation.name)
        state.content = removeTomlMcpServer(doc, mutation.name)
        break
      }
      case 'setEnabled': {
        const table = requireServer(mutation.name)
        if (mutation.enabled) delete table.values.enabled
        else table.values.enabled = false
        state.content = upsertTomlMcpServer(doc, table)
        break
      }
      case 'setToolEnabled': {
        const table = requireServer(mutation.name)
        const disabled = new Set(stringArray(table.values.disabled_tools))
        if (mutation.enabled) disabled.delete(mutation.tool)
        else disabled.add(mutation.tool)
        if (disabled.size > 0) table.values.disabled_tools = [...disabled]
        else delete table.values.disabled_tools
        if (Array.isArray(table.values.enabled_tools)) {
          warnings.push(`"${mutation.name}" also has an enabled_tools allowlist in config.toml; Codex applies both lists.`)
        }
        state.content = upsertTomlMcpServer(doc, table)
        break
      }
    }
    state.doc = parseTomlMcpDocument(state.content)
    return { warnings }
  }

  protected serialize(state: CodexState): Array<{ path: string; content: string }> {
    return [{ path: this.configPath, content: state.content }]
  }

  private valuesFromDefinition(serverName: string, def: McpServerDefinition, warnings: string[]): Record<string, TomlValue> {
    const values: Record<string, TomlValue> = {}
    if (def.transport === 'stdio') {
      values.command = def.command ?? ''
      values.args = def.args ?? []
      const env: Record<string, string> = {}
      const envVars: string[] = []
      for (const [key, value] of Object.entries(def.env ?? {})) {
        const ref = isPureReference(value)
        if (ref === null) {
          env[key] = value
          continue
        }
        if (ref !== key) {
          warnings.push(`Codex forwards environment variables by their own name; "${key}" will be read from $${ref} as "${ref}".`)
        }
        envVars.push(ref)
      }
      if (Object.keys(env).length > 0) values.env = env
      if (envVars.length > 0) values.env_vars = envVars
      return values
    }

    if (def.transport === 'sse') warnings.push('Codex has no SSE transport; the server was written as a streamable HTTP server.')
    values.url = def.url ?? ''
    const headers: Record<string, string> = {}
    const envHeaders: Record<string, string> = {}
    for (const [header, value] of Object.entries(def.headers ?? {})) {
      const bearer = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
      if (bearer && header.toLowerCase() === 'authorization') {
        values.bearer_token_env_var = bearer[1]
        continue
      }
      const ref = isPureReference(value)
      if (ref !== null) envHeaders[header] = ref
      else headers[header] = value
    }
    if (Object.keys(headers).length > 0) values.http_headers = headers
    if (Object.keys(envHeaders).length > 0) values.env_http_headers = envHeaders
    return values
  }
}
