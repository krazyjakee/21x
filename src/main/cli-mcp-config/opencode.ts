/**
 * OpenCode global MCP config.
 *
 *   $OPENCODE_CONFIG, else $XDG_CONFIG_HOME/opencode/opencode.json(c), else
 *   ~/.config/opencode/opencode.json(c)
 *
 *   mcp:   { <name>: { type: "local", command: [..], environment, enabled }
 *                   | { type: "remote", url, headers, enabled, oauth } }
 *   tools: { "<server>_<tool>": false }   — global per-tool switch
 *
 * OpenCode substitutes `{env:VAR}` (and `{file:path}`) in config strings; the
 * unified `${VAR}` form is translated on the way in and out. 20x's own
 * OpenCode sessions load this same file through OPENCODE_CONFIG_CONTENT, so
 * a server disabled here is not started for them either.
 */

import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import type { CliId, McpServerDefinition } from '../../shared/cli-mcp-config'
import { normalizeMcpName, opencodeToolId } from '../mcp-tool-limits'
import { parseJsonDocument, readFileSnapshot, serializeJsonDocument, type FileSnapshot, type JsonDocument } from './file-store'
import { BaseCliMcpStore, type CliFileRole, type CliMcpMutation, type CliStateBundle, type LoadedServer, type MutationOutcome } from './store'
import { validateDefinition } from './validate'

interface OpencodeState {
  doc: JsonDocument
}

export interface OpencodeStoreOptions {
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

const KNOWN_LOCAL_KEYS = ['type', 'command', 'environment', 'enabled']
const KNOWN_REMOTE_KEYS = ['type', 'url', 'headers', 'enabled']

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(asRecord(value) ?? {})) out[key] = typeof entry === 'string' ? entry : String(entry)
  return out
}

/** `{env:VAR}` → `${VAR}` for every occurrence. */
export function opencodeToUnifiedRef(value: string): string {
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}')
}

/** `${VAR}` → `{env:VAR}`; `${VAR:-x}` has no OpenCode form and is written as `{env:VAR}`. */
export function unifiedToOpencodeRef(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g, '{env:$1}')
}

function mapValues(record: Record<string, string> | undefined, fn: (value: string) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record ?? {})) out[key] = fn(value)
  return out
}

export function resolveOpencodeConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.OPENCODE_CONFIG) return env.OPENCODE_CONFIG
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  const json = join(configHome, 'opencode', 'opencode.json')
  const jsonc = join(configHome, 'opencode', 'opencode.jsonc')
  if (!existsSync(json) && existsSync(jsonc)) return jsonc
  return json
}

export class OpencodeMcpStore extends BaseCliMcpStore<OpencodeState> {
  readonly cli: CliId = 'opencode'
  private readonly configPath: string

  constructor(options: OpencodeStoreOptions = {}) {
    super()
    this.configPath = resolveOpencodeConfigPath(options.env ?? process.env, options.homeDir ?? homedir())
  }

  describeFiles(): CliFileRole[] {
    return [{ path: this.configPath, role: 'servers + tools' }]
  }

  protected readFilesOnly(): FileSnapshot[] {
    return [readFileSnapshot(this.configPath)]
  }

  protected readState(): CliStateBundle<OpencodeState> {
    const files = this.readFilesOnly()
    const doc = parseJsonDocument(files[0].content)
    const notes: string[] = []
    if (doc.hadComments) notes.push(`${this.configPath} contains comments or trailing commas; they are dropped when 20x writes the file.`)
    return { files, state: { doc }, notes }
  }

  protected serversFrom(state: OpencodeState): LoadedServer[] {
    const servers: LoadedServer[] = []
    const entries = asRecord(state.doc.value.mcp) ?? {}
    const tools = asRecord(state.doc.value.tools) ?? {}
    for (const [name, raw] of Object.entries(entries)) {
      const entry = asRecord(raw)
      if (!entry) {
        servers.push({ name, definition: { transport: 'stdio' }, enabled: true, disabledTools: [], issues: ['Entry is not an object.'] })
        continue
      }
      const issues: string[] = []
      let definition: McpServerDefinition
      if (entry.type === 'remote') {
        definition = {
          transport: 'http',
          url: typeof entry.url === 'string' ? entry.url : undefined,
          headers: mapValues(asStringRecord(entry.headers), opencodeToUnifiedRef)
        }
      } else {
        if (entry.type !== 'local') issues.push(`Unknown OpenCode MCP type "${String(entry.type)}"; treated as local.`)
        const command = Array.isArray(entry.command) ? entry.command.map(String) : []
        if (!Array.isArray(entry.command)) issues.push('"command" must be an array of strings.')
        definition = {
          transport: 'stdio',
          command: command[0],
          args: command.slice(1),
          env: mapValues(asStringRecord(entry.environment), opencodeToUnifiedRef)
        }
      }
      issues.push(...validateDefinition(definition))

      const prefix = `${normalizeMcpName(name)}_`
      const disabledTools = Object.entries(tools)
        .filter(([id, value]) => value === false && id.startsWith(prefix) && id !== `${prefix}*`)
        .map(([id]) => id.slice(prefix.length))
      const wildcardDisabled = tools[`${prefix}*`] === false
      if (wildcardDisabled) issues.push(`tools["${prefix}*"] is false, which hides every tool of this server.`)

      servers.push({
        name,
        definition,
        enabled: entry.enabled !== false && !wildcardDisabled,
        disabledTools,
        issues
      })
    }
    return servers
  }

  protected mutate(state: OpencodeState, mutation: CliMcpMutation): MutationOutcome {
    const warnings: string[] = []
    const entries = (asRecord(state.doc.value.mcp) ?? {}) as Record<string, unknown>
    state.doc.value.mcp = entries

    switch (mutation.kind) {
      case 'upsert': {
        const sourceName = mutation.previousName ?? mutation.name
        const existing = asRecord(entries[sourceName]) ?? {}
        const entry: Record<string, unknown> = { ...existing }
        const def = mutation.definition
        if (def.transport === 'stdio') {
          for (const key of [...KNOWN_LOCAL_KEYS, ...KNOWN_REMOTE_KEYS]) delete entry[key]
          entry.type = 'local'
          entry.command = [def.command ?? '', ...(def.args ?? [])]
          if (def.env && Object.keys(def.env).length > 0) entry.environment = mapValues(def.env, unifiedToOpencodeRef)
        } else {
          if (def.transport === 'sse') warnings.push('OpenCode has no SSE transport; the server was written as a remote (streamable HTTP) server.')
          for (const key of [...KNOWN_LOCAL_KEYS, ...KNOWN_REMOTE_KEYS]) delete entry[key]
          entry.type = 'remote'
          entry.url = def.url ?? ''
          if (def.headers && Object.keys(def.headers).length > 0) entry.headers = mapValues(def.headers, unifiedToOpencodeRef)
        }
        if (existing.enabled === false) entry.enabled = false
        if (mutation.previousName && mutation.previousName !== mutation.name) {
          delete entries[mutation.previousName]
          this.renameToolRules(state.doc, mutation.previousName, mutation.name)
        }
        entries[mutation.name] = entry
        break
      }
      case 'remove': {
        if (!(mutation.name in entries)) throw new Error(`OpenCode has no MCP server named "${mutation.name}".`)
        delete entries[mutation.name]
        const removed = this.removeToolRules(state.doc, mutation.name, () => true)
        if (removed > 0) warnings.push(`Removed ${removed} OpenCode tools rule(s) that referred to "${mutation.name}".`)
        break
      }
      case 'setEnabled': {
        const entry = asRecord(entries[mutation.name])
        if (!entry) throw new Error(`OpenCode has no MCP server named "${mutation.name}".`)
        if (mutation.enabled) {
          delete entry.enabled
          this.removeToolRules(state.doc, mutation.name, (id) => id.endsWith('_*'))
        } else {
          entry.enabled = false
        }
        break
      }
      case 'setToolEnabled': {
        if (!(mutation.name in entries)) throw new Error(`OpenCode has no MCP server named "${mutation.name}".`)
        const id = opencodeToolId(mutation.name, mutation.tool)
        const tools = (asRecord(state.doc.value.tools) ?? {}) as Record<string, unknown>
        if (mutation.enabled) {
          delete tools[id]
        } else {
          tools[id] = false
        }
        if (Object.keys(tools).length > 0) state.doc.value.tools = tools
        else delete state.doc.value.tools
        break
      }
    }
    if (Object.keys(entries).length === 0) delete state.doc.value.mcp
    return { warnings }
  }

  protected serialize(state: OpencodeState): Array<{ path: string; content: string }> {
    return [{ path: this.configPath, content: serializeJsonDocument(state.doc) }]
  }

  private removeToolRules(doc: JsonDocument, serverName: string, matches: (id: string) => boolean): number {
    const tools = asRecord(doc.value.tools)
    if (!tools) return 0
    const prefix = `${normalizeMcpName(serverName)}_`
    let removed = 0
    for (const id of Object.keys(tools)) {
      if (id.startsWith(prefix) && matches(id)) {
        delete tools[id]
        removed++
      }
    }
    if (Object.keys(tools).length === 0) delete doc.value.tools
    return removed
  }

  private renameToolRules(doc: JsonDocument, from: string, to: string): void {
    const tools = asRecord(doc.value.tools)
    if (!tools) return
    const oldPrefix = `${normalizeMcpName(from)}_`
    const newPrefix = `${normalizeMcpName(to)}_`
    for (const id of Object.keys(tools)) {
      if (!id.startsWith(oldPrefix)) continue
      const value = tools[id]
      delete tools[id]
      tools[`${newPrefix}${id.slice(oldPrefix.length)}`] = value
    }
  }
}
