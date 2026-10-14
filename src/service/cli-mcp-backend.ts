import { CliMcpConfigManager } from '../main/cli-mcp-config/core'
import { CliMcpFileOwner } from '../main/cli-mcp-config/portable-file-owner'
import { McpProbeService, type McpServerProbeInput } from '../main/agent-manager/mcp-probe-service'
import { CLI_IDS, type CliId, type CliMcpServerRef, type CliMcpUpsertRequest } from '../shared/cli-mcp-config'
import { CLI_MCP_CODECS, CLI_MCP_OPERATIONS, projectCliMcpResult, type CliMcpOperation } from '../shared/cli-mcp-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface CliMcpBackendOptions {
  manager: CliMcpConfigManager
  files: CliMcpFileOwner
  probes: McpProbeService
  engineEpoch: string
  assertAvailable(): void
  assertCliMcpOwners(owners: Pick<CliMcpBackendOptions, 'manager' | 'files' | 'probes'>): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageConfiguration(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canAccessCli(cli: CliId, caller: DesktopCallerContext, access: 'read' | 'write'): boolean
  canProbeCli(ref: CliMcpServerRef, caller: DesktopCallerContext): boolean
  canProbeServer(input: McpServerProbeInput, caller: DesktopCallerContext): boolean
  canUseEnvironmentReference(name: string, caller: DesktopCallerContext): boolean
  runConfigurationMutation?<T>(targets: readonly CliId[], caller: DesktopCallerContext, beforeEffect: () => void, effect: () => Promise<T>): Promise<T>
}
/** Captured real CLI stores/probe owner, with separate configuration and probe
 * grants. No request can choose a host path, subprocess environment or owner. */
export class CliMcpBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly work = new Set<Promise<unknown>>()
  private readonly requests = new Set<AbortController>()
  constructor(private readonly options: CliMcpBackendOptions) {
    if (!(options.manager instanceof CliMcpConfigManager) || !(options.files instanceof CliMcpFileOwner) || !(options.probes instanceof McpProbeService)) throw new ServiceProtocolError('DISCONNECTED')
    this.available()
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of CLI_MCP_OPERATIONS) this.bind(operation)
  }
  get inflightCount(): number { return this.work.size }
  shutdown(): void { this.closing = true; for (const request of this.requests) request.abort() }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid CLI MCP backend shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([(async () => { while (this.work.size) await Promise.allSettled([...this.work]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertCliMcpOwners(this.options)
    this.options.manager.assertOwners(this.options); this.options.files.assertOwners(this.options.files.homeDir)
  }
  private authorize(operation: CliMcpOperation, args: readonly unknown[], caller: DesktopCallerContext): void {
    this.available()
    if (caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !this.options.isTrustedDesktop(caller) || !this.options.canManageConfiguration(caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
    const probe = operation === 'cliMcp:probe', snapshot = operation === 'cliMcp:snapshot'
    const targets: CliId[] = operation === 'cliMcp:upsert' ? (args[0] as CliMcpUpsertRequest).targets : snapshot ? [...CLI_IDS] : [(args[0] as CliMcpServerRef).cli]
    const reads = probe ? targets : CLI_IDS
    if (reads.some(cli => !this.options.canAccessCli(cli, caller, 'read')) || !snapshot && !probe && (!this.options.canManageConfiguration(caller, 'write') || targets.some(cli => !this.options.canAccessCli(cli, caller, 'write'))) || probe && !this.options.canProbeCli(args[0] as CliMcpServerRef, caller)) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(CLI_MCP_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && CLI_MCP_CODECS[operation].validateArguments(CLI_MCP_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: CLI_MCP_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal),
    }]))
  }
  private bind(operation: CliMcpOperation): void {
    const codec = CLI_MCP_CODECS[operation]
    this.registry.bindCommand(operation, {
      decodeRequest: codec.decodeArguments, validateArguments: codec.validateArguments,
      authorize: (args, caller) => { this.authorize(operation, args, caller); return true },
      validateResult: codec.validateResult, encodeResult: codec.encodeResult,
      invoke: (decoded, caller, signal) => {
        if (this.work.size >= 64) throw new ServiceProtocolError('BACKPRESSURE')
        const args = structuredClone(decoded), request = new AbortController()
        this.requests.add(request)
        const cancel = (): void => request.abort(); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
        const current = (): void => { this.available(request.signal); this.authorize(operation, args, caller) }
        const raw = this.options.manager.withRequestGuard(async () => {
          current(); const manager = this.options.manager
          const execute = async () => {
            if (operation !== 'cliMcp:snapshot' && operation !== 'cliMcp:probe') {
              const before = manager.snapshot()
              if (operation === 'cliMcp:upsert') {
                const data = args[0] as CliMcpUpsertRequest
                const additions = data.targets.filter(cli => !before.servers.some(server => server.cli === cli && (server.name === data.name.trim() || server.name === (data.previousName ?? data.name.trim())))).length
                if (before.servers.length + additions > 128) throw new ServiceProtocolError('INVALID_ARGUMENTS')
              }
              current()
            }
            return operation === 'cliMcp:snapshot' ? manager.snapshot() : operation === 'cliMcp:upsert' ? manager.upsert(args[0] as CliMcpUpsertRequest)
            : operation === 'cliMcp:remove' ? manager.remove(args[0] as CliMcpServerRef)
            : operation === 'cliMcp:setEnabled' ? manager.setEnabled(args[0] as CliMcpServerRef & { enabled: boolean })
            : operation === 'cliMcp:setToolEnabled' ? manager.setToolEnabled(args[0] as CliMcpServerRef & { tool: string; enabled: boolean })
            : await manager.probe(args[0] as CliMcpServerRef)
          }
          const mutation = operation !== 'cliMcp:snapshot' && operation !== 'cliMcp:probe'
          const targets = operation === 'cliMcp:upsert' ? (args[0] as CliMcpUpsertRequest).targets : mutation ? [(args[0] as CliMcpServerRef).cli] : []
          const result = mutation && this.options.runConfigurationMutation ? await this.options.runConfigurationMutation(Object.freeze([...targets]), caller, current, async () => { current(); const result = await execute(); current(); return result }) : await execute()
          current(); return projectCliMcpResult(operation, result)
        }, { beforeEffect: current, signal: request.signal, beforeProbe: input => { current(); if (!this.options.canProbeServer(input, caller)) throw new ServiceProtocolError('INVALID_REQUEST') }, beforeReference: name => { current(); if (!this.options.canUseEnvironmentReference(name, caller)) throw new ServiceProtocolError('INVALID_REQUEST') } })
        this.work.add(raw)
        void raw.finally(() => { this.work.delete(raw); this.requests.delete(request); signal.removeEventListener('abort', cancel) }).catch(() => {})
        return raw as never
      },
    })
  }
}
