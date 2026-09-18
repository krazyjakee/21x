/**
 * Global MCP configuration of the installed coding-agent CLIs.
 *
 * One manager fronts one store per CLI (Claude Code, OpenCode, Codex). It
 * produces the unified snapshot the settings UI renders — every server tagged
 * with the CLI that owns it — and routes mutations to the right store with
 * the fingerprint the UI last saw, so an external edit surfaces as a conflict.
 *
 * Secrets: env/header values that look like secrets are masked in snapshots.
 * A masked placeholder sent back in an upsert keeps the on-disk value; a new
 * secret-looking value is written as an environment reference. Nothing in
 * this module logs a value.
 */

import {
  CLI_CAPABILITIES,
  CLI_LABELS,
  type CliConfigState,
  type CliId,
  type CliMcpApplyResult,
  type CliMcpMutationResult,
  type CliMcpProbeResult,
  type CliMcpServerRef,
  type CliMcpSnapshot,
  type CliMcpUpsertRequest,
  type GlobalMcpServer,
  type McpProbeState,
  type McpServerDefinition,
  type McpToolInfo
} from '../../shared/cli-mcp-config'
import type { McpServerProbeInput } from '../agent-manager/mcp-server-test'
import { ClaudeCodeMcpStore } from './claude-code'
import { CodexMcpStore } from './codex'
import { OpencodeMcpStore } from './opencode'
import { envVarNameForKey, maskRecord, reconcileSecretValues, resolveReferences } from './secrets'
import { findServer, type CliMcpMutation, type CliMcpStore } from './store'
import { validateDefinition, validateServerName } from './validate'

export type { CliMcpStore } from './store'

export interface CliMcpConfigManagerOptions {
  stores?: CliMcpStore[]
  env?: NodeJS.ProcessEnv
  probe?: (input: McpServerProbeInput) => Promise<{ status: 'connected' | 'failed'; error?: string; errorDetail?: string; toolCount?: number; tools?: McpToolInfo[] }>
}

interface ProbeCacheEntry {
  tools?: McpToolInfo[]
  probe: McpProbeState
}

export function createDefaultStores(env: NodeJS.ProcessEnv = process.env, homeDir?: string): CliMcpStore[] {
  return [
    new ClaudeCodeMcpStore({ homeDir }),
    new OpencodeMcpStore({ homeDir, env }),
    new CodexMcpStore({ homeDir, env })
  ]
}

export class CliMcpConfigManager {
  private readonly stores: Map<CliId, CliMcpStore>
  private readonly env: NodeJS.ProcessEnv
  private readonly probeFn: NonNullable<CliMcpConfigManagerOptions['probe']>
  private readonly probeCache = new Map<string, ProbeCacheEntry>()

  constructor(options: CliMcpConfigManagerOptions = {}) {
    this.env = options.env ?? process.env
    this.stores = new Map((options.stores ?? createDefaultStores(this.env)).map((store) => [store.cli, store]))
    // Loaded on first use: the probe module pulls in the task API server.
    this.probeFn = options.probe ?? (async (input) => (await import('../agent-manager/mcp-server-test')).testMcpServer(input))
  }

  snapshot(): CliMcpSnapshot {
    const clis: CliConfigState[] = []
    const servers: GlobalMcpServer[] = []
    for (const store of this.stores.values()) {
      const loaded = store.load()
      clis.push({
        cli: store.cli,
        label: CLI_LABELS[store.cli],
        files: loaded.roles.map((role) => ({
          path: role.path,
          role: role.role,
          exists: loaded.files.find((file) => file.path === role.path)?.exists ?? false
        })),
        fingerprint: loaded.fingerprint,
        capabilities: CLI_CAPABILITIES[store.cli],
        error: loaded.error,
        notes: loaded.notes
      })
      for (const server of loaded.servers) {
        const env = maskRecord('env', server.definition.env)
        const headers = maskRecord('header', server.definition.headers)
        const cached = this.probeCache.get(cacheKey(store.cli, server.name))
        servers.push({
          cli: store.cli,
          name: server.name,
          definition: {
            ...server.definition,
            env: env.values,
            headers: headers.values
          },
          enabled: server.enabled,
          disabledTools: server.disabledTools,
          enabledToolsOnly: server.enabledToolsOnly,
          maskedKeys: { env: env.maskedKeys, headers: headers.maskedKeys },
          issues: server.issues,
          tools: cached?.tools,
          probe: cached?.probe
        })
      }
    }
    servers.sort((a, b) => a.name.localeCompare(b.name) || a.cli.localeCompare(b.cli))
    return { clis, servers, loadedAt: new Date().toISOString() }
  }

  /** Adds or edits a server in every target CLI. */
  upsert(request: CliMcpUpsertRequest): CliMcpMutationResult {
    const results: CliMcpApplyResult[] = []
    const name = request.name.trim()
    const targets = [...new Set(request.targets)]
    if (targets.length === 0) {
      return { results: [{ cli: 'claude-code', ok: false, error: 'Pick at least one CLI.', warnings: [] }], snapshot: this.snapshot() }
    }

    for (const cli of targets) {
      const store = this.stores.get(cli)
      if (!store) {
        results.push({ cli, ok: false, error: `Unknown CLI "${cli}".`, warnings: [] })
        continue
      }
      const issues = [...validateServerName(cli, name), ...validateDefinition(request.definition)]
      if (issues.length > 0) {
        results.push({ cli, ok: false, error: issues.join(' '), warnings: [] })
        continue
      }
      let reconcileWarnings: string[] = []
      const result = store.apply(request.expectedFingerprints?.[cli], (fresh) => {
        const existing = findServer(fresh, request.previousName ?? name)
        const { definition, warnings } = this.reconcileDefinition(name, request.definition, existing?.definition)
        reconcileWarnings = warnings
        return { kind: 'upsert', name, previousName: request.previousName, definition }
      })
      result.warnings.push(...reconcileWarnings)
      if (result.ok && request.previousName && request.previousName !== name) {
        this.probeCache.delete(cacheKey(cli, request.previousName))
      }
      if (result.ok) this.probeCache.delete(cacheKey(cli, name))
      results.push(result)
    }
    return { results, snapshot: this.snapshot() }
  }

  remove(ref: CliMcpServerRef): CliMcpMutationResult {
    const result = this.applyTo(ref, { kind: 'remove', name: ref.name })
    if (result.ok) this.probeCache.delete(cacheKey(ref.cli, ref.name))
    return { results: [result], snapshot: this.snapshot() }
  }

  setEnabled(ref: CliMcpServerRef & { enabled: boolean }): CliMcpMutationResult {
    const result = this.applyTo(ref, { kind: 'setEnabled', name: ref.name, enabled: ref.enabled })
    return { results: [result], snapshot: this.snapshot() }
  }

  setToolEnabled(ref: CliMcpServerRef & { tool: string; enabled: boolean }): CliMcpMutationResult {
    if (!ref.tool.trim()) {
      return { results: [{ cli: ref.cli, ok: false, error: 'Tool name is required.', warnings: [] }], snapshot: this.snapshot() }
    }
    const result = this.applyTo(ref, { kind: 'setToolEnabled', name: ref.name, tool: ref.tool, enabled: ref.enabled })
    return { results: [result], snapshot: this.snapshot() }
  }

  /**
   * Connects to a server with the existing MCP probe and records the tools it
   * advertises, so the UI can offer per-tool switches. References are
   * resolved from the main-process environment for the probe only.
   */
  async probe(ref: CliMcpServerRef): Promise<CliMcpProbeResult> {
    const store = this.stores.get(ref.cli)
    if (!store) return { status: 'failed', error: `Unknown CLI "${ref.cli}".`, checkedAt: new Date().toISOString() }
    const loaded = store.load()
    if (loaded.error) return { status: 'failed', error: loaded.error, checkedAt: new Date().toISOString() }
    const server = findServer(loaded, ref.name)
    if (!server) return { status: 'failed', error: `${CLI_LABELS[ref.cli]} has no MCP server named "${ref.name}".`, checkedAt: new Date().toISOString() }

    const issues = validateDefinition(server.definition)
    if (issues.length > 0) {
      const result: CliMcpProbeResult = { status: 'failed', error: issues.join(' '), checkedAt: new Date().toISOString() }
      this.probeCache.set(cacheKey(ref.cli, ref.name), { probe: result })
      return result
    }

    const env = resolveReferences(server.definition.env, this.env)
    const headers = resolveReferences(server.definition.headers, this.env)
    const unresolved = [...new Set([...env.unresolved, ...headers.unresolved])]
    const input: McpServerProbeInput = server.definition.transport === 'stdio'
      ? { name: server.name, type: 'local', command: server.definition.command, args: server.definition.args, environment: env.values }
      : { name: server.name, type: 'remote', url: server.definition.url, headers: headers.values }

    const probe = await this.probeFn(input)
    const checkedAt = new Date().toISOString()
    let error = probe.error
    if (probe.status === 'failed' && unresolved.length > 0) {
      error = `${probe.error ?? 'Connection failed'} (unset environment variable${unresolved.length > 1 ? 's' : ''}: ${unresolved.join(', ')})`
    }
    const result: CliMcpProbeResult = {
      status: probe.status,
      error,
      errorDetail: probe.errorDetail,
      toolCount: probe.toolCount,
      tools: probe.tools,
      checkedAt,
      unresolvedReferences: unresolved.length > 0 ? unresolved : undefined
    }
    const previous = this.probeCache.get(cacheKey(ref.cli, ref.name))
    this.probeCache.set(cacheKey(ref.cli, ref.name), {
      // Keep the last good tool list through a transient failure.
      tools: probe.tools ?? previous?.tools,
      probe: { status: result.status, error: result.error, errorDetail: result.errorDetail, toolCount: result.toolCount, checkedAt }
    })
    return result
  }

  private applyTo(ref: CliMcpServerRef, mutation: CliMcpMutation): CliMcpApplyResult {
    const store = this.stores.get(ref.cli)
    if (!store) return { cli: ref.cli, ok: false, error: `Unknown CLI "${ref.cli}".`, warnings: [] }
    return store.apply(ref.expectedFingerprint, () => mutation)
  }

  private reconcileDefinition(
    name: string,
    incoming: McpServerDefinition,
    onDisk: McpServerDefinition | undefined
  ): { definition: McpServerDefinition; warnings: string[] } {
    const env = reconcileSecretValues('env', incoming.env, onDisk?.env, (key) => envVarNameForKey(name, key))
    const headers = reconcileSecretValues('header', incoming.headers, onDisk?.headers, (key) => envVarNameForKey(name, key))
    const definition: McpServerDefinition = {
      transport: incoming.transport,
      command: incoming.command?.trim() || undefined,
      args: (incoming.args ?? []).filter((arg) => typeof arg === 'string'),
      url: incoming.url?.trim() || undefined,
      env: env.values,
      headers: headers.values
    }
    return { definition, warnings: [...env.warnings, ...headers.warnings] }
  }
}

function cacheKey(cli: CliId, name: string): string {
  return `${cli}\0${name}`
}
