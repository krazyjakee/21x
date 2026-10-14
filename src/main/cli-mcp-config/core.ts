import { ServiceProtocolError } from '../../shared/service-protocol'
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

import { AsyncLocalStorage } from 'node:async_hooks'
import { CliMcpFileOwner } from './portable-file-owner'
import { McpProbeService, type McpServerProbeInput } from '../agent-manager/mcp-probe-service'
import { projectCliMcpResult } from '../../shared/cli-mcp-codecs'
import {
  CLI_CAPABILITIES,
  CLI_LABELS,
  MASKED_SECRET,
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
import { ClaudeCodeMcpStore } from './claude-code'
import { CodexMcpStore } from './codex'
import { OpencodeMcpStore } from './opencode'
import { envVarNameForKey, maskRecord, reconcileSecretValues, resolveReferences, referenceNames } from './secrets'
import { findServer, type CliMcpMutation, type CliMcpStore } from './store'
import { validateDefinition, validateServerName } from './validate'
import { hashContent } from './file-store'

export type { CliMcpStore } from './store'

export interface CliMcpConfigManagerOptions {
  files?: CliMcpFileOwner
  homeDir?: string
  probeService?: McpProbeService
  stores?: CliMcpStore[]
  env?: NodeJS.ProcessEnv
  probe?: (input: McpServerProbeInput) => Promise<{ status: 'connected' | 'failed'; error?: string; errorDetail?: string; toolCount?: number; tools?: McpToolInfo[] }>
}

interface ProbeCacheEntry {
  binding?: string
  tools?: McpToolInfo[]
  probe: McpProbeState
}

export function createDefaultStores(env: NodeJS.ProcessEnv = process.env, homeDir?: string, files?: CliMcpFileOwner): CliMcpStore[] {
  return [
    new ClaudeCodeMcpStore({ homeDir, files }),
    new OpencodeMcpStore({ homeDir, env, files }),
    new CodexMcpStore({ homeDir, env, files })
  ]
}

export interface CliMcpRequestControls { beforeEffect(): void; signal: AbortSignal; beforeProbe?(input: McpServerProbeInput): void; beforeReference?(name: string): void }
interface RequestScope extends CliMcpRequestControls { active: boolean; parent?: RequestScope; references?: string[]; binding?: Array<{path:string;hash:string}> }
export class CliMcpConfigManager {
  private readonly stores: Map<CliId, CliMcpStore>
  private readonly env: NodeJS.ProcessEnv
  private readonly probeFn: NonNullable<CliMcpConfigManagerOptions['probe']>
  private readonly probeCache = new Map<string, ProbeCacheEntry>()

  private readonly files?: CliMcpFileOwner
  private readonly probes?: McpProbeService
  private readonly scopes = new AsyncLocalStorage<RequestScope>()
  private readonly work = new Set<Promise<unknown>>()
  private closing = false
  constructor(options: CliMcpConfigManagerOptions = {}) {
    this.files = options.files; this.probes = options.probeService
    if (this.files && (!(this.probes instanceof McpProbeService) || options.stores || options.probe || !options.env || options.homeDir !== this.files.homeDir)) throw new Error('CLI_MCP_OWNER_UNAVAILABLE')
    this.env = this.files ? Object.freeze({ ...options.env }) : options.env ?? process.env
    this.stores = new Map((options.stores ?? createDefaultStores(this.env, options.homeDir, this.files)).map((store) => [store.cli, store]))
    // Portable probes borrow the real owner; the Electron wrapper injects its
    // lazy default explicitly, without an Electron import in this module.
    this.probeFn = this.files ? async input => {
      this.currentProbe(input)
      const receipt = this.probes!.probeOwned(input, this.scopes.getStore()?.signal, { beforeEffect: () => this.currentProbe(input) })
      try { const result = await receipt.result; this.current(); return result } finally { await receipt.closed }
    } : options.probe ?? (async () => ({ status: 'failed', error: 'MCP probe capability is unavailable.' }))
  }

  assertOwners(owners: { files: CliMcpFileOwner; probes: McpProbeService }): void {
    if (this.closing || owners.files !== this.files || owners.probes !== this.probes || this.probes?.isClosed) throw new Error('CLI_MCP_OWNER_LOST')
    this.files!.assertOwners(this.files!.homeDir)
    for (const store of this.stores.values()) (store as ClaudeCodeMcpStore).assertOwners(owners.files)
  }
  get inflightCount(): number { return this.work.size }
  shutdown(): void { this.closing = true }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid CLI MCP shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([(async () => { while (this.work.size) await Promise.allSettled([...this.work]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CLI_MCP_SHUTDOWN_INCOMPLETE')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private current(): void {
    if (this.closing) throw new Error('CLI_MCP_MANAGER_CLOSED')
    for (let scope = this.scopes.getStore(); scope; scope = scope.parent) { if (!scope.active || scope.signal.aborted) throw new Error('CLI_MCP_REQUEST_RETIRED'); scope.beforeEffect(); if (!scope.active || scope.signal.aborted) throw new Error('CLI_MCP_REQUEST_RETIRED') }
  }
  private currentProbe(input: McpServerProbeInput): void {
    this.current()
    const current = this.scopes.getStore()
    for (let scope = current; scope; scope = scope.parent) {
      for (const name of current?.references ?? []) scope.beforeReference?.(name)
      scope.beforeProbe?.(input)
      if (scope.binding && this.files) {
        for (const expected of scope.binding) if (this.files.readSnapshot(expected.path).hash !== expected.hash) throw new Error('CLI_MCP_PROBE_CONFIG_CHANGED')
      }
    }
    this.current()
  }
  withRequestGuard<T>(effect: () => Promise<T>, controls: CliMcpRequestControls): Promise<T> {
    this.current(); controls.beforeEffect(); if (controls.signal.aborted) return Promise.reject(new Error('CLI_MCP_REQUEST_RETIRED'))
    const scope: RequestScope = { ...controls, active: true, parent: this.scopes.getStore() }
    const raw = this.scopes.run(scope, async () => {
      try { const result = await (this.files ? this.files.withRequestGuard(effect, () => this.current(), controls.signal) : effect()); this.current(); return result }
      finally { scope.active = false }
    })
    this.work.add(raw); void raw.finally(() => this.work.delete(raw)).catch(() => {}); return raw
  }

  snapshot(): CliMcpSnapshot {
    this.current(); this.files?.preflight()
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
        const candidate = this.probeCache.get(cacheKey(store.cli, server.name))
        const cached = !this.files || candidate?.binding === hashContent(JSON.stringify(server.definition)) ? candidate : undefined
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
    this.current()
    const snapshot = { clis, servers, loadedAt: new Date().toISOString() }
    return this.files ? projectCliMcpResult('cliMcp:snapshot', snapshot) as unknown as CliMcpSnapshot : snapshot
  }

  /** Adds or edits a server in every target CLI. */
  upsert(request: CliMcpUpsertRequest): CliMcpMutationResult {
    this.current(); this.files?.preflight()
    const results: CliMcpApplyResult[] = []
    const name = request.name.trim()
    const targets = [...new Set(request.targets)]
    if (targets.length === 0) {
      return { results: [{ cli: 'claude-code', ok: false, error: 'Pick at least one CLI.', warnings: [] }], snapshot: this.snapshot() }
    }

    for (const cli of targets) {
      this.current()
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
    this.current(); this.files?.preflight()
    const result = this.applyTo(ref, { kind: 'remove', name: ref.name })
    if (result.ok) this.probeCache.delete(cacheKey(ref.cli, ref.name))
    return { results: [result], snapshot: this.snapshot() }
  }

  setEnabled(ref: CliMcpServerRef & { enabled: boolean }): CliMcpMutationResult {
    this.current(); this.files?.preflight()
    const result = this.applyTo(ref, { kind: 'setEnabled', name: ref.name, enabled: ref.enabled })
    return { results: [result], snapshot: this.snapshot() }
  }

  setToolEnabled(ref: CliMcpServerRef & { tool: string; enabled: boolean }): CliMcpMutationResult {
    this.current(); this.files?.preflight()
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
  probe(ref: CliMcpServerRef): Promise<CliMcpProbeResult> {
    this.current(); this.files?.preflight()
    const raw = this.executeProbe(ref); this.work.add(raw); void raw.finally(() => this.work.delete(raw)).catch(() => {}); return raw
  }
  private async executeProbe(ref: CliMcpServerRef): Promise<CliMcpProbeResult> {
    const store = this.stores.get(ref.cli)
    if (!store) return { status: 'failed', error: `Unknown CLI "${ref.cli}".`, checkedAt: new Date().toISOString() }
    const loaded = store.load()
    if (this.files && ref.expectedFingerprint !== undefined && ref.expectedFingerprint !== loaded.fingerprint) throw new ServiceProtocolError('INVALID_REQUEST')
    if (loaded.error) return { status: 'failed', error: loaded.error, checkedAt: new Date().toISOString() }
    const server = findServer(loaded, ref.name)
    if (!server) return { status: 'failed', error: `${CLI_LABELS[ref.cli]} has no MCP server named "${ref.name}".`, checkedAt: new Date().toISOString() }

    const issues = [...validateDefinition(server.definition), ...(this.files ? server.issues : [])]
    if (issues.length > 0) {
      const result: CliMcpProbeResult = { status: 'failed', error: issues.join(' '), checkedAt: new Date().toISOString() }
      this.probeCache.set(cacheKey(ref.cli, ref.name), { probe: result, binding: this.files ? hashContent(JSON.stringify(server.definition)) : undefined })
      return result
    }

    const requestScope = this.scopes.getStore()
    if (this.files && (!requestScope?.beforeProbe || !requestScope.beforeReference)) throw new Error('CLI_MCP_PROBE_AUTHORITY_UNAVAILABLE')
    if (this.files && requestScope) {
      requestScope.references = [...new Set([...Object.values(server.definition.env ?? {}), ...Object.values(server.definition.headers ?? {})].flatMap(referenceNames))]
      if (requestScope.references.length > 128 || requestScope.references.some(name => name.length > 128)) throw new Error('CLI_MCP_PROBE_REFERENCE_LIMIT')
      for (let scope: RequestScope | undefined = requestScope; scope; scope = scope.parent) for (const name of requestScope.references) scope.beforeReference?.(name)
    }
    const env = resolveReferences(server.definition.env, this.env)
    const headers = resolveReferences(server.definition.headers, this.env)
    const unresolved = [...new Set([...env.unresolved, ...headers.unresolved])]
    const input: McpServerProbeInput = server.definition.transport === 'stdio'
      ? { name: server.name, type: 'local', command: server.definition.command, args: server.definition.args, environment: env.values }
      : { name: server.name, type: 'remote', url: server.definition.url, headers: headers.values }

    const scope = this.scopes.getStore()
    if (this.files) {
      if (ref.expectedFingerprint !== undefined && loaded.fingerprint !== ref.expectedFingerprint) return { status: 'failed', error: 'The CLI configuration changed; reload before probing.', checkedAt: new Date().toISOString() }
      for (const value of [...Object.values(input.environment ?? {}), ...Object.values(input.headers ?? {})]) if (typeof value !== 'string' || Buffer.byteLength(value) > 16384 || value.includes('\0') || value === MASKED_SECRET) throw new Error('CLI_MCP_PROBE_INPUT_LIMIT')
      if (scope) scope.binding = loaded.files.map(file => ({ path: file.path, hash: file.hash }))
      this.currentProbe(input)
    }
    const probe = await this.probeFn(input)
    if (this.files) this.currentProbe(input)
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
    const publicResult = this.files ? projectCliMcpResult('cliMcp:probe', result) as unknown as CliMcpProbeResult : result
    const candidate = this.probeCache.get(cacheKey(ref.cli, ref.name)), binding = this.files ? hashContent(JSON.stringify(server.definition)) : undefined
    const previous = !this.files || candidate?.binding === binding ? candidate : undefined
    this.probeCache.set(cacheKey(ref.cli, ref.name), {
      binding,
      // Keep the last good tool list through a transient failure.
      tools: publicResult.tools ?? previous?.tools,
      probe: { status: publicResult.status, error: publicResult.error, errorDetail: publicResult.errorDetail, toolCount: publicResult.toolCount, checkedAt }
    })
    this.current()
    return publicResult
  }

  private applyTo(ref: CliMcpServerRef, mutation: CliMcpMutation): CliMcpApplyResult {
    this.current()
    const store = this.stores.get(ref.cli)
    if (!store) return { cli: ref.cli, ok: false, error: `Unknown CLI "${ref.cli}".`, warnings: [] }
    return store.apply(ref.expectedFingerprint, () => mutation)
  }

  private reconcileDefinition(
    name: string,
    incoming: McpServerDefinition,
    onDisk: McpServerDefinition | undefined
  ): { definition: McpServerDefinition; warnings: string[] } {
    if (this.files && onDisk?.url) {
      let saved: URL | undefined
      try { saved = new URL(onDisk.url) } catch { /* An explicitly replaced malformed URL can be repaired. */ }
      if (saved && (saved.username || saved.password || saved.search || saved.hash)) throw new Error('CLI_MCP_PRIVATE_URL_EDIT_UNAVAILABLE')
    }
    if (this.files) for (const kind of ['env', 'headers'] as const) for (const [key, value] of Object.entries(incoming[kind] ?? {})) {
      const saved = onDisk?.[kind]?.[key]
      if (value === MASKED_SECRET && (typeof saved !== 'string' || !saved || saved === MASKED_SECRET)) throw new Error('CLI_MCP_MASKED_VALUE_UNAVAILABLE')
    }
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
