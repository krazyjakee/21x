/**
 * Claude Code global MCP config.
 *
 *   ~/.claude.json          `mcpServers: { <name>: { type?, command, args, env, url, headers } }`
 *   ~/.claude/settings.json `permissions: { allow: [], deny: [] }`
 *
 * Claude Code has no per-server "enabled" flag in user scope, so both server
 * and tool switches are permission deny rules: `mcp__<server>` disables every
 * tool of a server, `mcp__<server>__<tool>` one tool. A denied tool is never
 * offered to the model. The server process still starts, which the UI states.
 *
 * `${VAR}` references are Claude Code's own expansion syntax, so the unified
 * form is written as-is.
 */

import { homedir } from 'os'
import { join } from 'path'
import type { CliId, McpServerDefinition, McpTransport } from '../../shared/cli-mcp-config'
import { claudeServerPrefix, claudeToolIds, normalizeMcpName } from '../mcp-tool-limits'
import { parseJsonDocument, readFileSnapshot, serializeJsonDocument, type FileSnapshot, type JsonDocument } from './file-store'
import { BaseCliMcpStore, type CliFileRole, type CliMcpMutation, type CliStateBundle, type LoadedServer, type MutationOutcome } from './store'
import { validateDefinition } from './validate'

interface ClaudeState {
  config: JsonDocument
  settings: JsonDocument
  /** settings.json is only created when a rule is actually written to it. */
  settingsExisted: boolean
}

export interface ClaudeCodeStoreOptions {
  homeDir?: string
}

const KNOWN_ENTRY_KEYS = ['type', 'command', 'args', 'env', 'url', 'headers']

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) out[key] = typeof entry === 'string' ? entry : String(entry)
  return out
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => (typeof entry === 'string' ? entry : String(entry))) : []
}

export class ClaudeCodeMcpStore extends BaseCliMcpStore<ClaudeState> {
  readonly cli: CliId = 'claude-code'
  private readonly configPath: string
  private readonly settingsPath: string

  constructor(options: ClaudeCodeStoreOptions = {}) {
    super()
    const home = options.homeDir ?? homedir()
    this.configPath = join(home, '.claude.json')
    this.settingsPath = join(home, '.claude', 'settings.json')
  }

  describeFiles(): CliFileRole[] {
    return [
      { path: this.configPath, role: 'servers' },
      { path: this.settingsPath, role: 'permissions' }
    ]
  }

  protected readFilesOnly(): FileSnapshot[] {
    return [readFileSnapshot(this.configPath), readFileSnapshot(this.settingsPath)]
  }

  protected readState(): CliStateBundle<ClaudeState> {
    const files = this.readFilesOnly()
    const notes: string[] = []
    const config = parseJsonDocument(files[0].content)
    const settings = parseJsonDocument(files[1].content)
    return { files, state: { config, settings, settingsExisted: files[1].exists }, notes }
  }

  protected serversFrom(state: ClaudeState): LoadedServer[] {
    const servers: LoadedServer[] = []
    const entries = asRecord(state.config.value.mcpServers) ?? {}
    const deny = this.denyList(state.settings)
    for (const [name, raw] of Object.entries(entries)) {
      const entry = asRecord(raw)
      const issues: string[] = []
      if (!entry) {
        servers.push({ name, definition: { transport: 'stdio' }, enabled: true, disabledTools: [], issues: ['Entry is not an object.'] })
        continue
      }
      const definition = definitionFromEntry(entry)
      issues.push(...validateDefinition(definition))
      const prefix = claudeServerPrefix(name)
      const serverRule = `mcp__${normalizeMcpName(name)}`
      const disabledTools = deny
        .filter((rule) => rule.startsWith(prefix))
        .map((rule) => rule.slice(prefix.length))
        .filter(Boolean)
      servers.push({
        name,
        definition,
        enabled: !deny.includes(serverRule),
        disabledTools: [...new Set(disabledTools)],
        issues
      })
    }
    return servers
  }

  protected mutate(state: ClaudeState, mutation: CliMcpMutation): MutationOutcome {
    const warnings: string[] = []
    const servers = (asRecord(state.config.value.mcpServers) ?? {}) as Record<string, unknown>
    state.config.value.mcpServers = servers

    switch (mutation.kind) {
      case 'upsert': {
        const sourceName = mutation.previousName ?? mutation.name
        const existing = asRecord(servers[sourceName]) ?? {}
        const entry: Record<string, unknown> = { ...existing }
        for (const key of KNOWN_ENTRY_KEYS) delete entry[key]
        Object.assign(entry, entryFromDefinition(mutation.definition))
        if (mutation.previousName && mutation.previousName !== mutation.name) {
          delete servers[mutation.previousName]
          this.renameDenyRules(state.settings, mutation.previousName, mutation.name)
        }
        servers[mutation.name] = entry
        break
      }
      case 'remove': {
        if (!(mutation.name in servers)) throw new Error(`Claude Code has no MCP server named "${mutation.name}".`)
        delete servers[mutation.name]
        const removed = this.removeDenyRules(state.settings, mutation.name, () => true)
        if (removed > 0) warnings.push(`Removed ${removed} Claude Code deny rule(s) that referred to "${mutation.name}".`)
        break
      }
      case 'setEnabled': {
        if (!(mutation.name in servers)) throw new Error(`Claude Code has no MCP server named "${mutation.name}".`)
        const rule = `mcp__${normalizeMcpName(mutation.name)}`
        if (mutation.enabled) this.removeDenyRules(state.settings, mutation.name, (r) => r === rule)
        else this.addDenyRule(state.settings, rule)
        if (!mutation.enabled) warnings.push('Claude Code has no per-server enabled flag; the server is denied through permissions.deny and its tools are hidden from the model, but the process still starts.')
        break
      }
      case 'setToolEnabled': {
        if (!(mutation.name in servers)) throw new Error(`Claude Code has no MCP server named "${mutation.name}".`)
        const ids = claudeToolIds(mutation.name, mutation.tool)
        if (mutation.enabled) this.removeDenyRules(state.settings, mutation.name, (r) => ids.includes(r))
        else this.addDenyRule(state.settings, ids[0])
        break
      }
    }
    if (Object.keys(servers).length === 0) delete state.config.value.mcpServers
    return { warnings }
  }

  protected serialize(state: ClaudeState): Array<{ path: string; content: string }> {
    const out = [{ path: this.configPath, content: serializeJsonDocument(state.config) }]
    if (state.settingsExisted || Object.keys(state.settings.value).length > 0) {
      out.push({ path: this.settingsPath, content: serializeJsonDocument(state.settings) })
    }
    return out
  }

  private denyList(settings: JsonDocument): string[] {
    const permissions = asRecord(settings.value.permissions)
    return asStringArray(permissions?.deny)
  }

  private addDenyRule(settings: JsonDocument, rule: string): void {
    const permissions = asRecord(settings.value.permissions) ?? {}
    settings.value.permissions = permissions
    const deny = asStringArray(permissions.deny)
    if (!deny.includes(rule)) deny.push(rule)
    permissions.deny = deny
  }

  /** Removes matching deny rules for a server; returns how many were removed. */
  private removeDenyRules(settings: JsonDocument, serverName: string, matches: (rule: string) => boolean): number {
    const permissions = asRecord(settings.value.permissions)
    if (!permissions) return 0
    const deny = asStringArray(permissions.deny)
    const prefix = `mcp__${normalizeMcpName(serverName)}`
    const kept = deny.filter((rule) => !((rule === prefix || rule.startsWith(`${prefix}__`)) && matches(rule)))
    const removed = deny.length - kept.length
    if (removed > 0) {
      if (kept.length > 0) permissions.deny = kept
      else delete permissions.deny
    }
    return removed
  }

  private renameDenyRules(settings: JsonDocument, from: string, to: string): void {
    const permissions = asRecord(settings.value.permissions)
    if (!permissions) return
    const oldPrefix = `mcp__${normalizeMcpName(from)}`
    const newPrefix = `mcp__${normalizeMcpName(to)}`
    permissions.deny = asStringArray(permissions.deny).map((rule) => {
      if (rule === oldPrefix) return newPrefix
      if (rule.startsWith(`${oldPrefix}__`)) return `${newPrefix}${rule.slice(oldPrefix.length)}`
      return rule
    })
  }
}

function definitionFromEntry(entry: Record<string, unknown>): McpServerDefinition {
  const type = typeof entry.type === 'string' ? entry.type : undefined
  const transport: McpTransport = type === 'sse' ? 'sse' : type === 'http' || (!type && typeof entry.url === 'string' && !entry.command) ? 'http' : 'stdio'
  if (transport === 'stdio') {
    return {
      transport,
      command: typeof entry.command === 'string' ? entry.command : undefined,
      args: asStringArray(entry.args),
      env: asStringRecord(entry.env) ?? {}
    }
  }
  return {
    transport,
    url: typeof entry.url === 'string' ? entry.url : undefined,
    headers: asStringRecord(entry.headers) ?? {}
  }
}

function entryFromDefinition(definition: McpServerDefinition): Record<string, unknown> {
  if (definition.transport === 'stdio') {
    const entry: Record<string, unknown> = { type: 'stdio', command: definition.command ?? '', args: definition.args ?? [] }
    if (definition.env && Object.keys(definition.env).length > 0) entry.env = definition.env
    return entry
  }
  const entry: Record<string, unknown> = { type: definition.transport, url: definition.url ?? '' }
  if (definition.headers && Object.keys(definition.headers).length > 0) entry.headers = definition.headers
  return entry
}
