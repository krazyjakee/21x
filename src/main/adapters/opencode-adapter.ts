import { Agent as UndiciAgent } from 'undici'
import { homedir } from 'os'
import { buildMergedOpencodeConfig } from '../utils/opencode-config'
import type { DatabaseManager } from '../database'
import type {
  CodingAgentAdapter,
  McpServerConfig,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart,
  AdapterUsageReport
} from './coding-agent-adapter'
import { SessionStatusType } from './coding-agent-adapter'
import { opencodeMessageUsage } from './usage-reports'
import { attachAndVerifyMcpServers, disconnectMcpServers, type McpAttachResult } from './opencode-mcp'
import {
  removeRuntimePluginFiles,
  setTillDoneSession,
  writeRuntimePluginFiles
} from './opencode-runtime-plugins'
import {
  DEFAULT_SERVER_URL,
  ensureOpencodeBinaryPaths,
  findAccessibleServer,
  killServerAndClearDatabase,
  streamServerEvents
} from './opencode-server'
import {
  convertAllMessages,
  convertPolledParts,
  convertResumedMessages,
  findActiveToolInLastAssistantMessage,
  listRunningTools,
  type OpencodeMessage
} from './opencode-messages'

let OpenCodeSDK: typeof import('@opencode-ai/sdk') | null = null

type OpencodeClient = import('@opencode-ai/sdk').OpencodeClient
type OpenCodeV2Module = typeof import('@opencode-ai/sdk/v2')
type V2ClientModule = typeof import('@opencode-ai/sdk/v2/client')
type V2OpencodeClient = import('@opencode-ai/sdk/v2/client').OpencodeClient
type V2QuestionRequest = import('@opencode-ai/sdk/v2/client').QuestionRequest
let OpenCodeV2: OpenCodeV2Module | null = null
let OpenCodeV2Client: V2ClientModule | null = null

// Custom fetch with no timeout — used ONLY for session.prompt() which stays open
// for the entire agent loop (including all tool calls). All other SDK calls use the
// default fetch which has the SDK's built-in 60s timeout.
const noTimeoutAgent = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 })
const noTimeoutFetch = (req: unknown) => (globalThis as unknown as Record<string, (...args: unknown[]) => unknown>).fetch(req, { dispatcher: noTimeoutAgent })

// Fetch with reasonable timeout for quick operations (health checks, config queries, provider listing)
const QUICK_OP_TIMEOUT_MS = 15_000
const quickTimeoutAgent = new UndiciAgent({ headersTimeout: QUICK_OP_TIMEOUT_MS, bodyTimeout: QUICK_OP_TIMEOUT_MS })
const quickTimeoutFetch = (req: unknown) => (globalThis as unknown as Record<string, (...args: unknown[]) => unknown>).fetch(req, { dispatcher: quickTimeoutAgent })

type SessionMcpConfig = Record<string, McpServerConfig>

interface ProvidersResult {
  providers: { id: string; name: string; models: unknown; [key: string]: unknown }[]
  default: Record<string, string>
}

/** OpenCode permission replies: "once" (allow this time), "always" (remember), "reject" (deny). */
function permissionReply(approved: boolean, optionId?: string): 'once' | 'always' | 'reject' {
  if (!approved) return 'reject'
  return optionId === 'allow-always' || optionId === 'approved-for-session' ? 'always' : 'once'
}

/**
 * Adapter for the OpenCode backend. One shared `opencode serve` process (spawned
 * or adopted) serves every session over HTTP; permission prompts arrive over SSE.
 */
export class OpencodeAdapter implements CodingAgentAdapter {
  /** Callback set by agent-manager to trigger an immediate poll cycle */
  onDataAvailable?: (sessionId: string) => void
  /** Set by agent-manager: receives the token usage the backend reports (#97). */
  onUsage?: (report: AdapterUsageReport) => void
  private sdkLoading: Promise<void> | null = null
  private serverInstance: unknown = null
  private serverUrl: string | null = null
  private serverStarting: Promise<void> | null = null
  /** The shared V2 SDK client created alongside the server via createOpencode */
  private sharedClient: V2OpencodeClient | null = null
  /** A separate V2 client with a reasonable timeout for quick operations (config, providers, health) */
  private quickClient: V2OpencodeClient | null = null
  private clients: Map<string, OpencodeClient> = new Map() // sessionId -> ocClient (default timeout, for polling/status/create)
  /**
   * Usage reporting per session (#97): assistant messages finished after the
   * session was registered here, and the ones already reported. A resumed
   * session's older messages are history, not turns of this run.
   */
  private usageSeen: Map<string, { since: number; reported: Set<string> }> = new Map()
  /** Separate clients with no timeout, used ONLY for session.prompt() which runs indefinitely */
  private promptClients: Map<string, OpencodeClient> = new Map()
  private v2Client: V2OpencodeClient | null = null
  private promptAborts: Map<string, AbortController> = new Map()
  /** Provider errors captured from prompt results (surfaced via getStatus) */
  private promptErrors: Map<string, string> = new Map()
  /** Absolute paths to generated OpenCode plugin files registered for this session/workspace */
  private pluginFilePaths: string[] = []
  /** Absolute paths to generated support files used by runtime plugins */
  private runtimeSupportFilePaths: string[] = []
  /** Absolute path to the generated tillDone config support file */
  private tillDoneConfigPath: string | null = null
  /** Whether the merged config has been pushed at least once to the running server.
   *  Config is pushed once on first server connection; subsequent pushes happen only
   *  via explicit `notifyConfigChanged()` calls (e.g. after settings edit or key rotation).
   *  This avoids PATCH /global/config storms that abort all running sessions. */
  private configPushed = false
  /** Maximum number of automatic retries for transient prompt errors (e.g. "Aborted") */
  private static readonly PROMPT_MAX_RETRIES = 3
  /** Base delay (ms) for exponential backoff between prompt retries */
  private static readonly PROMPT_RETRY_BASE_DELAY_MS = 2_000
  /** Pending permission requests per session (captured from SSE events).
   *  Each session may have multiple pending permissions (parallel tool calls). */
  private pendingPermissions: Map<string, Array<{ permissionId: string; permission: string; patterns: string[] }>> = new Map()
  /** Abort controller for the SSE event subscription */
  private sseAbort: AbortController | null = null
  /** Per-session permission mode ('ask' = surface in UI, 'allow' = auto-approve) */
  private sessionPermissionModes: Map<string, 'ask' | 'allow'> = new Map()
  /** Per-session workspace directory — needed for permission replies and other
   *  session-scoped V2 API calls initiated from global SSE events. */
  private sessionWorkspaceDirs: Map<string, string> = new Map()
  /** Per-session MCP server configs — retained for re-registration on session resume
   *  (e.g. after 20x restart when stdio MCP server processes are dead). */
  private sessionMcpConfigs: Map<string, SessionMcpConfig> = new Map()
  /** Per-session names of MCP servers that could not be attached. Read by the
   *  agent-manager so the session documentation does not advertise tools that
   *  are not there. */
  private sessionMcpAttachFailures: Map<string, string[]> = new Map()
  /** Per-directory record of the MCP config that is already registered, as
   *  `directory -> name -> serialized config`. Used to skip a re-add that would
   *  rebuild a server another session is currently using. See registerMcpServers. */
  private directoryMcpConfigs: Map<string, Map<string, string>> = new Map()

  constructor(private db?: Pick<DatabaseManager, 'getSetting'>) {
    this.sdkLoading = this.loadSDK()
  }

  private async loadSDK(): Promise<void> {
    try {
      OpenCodeSDK = await import('@opencode-ai/sdk')
      OpenCodeV2 = await import('@opencode-ai/sdk/v2')
      OpenCodeV2Client = await import('@opencode-ai/sdk/v2/client')
      console.log('[OpencodeAdapter] SDK loaded successfully (v2 available)')
    } catch (error) {
      console.error('[OpencodeAdapter] Failed to load SDK:', error)
    } finally {
      this.sdkLoading = null
    }
  }

  private async ensureSDKLoaded(): Promise<void> {
    if (OpenCodeSDK) return
    if (this.sdkLoading) {
      await this.sdkLoading
    }
    if (!OpenCodeSDK) {
      throw new Error('OpenCode SDK not loaded')
    }
  }

  async initialize(): Promise<void> {
    await this.ensureSDKLoaded()
  }

  /** The MCP config OpenCode is known to hold for a directory, created on demand. */
  private getDirectoryMcpConfigs(workspaceDir: string | undefined): Map<string, string> {
    const key = workspaceDir ?? ''
    let entry = this.directoryMcpConfigs.get(key)
    if (!entry) {
      entry = new Map<string, string>()
      this.directoryMcpConfigs.set(key, entry)
    }
    return entry
  }

  /**
   * Re-attach the MCP servers of every live session after OpenCode threw away the
   * instance that held them.
   *
   * OpenCode disposes and re-creates the instance of a directory on its own — a
   * config patch on that directory is enough. The new instance starts from the
   * config files, so it keeps only the servers declared in
   * `.opencode/opencode.json`, and the running session loses the rest from its tool
   * list without any error. This handler is the second line of defence behind that
   * file: it re-registers the servers and, above all, it makes the drop visible.
   * Without it the first sign of trouble is the model calling a tool that the
   * session no longer has.
   */
  private async handleInstanceDisposed(directory: string | undefined, eventType: string): Promise<void> {
    // `global.disposed` carries no directory: every instance is gone, so every
    // session has to be re-attached.
    const affected: string[] = []
    for (const [sessionId, mcpServers] of this.sessionMcpConfigs.entries()) {
      if (Object.keys(mcpServers).length === 0) continue
      const sessionDir = this.sessionWorkspaceDirs.get(sessionId)
      if (directory && sessionDir !== directory) continue
      affected.push(sessionId)
    }

    if (affected.length === 0) return

    console.error(
      `[OpencodeAdapter] MCP DROPPED — OpenCode ${eventType}` +
      `${directory ? ` for ${directory}` : ' (all directories)'}. ` +
      `${affected.length} live session(s) lost their MCP tools mid-conversation; re-attaching: ${affected.join(', ')}`
    )

    for (const sessionId of affected) {
      const mcpServers = this.sessionMcpConfigs.get(sessionId)
      const ocClient = this.clients.get(sessionId)
      if (!mcpServers || !ocClient) continue

      try {
        const sessionDir = this.sessionWorkspaceDirs.get(sessionId)
        const result = await attachAndVerifyMcpServers(
          ocClient,
          mcpServers as unknown as Record<string, McpServerConfig>,
          sessionDir,
          `instanceDisposed session=${sessionId}`,
          this.getDirectoryMcpConfigs(sessionDir)
        )
        this.setMcpAttachFailures(sessionId, result.failed)
        if (result.failed.length === 0) {
          console.log(`[OpencodeAdapter] MCP re-attached after ${eventType} for session ${sessionId}`)
        }
      } catch (err) {
        console.error(
          `[OpencodeAdapter] MCP re-attach failed for session ${sessionId}:`,
          err instanceof Error ? err.message : err
        )
      }
    }
  }

  private setMcpAttachFailures(sessionId: string, failed: string[]): void {
    if (failed.length > 0) {
      this.sessionMcpAttachFailures.set(sessionId, [...failed])
    } else {
      this.sessionMcpAttachFailures.delete(sessionId)
    }
  }

  /**
   * Names of MCP servers that are configured for the session but are NOT
   * attached to the OpenCode backend, so none of their tools can be called.
   */
  getMcpAttachFailures(sessionId: string): string[] {
    return this.sessionMcpAttachFailures.get(sessionId) ?? []
  }

  /**
   * Disconnect the MCP servers that were attached for a session.
   *
   * Each attached stdio server is a child process of the shared `opencode serve`
   * process, and it lives as long as that server does — which is days, because
   * the server is shared and often adopted rather than spawned. Without this the
   * stdio children accumulate one per session (the task-management-mcp leak).
   * Servers still needed by another live session are kept.
   */
  private async disconnectSessionMcpServers(sessionId: string): Promise<void> {
    const ownConfig = this.sessionMcpConfigs.get(sessionId)
    const client = this.clients.get(sessionId)
    if (!ownConfig || !client) return

    const stillNeeded = new Set<string>()
    for (const [otherSessionId, otherConfig] of this.sessionMcpConfigs.entries()) {
      if (otherSessionId === sessionId) continue
      for (const name of Object.keys(otherConfig)) stillNeeded.add(name)
    }
    const names = Object.keys(ownConfig).filter((name) => !stillNeeded.has(name))
    const workspaceDir = this.sessionWorkspaceDirs.get(sessionId)
    await disconnectMcpServers(client, names, workspaceDir, sessionId, this.getDirectoryMcpConfigs(workspaceDir))
  }

  /**
   * Returns the shared SDK client, ensuring the server is running first.
   * Pass `quick: true` to get a client with a bounded timeout (for config queries, health checks).
   */
  private async getClient(serverUrl?: string, opts?: { quick?: boolean }): Promise<V2OpencodeClient> {
    const baseUrl = serverUrl || this.serverUrl || DEFAULT_SERVER_URL
    await this.ensureServerRunning(baseUrl)

    if (opts?.quick) {
      if (!this.quickClient) {
        throw new Error('OpenCode quick client not available after server startup')
      }
      return this.quickClient
    }

    if (!this.sharedClient) {
      throw new Error('OpenCode client not available after server startup')
    }
    return this.sharedClient
  }

  /**
   * Push the merged provider/auth config to the running OpenCode server.
   *
   * ⚠️  PATCH /global/config causes the server to call disposeAllInstancesAndEmitGlobalDisposed(),
   * which aborts every running session processor AND disconnects all MCP servers.
   *
   * Strategy:
   *   - When sessions are active: push via directory-scoped PATCH /config for each
   *     active session directory. This updates the config without killing MCP connections.
   *   - When no sessions are active: safe to use global endpoint.
   */
  private async pushMergedConfigToClient(client: V2OpencodeClient): Promise<void> {
    const hasActivePrompts = this.promptAborts.size > 0

    try {
      const mergedConfig = buildMergedOpencodeConfig()
      if (!mergedConfig.provider) {
        console.log('[OpencodeAdapter] pushMergedConfigToClient: no providers in merged config, skipping')
        return
      }

      const providerIds = Object.keys(mergedConfig.provider as Record<string, unknown>)
      console.log('[OpencodeAdapter] pushMergedConfigToClient: pushing providers:', providerIds.join(', '))

      const castConfig = mergedConfig as import('@opencode-ai/sdk/v2/client').Config

      if (hasActivePrompts) {
        // Sessions are running — use directory-scoped config updates to avoid
        // disposeAllInstances which would kill MCP connections.
        console.log(`[OpencodeAdapter] pushMergedConfigToClient: ${this.promptAborts.size} prompt(s) active — using directory-scoped config push`)
        const directories = new Set(this.sessionWorkspaceDirs.values())
        if (directories.size > 0) {
          for (const dir of directories) {
            try {
              await client.config.update({ config: castConfig, directory: dir })
            } catch {
              // Individual directory push failed — non-fatal
            }
          }
        } else {
          // No directories known — fall back to global as last resort
          console.warn('[OpencodeAdapter] pushMergedConfigToClient: no known directories, using global endpoint (may disrupt active sessions)')
          await client.global.config.update({ config: castConfig })
        }
      } else {
        // No active sessions — safe to use global endpoint
        try {
          const result = await client.global.config.update({ config: castConfig })
          if (result.error) {
            console.warn('[OpencodeAdapter] global.config.update returned error:', JSON.stringify(result.error))
            throw new Error('global.config.update returned error')
          }
        } catch {
          const result = await client.config.update({ config: castConfig })
          if (result.error) {
            console.warn('[OpencodeAdapter] config.update returned error:', JSON.stringify(result.error))
          }
        }
      }
      this.configPushed = true
    } catch (err) {
      console.warn('[OpencodeAdapter] pushMergedConfigToClient failed:', err instanceof Error ? err.message : err)
    }
  }

  /**
   * Notify the adapter that provider config has changed (e.g. user edited agent
   * settings). Pushes the updated config to the running server.
   *
   * Call this from the agent-manager when settings change — do NOT call it on every
   * createSession or getClient, since PATCH /global/config aborts all running sessions.
   */
  async notifyConfigChanged(): Promise<void> {
    if (!this.sharedClient) {
      console.log('[OpencodeAdapter] notifyConfigChanged: no server connection yet, skipping')
      return
    }
    console.log('[OpencodeAdapter] notifyConfigChanged: pushing updated config to server')
    await this.pushMergedConfigToClient(this.sharedClient)
  }

  async getProviders(serverUrl?: string, directory?: string, allowRecovery = true): Promise<ProvidersResult | null> {
    try {
      const client = await this.getClient(serverUrl, { quick: true })

      // Push the merged config if it hasn't been pushed yet. This handles the
      // edge case where getProviders is called before any session has started
      // (e.g. the user opens settings immediately after app launch). Once config
      // has been pushed via ensureServerRunning, this is a no-op. Subsequent
      // config changes go through notifyConfigChanged().
      if (!this.configPushed) {
        await this.pushMergedConfigToClient(client)
      }

      // Always pass a writable directory so the OpenCode server doesn't fall
      // back to its CWD (which is read-only on macOS when launched from
      // /Applications). Without this, fromDirectory() in the server tries to
      // create an SQLite DB at the CWD and fails with "disk I/O error".
      const safeDirectory = directory || homedir()

      const result = await client.config.providers({
        directory: safeDirectory
      })

      if (result.error) {
        const errorStr = JSON.stringify(result.error)

        // Detect SQLite database errors from the server (corrupted DB, stale WAL
        // files, migration failures from opencode version upgrades).
        // Recovery: kill the stale server, clear its DB, reset state, retry once.
        if (allowRecovery && errorStr.includes('SQLiteError')) {
          console.warn('[OpencodeAdapter] SQLite error from server, attempting recovery:', errorStr)
          await this.recoverFromBrokenServer()
          return this.getProviders(serverUrl, directory, false)
        }

        console.log('[OpencodeAdapter] No providers configured on server:', errorStr)
        return null
      }

      const data = result.data as Partial<ProvidersResult> | undefined

      return data ? { providers: data.providers || [], default: data.default || {} } : null
    } catch (error: unknown) {
      console.log('[OpencodeAdapter] Could not get providers:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /**
   * Recover from a broken opencode server by killing it, clearing its
   * corrupted database, and resetting adapter state so the next call
   * spawns a fresh server.
   */
  private async recoverFromBrokenServer(): Promise<void> {
    console.log('[OpencodeAdapter] Starting recovery: stopping broken server and clearing database')

    // stopServer() also resets the client state, so the next getClient()
    // spawns a fresh server.
    await this.stopServer()
    killServerAndClearDatabase()

    // Brief pause to let the OS release the port
    await new Promise(resolve => setTimeout(resolve, 500))

    console.log('[OpencodeAdapter] Recovery complete, will spawn fresh server on next call')
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      const client = await this.getClient(undefined, { quick: true })
      const result = await client.global.health()

      if (result.error) {
        return { available: false, reason: 'Server not responding' }
      }

      const health = result.data as { healthy: boolean; version: string }
      if (health?.healthy !== true) return { available: false, reason: 'Server protocol health check is unhealthy' }
      console.log('[OpencodeAdapter] Health check OK, version:', health.version)
      return { available: true }
    } catch (error: unknown) {
      return { available: false, reason: error instanceof Error ? error.message : 'Server not accessible' }
    }
  }

  private async ensureServerRunning(targetUrl: string = DEFAULT_SERVER_URL): Promise<void> {
    if (this.serverUrl === targetUrl) return

    if (this.serverStarting) {
      return this.serverStarting
    }

    await this.ensureSDKLoaded()

    ensureOpencodeBinaryPaths(this.db?.getSetting('OPENCODE_BINARY_PATH') ?? null)

    // Set bash tool timeout if not already configured.
    // Without this, bash commands inside the agent run indefinitely — a single
    // hung `npm install` or `git clone` will keep the session stuck forever.
    // 10 minutes is generous enough for legitimate long-running commands while
    // preventing truly stuck processes.
    if (!process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS) {
      process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = '600000' // 10 minutes
      console.log('[OpencodeAdapter] Set OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=600000 (10min)')
    }

    const isDefaultUrl = targetUrl === DEFAULT_SERVER_URL || targetUrl === 'http://127.0.0.1:4096'

    this.serverStarting = (async () => {
      try {
        const accessibleUrl = await findAccessibleServer(targetUrl)
        if (accessibleUrl) {
          this.serverUrl = accessibleUrl
          this.serverInstance = null
          // Create a V2 client for the existing server (has global.health())
          this.sharedClient = OpenCodeV2Client!.createOpencodeClient({
            baseUrl: accessibleUrl
          })
          // Create a separate client with bounded timeout for quick operations
          this.quickClient = OpenCodeV2Client!.createOpencodeClient({
            baseUrl: accessibleUrl,
            fetch: quickTimeoutFetch as unknown as typeof fetch
          })

          // Push merged config (with auth.json keys injected) once on first connection
          // so custom providers like routerAI are properly authenticated.
          // This is the ONLY automatic config push; subsequent pushes happen only via
          // explicit notifyConfigChanged() calls to avoid aborting running sessions.
          try {
            // Use quickClient to avoid hanging indefinitely when the existing server is slow.
            await this.pushMergedConfigToClient(this.quickClient!)
          } catch {
            // pushMergedConfigToClient already logs details
          }

          // Start SSE subscription for permission events
          this.startEventSubscription()
          return
        }

        if (!isDefaultUrl) {
          throw new Error(`OpenCode server not accessible at ${targetUrl}`)
        }

        // Use SDK's createOpencode (starts server + client together, per docs).
        // The SDK picks up opencode.json automatically; we pass a merged config
        // that injects auth.json API keys into custom provider options so
        // providers like routerAI are properly authenticated.
        const url = new URL(targetUrl)
        const hostname = url.hostname
        const port = parseInt(url.port || '4096', 10)

        const extraConfig: Record<string, unknown> = {}
        if (this.pluginFilePaths.length > 0) {
          extraConfig.plugin = [...this.pluginFilePaths]
          console.log('[OpencodeAdapter] Passing plugins to server config:', this.pluginFilePaths)
        }
        const mergedConfig = buildMergedOpencodeConfig(extraConfig)

        console.log(`[OpencodeAdapter] Creating opencode instance at ${hostname}:${port} via SDK v2 createOpencode`)
        const { client, server } = await OpenCodeV2!.createOpencode({
          hostname,
          port,
          timeout: 10000,
          config: mergedConfig as import('@opencode-ai/sdk/v2/client').Config
        })

        this.serverInstance = server
        this.serverUrl = server.url
        this.sharedClient = client
        // Create a separate client with bounded timeout for quick operations
        this.quickClient = OpenCodeV2Client!.createOpencodeClient({
          baseUrl: server.url,
          fetch: quickTimeoutFetch as unknown as typeof fetch
        })
        console.log(`[OpencodeAdapter] OpenCode instance created at ${server.url}`)
      } finally {
        this.serverStarting = null
        // Start SSE subscription for permission events once the server is up
        this.startEventSubscription()
      }
    })()

    return this.serverStarting
  }

  /**
   * Prepares the server side of a session: writes runtime plugins (BEFORE the
   * server starts, so they are discovered at startup), creates the session's
   * clients, registers the plugins, and attaches the MCP servers.
   *
   * Config is NOT pushed here. It is pushed once on first server connection;
   * later changes go through notifyConfigChanged(). Pushing on every session
   * caused a storm of PATCH /global/config calls that aborted all running
   * sessions when parallel tasks started.
   */
  private async connectSession(config: SessionConfig, context: string): Promise<{
    ocClient: OpencodeClient
    promptClient: OpencodeClient
    attachResult: McpAttachResult
  }> {
    this.writeRuntimePluginFiles(config)
    await this.ensureServerRunning(config.serverUrl || DEFAULT_SERVER_URL)

    const baseUrl = this.serverUrl || config.serverUrl || DEFAULT_SERVER_URL
    // SDK default timeout (60s) for create, polling, MCP ops, etc.
    const ocClient = OpenCodeSDK!.createOpencodeClient({ baseUrl })
    // No timeout — used ONLY for session.prompt(), which runs for the whole agent loop
    const promptClient = OpenCodeSDK!.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as unknown as (request: Request) => ReturnType<typeof fetch> })

    // Runtime plugins and MCP servers are declared in
    // `<workspaceDir>/.opencode/opencode.json`, written by writeRuntimePluginFiles()
    // above. Do NOT push them with config.update() — see the comment on
    // writeWorkspaceOpencodeConfig(): that call rewrites `<dir>/config.json`, which
    // makes OpenCode dispose and re-create the whole instance for that directory and
    // silently drop every MCP server that was registered at runtime.

    // MCP servers are attached before session create so the session picks
    // them up. On resume after a 20x restart the stdio MCP processes are dead
    // and remote servers may have lost their SSE connections. Mid-session drops
    // are handled by the `server.instance.disposed` listener in
    // handleServerEvent(), which re-attaches and logs the drop.
    const attachResult = config.mcpServers
      ? await attachAndVerifyMcpServers(ocClient, config.mcpServers, config.workspaceDir, context, this.getDirectoryMcpConfigs(config.workspaceDir))
      : { attached: [], failed: [] }

    return { ocClient, promptClient, attachResult }
  }

  private registerSession(
    sessionId: string,
    config: SessionConfig,
    connection: { ocClient: OpencodeClient; promptClient: OpencodeClient; attachResult: McpAttachResult }
  ): void {
    setTillDoneSession(this.tillDoneConfigPath, sessionId, config.tillDone !== false)
    this.clients.set(sessionId, connection.ocClient)
    this.usageSeen.set(sessionId, { since: Date.now(), reported: new Set() })
    this.promptClients.set(sessionId, connection.promptClient)
    this.sessionPermissionModes.set(sessionId, config.permissionMode || 'ask')
    if (config.workspaceDir) this.sessionWorkspaceDirs.set(sessionId, config.workspaceDir)
    if (config.mcpServers) this.sessionMcpConfigs.set(sessionId, config.mcpServers)
    this.setMcpAttachFailures(sessionId, connection.attachResult.failed)
  }

  async createSession(config: SessionConfig): Promise<string> {
    const connection = await this.connectSession(config, `createSession task=${config.taskId}`)

    const result = await connection.ocClient.session.create({
      body: { title: `Task ${config.taskId}` },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (result.error) {
      const errData = result.error as { data?: { message?: string }; name?: string }
      throw new Error(errData.data?.message || errData.name || 'Failed to create session')
    }
    if (!result.data?.id) {
      throw new Error('No session ID returned from OpenCode')
    }

    this.registerSession(result.data.id, config, connection)
    return result.data.id
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const connection = await this.connectSession(config, `resumeSession session=${sessionId}`)
    const { ocClient } = connection

    // Validate session exists
    const getResult = await ocClient.session.get({
      path: { id: sessionId },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (getResult.error || !getResult.data) {
      throw new Error('Session no longer exists on server')
    }

    // ── Clean up stale session state from previous app instance ──
    // When the app restarts and resumes a session, tool calls from the
    // previous instance may still be in "running" state.  The OpenCode
    // server reports these as "busy" even though nothing is actually
    // executing.  This blocks new prompts and aborts.
    //
    // Fix: abort any in-progress prompt, then delete zombie "running"
    // tool parts via V2 part.delete.
    try {
      await ocClient.session.abort({
        path: { id: sessionId },
        ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
      })
      console.log(`[OpencodeAdapter] Aborted any in-progress prompt on resume for session ${sessionId}`)
    } catch {
      // Non-fatal: session may already be idle
    }

    // Delete zombie "running" tool parts that survived the abort.
    // When a prompt is aborted, individual tool parts remain in
    // "running" state permanently.  The server counts them as active
    // work, so the session stays "busy" forever — a catch-22 that
    // prevents both new prompts and message deletion.
    // Using v2.part.delete is the only way to clear them.
    try {
      const v2 = this.getV2Client()
      if (v2) {
        let zombieCount = 0
        for (const msg of await this.fetchMessages(ocClient, sessionId, config.workspaceDir)) {
          const msgId = msg.info?.id
          if (!msgId) continue
          for (const part of msg.parts || []) {
            if (part.type !== 'tool') continue
            if ((part.state as Record<string, unknown> | undefined)?.status !== 'running') continue
            try {
              await v2.part.delete({
                sessionID: sessionId,
                messageID: msgId,
                partID: part.id as string,
                ...(config.workspaceDir && { directory: config.workspaceDir }),
              })
              zombieCount++
            } catch {
              // Part may already have been cleaned up
            }
          }
        }
        if (zombieCount > 0) {
          console.log(`[OpencodeAdapter] Deleted ${zombieCount} zombie running tool part(s) on resume for session ${sessionId}`)
          // Abort again after cleanup to transition the server from busy → idle
          try {
            await ocClient.session.abort({
              path: { id: sessionId },
              ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
            })
          } catch {
            // Non-fatal
          }
        }

        // Also clear any stale pending permissions
        const listResult = await v2.permission.list({})
        if (listResult.data && Array.isArray(listResult.data)) {
          const allPending = listResult.data as Array<{ id: string; sessionID: string }>
          const sessionPending = allPending.filter(p => p.sessionID === sessionId)
          for (const perm of sessionPending) {
            try {
              await v2.permission.reply({
                requestID: perm.id,
                reply: 'always'
              })
              console.log(`[OpencodeAdapter] Auto-approved stale permission ${perm.id} on resume`)
            } catch {
              // Permission may have already expired
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[OpencodeAdapter] Failed to clean up stale session state on resume:`, err instanceof Error ? err.message : err)
    }

    this.registerSession(sessionId, config, connection)

    return convertResumedMessages(await this.fetchMessages(ocClient, sessionId, config.workspaceDir))
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], config: SessionConfig): Promise<void> {
    // Use the no-timeout prompt client for session.prompt() which runs indefinitely.
    // Falls back to the default client if promptClients entry is missing (shouldn't happen).
    const ocClient = this.promptClients.get(sessionId) || this.clients.get(sessionId)
    if (!ocClient) {
      throw new Error(`No client found for session ${sessionId}`)
    }

    // Parse model from config
    let modelParam: { providerID: string; modelID: string } | undefined
    if (config.model) {
      const slashIdx = config.model.indexOf('/')
      if (slashIdx > 0) {
        modelParam = {
          providerID: config.model.slice(0, slashIdx),
          modelID: config.model.slice(slashIdx + 1)
        }
      }
    }

    const promptAbort = new AbortController()
    this.promptAborts.set(sessionId, promptAbort)

    // Fire-and-forget prompt with retry — the HTTP call stays open until the full
    // agent loop completes (including tool call execution).  getStatus() checks
    // promptAborts to reliably report BUSY while this call is in flight.
    // Retries handle transient "Aborted" errors caused by config pushes or
    // provider concurrency limits.
    console.log(`[OpencodeAdapter] Sending prompt for session ${sessionId} (model: ${config.model || 'default'})`)
    this.executePromptWithRetry(ocClient, sessionId, parts, modelParam, config, promptAbort)
      .finally(() => {
        this.promptAborts.delete(sessionId)
      })
  }

  /**
   * Returns true if the error message indicates a transient condition that
   * may succeed on retry (e.g. OpenCode server aborted the session processor
   * due to a config push, or the provider returned a temporary overload).
   */
  private isRetryablePromptError(msg: string): boolean {
    const lower = msg.toLowerCase()
    return lower === 'aborted' || lower.includes('aborted') || lower.includes('overloaded') || lower.includes('service unavailable')
  }

  /**
   * Builds the body for session.prompt().
   *
   * The optional `system` field is OpenCode's programmatic channel for the
   * agent settings system prompt. The server APPENDS it to its built-in
   * system prompt (packages/opencode/src/session/llm/request.ts:
   * `...(input.user.system ? [input.user.system] : [])`) — it does not
   * replace OpenCode's own harness prompt. Without it the system prompt
   * configured in 20x settings never reaches OpenCode sessions: the adapter
   * had no other delivery path. OpenCode reads it from the LAST user
   * message of the call, so it must be sent on every prompt, not just the
   * first.
   */
  private static buildPromptBody(
    parts: MessagePart[],
    modelParam: { providerID: string; modelID: string } | undefined,
    config: SessionConfig
  ): Record<string, unknown> {
    return {
      parts: parts as unknown as Array<import('@opencode-ai/sdk').TextPartInput>,
      ...(modelParam && { model: modelParam }),
      ...(config.tools && { tools: config.tools }),
      ...(config.systemPrompt?.trim() && { system: config.systemPrompt.trim() })
    }
  }

  /**
   * Executes a prompt with automatic retry for transient errors.
   * Keeps the AbortController in promptAborts alive during retries so
   * getStatus() continues to report BUSY.
   */
  private async executePromptWithRetry(
    ocClient: OpencodeClient,
    sessionId: string,
    parts: MessagePart[],
    modelParam: { providerID: string; modelID: string } | undefined,
    config: SessionConfig,
    promptAbort: AbortController
  ): Promise<void> {
    const maxRetries = OpencodeAdapter.PROMPT_MAX_RETRIES
    const baseDelay = OpencodeAdapter.PROMPT_RETRY_BASE_DELAY_MS

    let attempt = 0
    /** Waits with exponential backoff and returns true when a transient error may be retried. */
    const retryAfterBackoff = async (errorMsg: string, kind: string): Promise<boolean> => {
      if (!this.isRetryablePromptError(errorMsg) || attempt >= maxRetries) return false
      const delay = baseDelay * Math.pow(2, attempt)
      console.warn(`[OpencodeAdapter] Retryable ${kind} error "${errorMsg}" for ${sessionId}, retrying (${attempt + 1}/${maxRetries}) after ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
      return true
    }

    for (; attempt <= maxRetries; attempt++) {
      if (promptAbort.signal.aborted) return

      const promptStartTime = Date.now()
      if (attempt > 0) {
        console.log(`[OpencodeAdapter] Retry attempt ${attempt}/${maxRetries} for session ${sessionId}`)
      }

      try {
        const result: unknown = await ocClient.session.prompt({
          path: { id: sessionId },
          body: OpencodeAdapter.buildPromptBody(parts, modelParam, config) as import('@opencode-ai/sdk').SessionPromptData['body'],
          ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
          signal: promptAbort.signal
        })

        const elapsed = Date.now() - promptStartTime
        console.log(`[OpencodeAdapter] Prompt completed for session ${sessionId} after ${elapsed}ms`)

        // Log tool call details from the response for debugging
        const res = result as { data?: { parts?: Array<Record<string, unknown>> } } | undefined
        if (res?.data?.parts) {
          const toolParts = res.data.parts.filter((p: Record<string, unknown>) => p.type === 'tool')
          if (toolParts.length > 0) {
            console.log(`[OpencodeAdapter] Response contains ${toolParts.length} tool part(s):`,
              toolParts.map((p: Record<string, unknown>) => ({
                tool: p.tool,
                status: (p.state as Record<string, unknown> | undefined)?.status
              }))
            )
          }
        }

        // Check for provider errors in the prompt response (e.g. quota exceeded,
        // payment required, rate limit).  OpenCode wraps these in result.data.info.error
        // but does NOT create a message with the error text, so pollMessages never
        // picks them up and the user sees "idle" with no response.
        const r = result as { data?: { info?: { error?: { name?: string; data?: { message?: string } } } } } | undefined
        const promptError = r?.data?.info?.error
        if (promptError) {
          const errorMsg = promptError.data?.message || promptError.name || 'Unknown provider error'

          // Retry transient errors (e.g. "Aborted" from config push tearing down the bus)
          if (await retryAfterBackoff(errorMsg, 'provider')) continue

          console.error(`[OpencodeAdapter] Provider error for ${sessionId}: ${errorMsg}`)
          this.promptErrors.set(sessionId, errorMsg)
          if (this.onDataAvailable) {
            this.onDataAvailable(sessionId)
          }
        }

        // Success or non-retryable error — stop retrying
        return
      } catch (err: unknown) {
        // User-initiated abort — exit silently
        if (err instanceof Error && err.name === 'AbortError') return

        const errorMsg = err instanceof Error ? err.message : String(err)

        if (await retryAfterBackoff(errorMsg, 'HTTP')) continue

        console.error('[OpencodeAdapter] prompt error:', err)
        // Surface HTTP-level errors (network failures, 4xx/5xx, connection refused)
        // via promptErrors so getStatus() returns ERROR instead of silent IDLE.
        this.promptErrors.set(sessionId, errorMsg)
        if (this.onDataAvailable) {
          this.onDataAvailable(sessionId)
        }
        return
      }
    }
  }

  private async fetchMessages(ocClient: OpencodeClient, sessionId: string, workspaceDir?: string): Promise<OpencodeMessage[]> {
    const result = await ocClient.session.messages({
      path: { id: sessionId },
      ...(workspaceDir && { query: { directory: workspaceDir } })
    })
    return Array.isArray(result.data) ? result.data as unknown as OpencodeMessage[] : []
  }

  async getStatus(sessionId: string, config: SessionConfig): Promise<SessionStatus> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return { type: SessionStatusType.ERROR, message: 'Client not found' }
    }

    // Check for pending permissions BEFORE the promptAborts check.
    // Permissions block tool execution while the prompt HTTP call is still
    // in-flight.  If we don't surface them here, the session appears busy
    // forever because the prompt never completes.
    if (this.pendingPermissions.has(sessionId) && (this.pendingPermissions.get(sessionId)?.length ?? 0) > 0) {
      return { type: SessionStatusType.WAITING_APPROVAL }
    }

    // If the session.prompt() HTTP call is still in-flight, the agent is
    // definitely still working — regardless of what the status API reports.
    // This prevents premature IDLE detection when the status API briefly
    // returns idle between tool call rounds or when using models (like
    // featherless kimi k2.5) whose tool call format may not be fully
    // reflected in the status endpoint.
    if (this.promptAborts.has(sessionId)) {
      return { type: SessionStatusType.BUSY }
    }

    const statusResult = await ocClient.session.status({
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (!statusResult.data) {
      return this.resolveIdleOrPromptError(sessionId)
    }

    const ocStatus = statusResult.data[sessionId]
    if (!ocStatus) {
      return this.resolveIdleOrPromptError(sessionId)
    }

    const sdkType = (ocStatus.type || 'idle') as string
    if (sdkType === 'waiting_approval' || sdkType === 'waiting_input' || sdkType === 'waiting_user') {
      return { type: SessionStatusType.WAITING_APPROVAL }
    }

    // Check for pending questions via V2 SDK
    try {
      const v2 = this.getV2Client(config.serverUrl)
      if (!v2) throw new Error('OpenCode V2 SDK not loaded')
      const listResult = await v2.question.list({
        ...(config.workspaceDir && { directory: config.workspaceDir })
      })
      if (!listResult.error && listResult.data) {
        const questions = listResult.data as Array<Record<string, unknown>>
        const targetQuestion = questions.find((q) => (q.sessionID as string | undefined) === sessionId || (q.sessionId as string | undefined) === sessionId)
        if (targetQuestion?.id) {
          return { type: SessionStatusType.WAITING_APPROVAL }
        }
      }
    } catch {
      // Ignore errors when checking for questions
    }

    // If the status API says idle, double-check the messages for tool parts
    // that are still pending/running. Some models (like featherless kimi k2.5)
    // may have tool calls in flight that the status API doesn't reflect.
    if (sdkType === 'idle') {
      try {
        const activeTool = findActiveToolInLastAssistantMessage(await this.fetchMessages(ocClient, sessionId, config.workspaceDir))
        if (activeTool) {
          console.log(`[OpencodeAdapter] Status API says idle but tool part ${activeTool.id} is ${activeTool.status} — reporting BUSY`)
          return { type: SessionStatusType.BUSY }
        }
      } catch (err) {
        console.warn('[OpencodeAdapter] Failed to check messages for pending tools:', err)
      }
    }

    const statusType = sdkType.toUpperCase() as keyof typeof SessionStatusType
    const resolvedType = SessionStatusType[statusType] ?? SessionStatusType.IDLE

    if (resolvedType === SessionStatusType.IDLE) {
      return this.resolveIdleOrPromptError(sessionId)
    }

    return {
      type: resolvedType,
      message: 'message' in ocStatus ? (ocStatus as { message: string }).message : undefined
    }
  }

  /**
   * Returns ERROR with captured prompt error if one exists, otherwise IDLE.
   * Called from getStatus when the backend reports no active work.
   */
  private resolveIdleOrPromptError(sessionId: string): SessionStatus {
    const promptError = this.promptErrors.get(sessionId)
    if (promptError) {
      this.promptErrors.delete(sessionId)
      return { type: SessionStatusType.ERROR, message: promptError }
    }
    return { type: SessionStatusType.IDLE }
  }

  async pollMessages(
    sessionId: string,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    config: SessionConfig
  ): Promise<MessagePart[]> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return []
    }
    const messages = await this.fetchMessages(ocClient, sessionId, config.workspaceDir)
    this.reportUsage(sessionId, messages)
    return convertPolledParts(messages, seenMessageIds, seenPartIds, partContentLengths)
  }

  /** Reports each assistant message's token usage once it has finished (#97). Never throws. */
  private reportUsage(sessionId: string, messages: OpencodeMessage[]): void {
    try {
      let seen = this.usageSeen.get(sessionId)
      if (!seen) {
        seen = { since: Date.now(), reported: new Set() }
        this.usageSeen.set(sessionId, seen)
      }
      for (const message of messages) {
        const info = message.info as { id?: unknown; time?: { completed?: unknown } } | undefined
        const id = typeof info?.id === 'string' ? info.id : null
        if (!id || seen.reported.has(id)) continue
        const completed = Number(info?.time?.completed)
        if (!Number.isFinite(completed) || completed <= 0) continue
        const body = opencodeMessageUsage(message)
        if (!body) continue
        seen.reported.add(id)
        if (completed < seen.since) continue
        this.onUsage?.({ sessionId, ...body })
      }
    } catch (err) {
      console.warn('[OpencodeAdapter] Could not read turn usage:', err instanceof Error ? err.message : err)
    }
  }

  async getRunningTools(sessionId: string, config: SessionConfig): Promise<Array<{
    partId: string
    toolName: string
    startTime?: number
    input?: Record<string, unknown>
  }>> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) return []

    try {
      return listRunningTools(await this.fetchMessages(ocClient, sessionId, config.workspaceDir))
    } catch (err) {
      console.warn(`[OpencodeAdapter] getRunningTools failed for ${sessionId}:`, err instanceof Error ? err.message : err)
      return []
    }
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const abort = this.promptAborts.get(sessionId)
    if (abort) {
      abort.abort()
      this.promptAborts.delete(sessionId)
    }

    // Also abort the session on the server side to ensure the backend
    // stops processing. Without this, the backend continues running the
    // old prompt (model generating tokens, bash commands executing) and
    // rejects or queues new prompts — so the user can't recover by
    // sending a follow-up message.
    const ocClient = this.clients.get(sessionId)
    if (ocClient) {
      try {
        await ocClient.session.abort({
          path: { id: sessionId },
          ...(_config.workspaceDir && { query: { directory: _config.workspaceDir } }),
        })
        console.log(`[OpencodeAdapter] Server-side abort sent for session ${sessionId}`)
      } catch (err) {
        // Non-fatal: the local abort is sufficient for the HTTP request.
        // Server-side abort can fail if session is already idle or not found.
        console.warn(`[OpencodeAdapter] Server-side abort failed for ${sessionId}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    await this.abortPrompt(sessionId, _config)
    // Release the stdio MCP children of this session before dropping the client.
    // They are children of the long-lived `opencode serve` process, so nothing
    // else would ever stop them.
    await this.disconnectSessionMcpServers(sessionId)
    this.clients.delete(sessionId)
    this.usageSeen.delete(sessionId)
    this.promptClients.delete(sessionId)
    this.pendingPermissions.delete(sessionId)
    this.sessionPermissionModes.delete(sessionId)
    this.sessionWorkspaceDirs.delete(sessionId)
    this.sessionMcpConfigs.delete(sessionId)
    this.sessionMcpAttachFailures.delete(sessionId)
    setTillDoneSession(this.tillDoneConfigPath, sessionId, undefined)

    if (this.clients.size > 0) {
      return
    }

    removeRuntimePluginFiles({
      pluginFilePaths: this.pluginFilePaths,
      runtimeSupportFilePaths: this.runtimeSupportFilePaths,
      tillDoneConfigPath: this.tillDoneConfigPath
    })
    this.pluginFilePaths = []
    this.runtimeSupportFilePaths = []
    this.tillDoneConfigPath = null
  }

  /** Must be called BEFORE ensureServerRunning() so plugins are discovered at startup. */
  private writeRuntimePluginFiles(config: SessionConfig): void {
    const files = writeRuntimePluginFiles(config)
    this.pluginFilePaths = files.pluginFilePaths
    this.runtimeSupportFilePaths = files.runtimeSupportFilePaths
    this.tillDoneConfigPath = files.tillDoneConfigPath
  }

  async getAllMessages(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return []
    }

    try {
      return convertAllMessages(await this.fetchMessages(ocClient, sessionId, config.workspaceDir))
    } catch (error) {
      console.error('[OpencodeAdapter] Error fetching messages:', error)
      return []
    }
  }

  private getV2Client(serverUrl?: string): V2OpencodeClient | null {
    if (!this.v2Client && OpenCodeV2Client) {
      this.v2Client = OpenCodeV2Client.createOpencodeClient({
        baseUrl: this.serverUrl || serverUrl || DEFAULT_SERVER_URL
      })
    }
    return this.v2Client
  }

  async respondToQuestion(
    sessionId: string,
    answers: Record<string, string>,
    config: SessionConfig
  ): Promise<void> {
    const v2 = this.getV2Client(config.serverUrl)
    if (!v2) throw new Error('OpenCode V2 SDK not loaded')

    try {
      // List pending questions via V2 SDK
      const listResult = await v2.question.list({
        ...(config.workspaceDir && { directory: config.workspaceDir })
      })

      if (listResult.error) {
        throw new Error(`question.list failed: ${JSON.stringify(listResult.error)}`)
      }

      const questions: V2QuestionRequest[] = listResult.data ?? []
      console.log(
        `[OpencodeAdapter] Pending questions (${questions.length}):`,
        questions.map(q => ({
          id: q.id,
          sessionID: q.sessionID,
          sessionId: (q as unknown as { sessionId?: string }).sessionId,
          questionCount: q.questions?.length
        }))
      )

      // Find the question for this session
      const question = questions.find(q => q.sessionID === sessionId || (q as unknown as { sessionId?: string }).sessionId === sessionId)
      if (!question?.id) {
        console.warn(`[OpencodeAdapter] No pending question found for session ${sessionId}`)
        return
      }

      console.log(`[OpencodeAdapter] Matched question:`, JSON.stringify(question, null, 2).slice(0, 1000))

      // Build answers aligned with the question's questions array order
      const questionItems = question.questions ?? []
      const answerKeys = Object.keys(answers)
      const formattedAnswers: string[][] = []

      for (let i = 0; i < questionItems.length; i++) {
        const qItem = questionItems[i]
        const matchKey = answerKeys.find(k => k === qItem.header || k === qItem.question)
        const answerValue = matchKey ? answers[matchKey] : Object.values(answers)[i]
        formattedAnswers.push(answerValue ? [answerValue] : [])
      }

      console.log(`[OpencodeAdapter] Replying to question ${question.id} (${questionItems.length} items) with:`, formattedAnswers)

      // Reply via V2 SDK
      const replyResult = await v2.question.reply({
        requestID: question.id,
        answers: formattedAnswers,
        ...(config.workspaceDir && { directory: config.workspaceDir })
      })

      if (replyResult.error) {
        throw new Error(`question.reply failed: ${JSON.stringify(replyResult.error)}`)
      }

      console.log(`[OpencodeAdapter] Question ${question.id} replied successfully`)
    } catch (err) {
      console.error('[OpencodeAdapter] Question API failed:', err)
    }
  }

  // ========================================================================
  // Permission handling — OpenCode file-permission prompts surfaced in 20x UI
  // ========================================================================

  /**
   * Returns the first pending permission for a session, formatted as an
   * approval request the agent-manager can render.  The agent-manager
   * duck-types for this method on any adapter during polling.
   */
  getPendingApproval(sessionId: string): {
    toolCallId: string
    question: string
    options: Array<{ optionId: string; name: string; kind: string }>
  } | null {
    const queue = this.pendingPermissions.get(sessionId)
    if (!queue || queue.length === 0) return null

    const pending = queue[0]
    const pathList = pending.patterns.length > 0
      ? pending.patterns.join(', ')
      : 'requested path'

    return {
      toolCallId: pending.permissionId,
      question: `Allow ${pending.permission} access to: ${pathList}`,
      options: [
        { optionId: 'allow', name: 'Yes', kind: 'option' },
        { optionId: 'allow-always', name: 'Always', kind: 'option' },
        { optionId: 'deny', name: 'No', kind: 'option' }
      ]
    }
  }

  /**
   * Responds to a pending permission via the OpenCode HTTP API.
   * Called by agent-manager when the user approves/denies in the UI.
   */
  async respondToApproval(
    sessionId: string,
    approved: boolean,
    optionId?: string
  ): Promise<boolean> {
    const queue = this.pendingPermissions.get(sessionId)
    if (!queue || queue.length === 0) {
      // Fallback: try the V2 API for pending permissions.
      // This handles the case where pendingPermissions was lost (e.g., app restart
      // or watchdog abort) but the permission is still pending in OpenCode.
      console.warn(`[OpencodeAdapter] No pending permission in memory for session ${sessionId}, trying V2 API fallback`)
      return await this.respondToPermissionViaV2(sessionId, approved, optionId)
    }

    const pending = queue.shift()!
    if (queue.length === 0) {
      this.pendingPermissions.delete(sessionId)
    }

    const response = permissionReply(approved, optionId)

    console.log(`[OpencodeAdapter] Responding to permission ${pending.permissionId}: ${response}`)

    try {
      const baseUrl = this.serverUrl || DEFAULT_SERVER_URL
      const url = `${baseUrl}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(pending.permissionId)}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response })
      })
      if (!res.ok) {
        console.warn(`[OpencodeAdapter] Permission response HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      }
    } catch (err) {
      console.error(`[OpencodeAdapter] Failed to respond to permission ${pending.permissionId}:`, err)
    }

    // Trigger immediate poll so agent-manager sees next pending permission (if any)
    if (this.onDataAvailable) {
      this.onDataAvailable(sessionId)
    }
    return true
  }

  /**
   * Fallback: respond to a pending permission via the OpenCode V2 API.
   * Used when the in-memory pendingPermissions map is empty (e.g., after
   * app restart or watchdog abort) but the permission is still pending
   * in the OpenCode backend.
   *
   * Uses v2Client.permission.list() (top-level, lists all sessions) and
   * v2Client.permission.reply() to find and respond to the permission.
   */
  private async respondToPermissionViaV2(
    sessionId: string,
    approved: boolean,
    optionId?: string
  ): Promise<boolean> {
    try {
      const v2 = this.getV2Client()
      if (!v2) {
        console.warn(`[OpencodeAdapter] Cannot fetch permissions — V2 SDK not loaded`)
        return false
      }

      // permission.list() returns ALL pending permissions across all sessions.
      // Filter to the target session.
      const listResult = await v2.permission.list({})
      if (listResult.error || !listResult.data) {
        console.warn(`[OpencodeAdapter] V2 permission.list() failed or returned no data for session ${sessionId}`)
        return false
      }

      const allPending = listResult.data as Array<{ id: string; sessionID: string; permission: string; patterns: string[] }>
      const sessionPending = allPending.filter(p => p.sessionID === sessionId)
      if (sessionPending.length === 0) {
        console.warn(`[OpencodeAdapter] No pending permissions found via V2 API for session ${sessionId}`)
        return false
      }

      const first = sessionPending[0]

      const reply = permissionReply(approved, optionId)

      const directory = this.sessionWorkspaceDirs.get(sessionId)
      console.log(`[OpencodeAdapter] Responding to permission ${first.id} via V2 API: ${reply} (permission=${first.permission}, patterns=${first.patterns.join(', ')})`)
      await v2.permission.reply({
        requestID: first.id,
        reply,
        ...(directory && { directory })
      })

      // Trigger immediate poll so agent-manager sees the unblocked session
      if (this.onDataAvailable) {
        this.onDataAvailable(sessionId)
      }
      return true
    } catch (err) {
      console.error(`[OpencodeAdapter] V2 permission fallback failed for session ${sessionId}:`, err)
      return false
    }
  }

  /**
   * Subscribes to the OpenCode server's SSE event stream to capture
   * `permission.asked` events.  Must be called after the server is running.
   * Runs in the background; reconnects automatically on disconnect.
   */
  private startEventSubscription(): void {
    if (this.sseAbort || !this.serverUrl) return
    this.sseAbort = new AbortController()

    // Fire-and-forget — reconnection loop runs in the background
    streamServerEvents(this.serverUrl, this.sseAbort.signal, (event) => this.handleServerEvent(event)).catch(() => {})
  }

  /**
   * Handle a single SSE event from the OpenCode server.
   * We only care about `permission.asked` events.
   *
   * The /global/event endpoint wraps events in a `payload` envelope:
   *   { payload: { id, type, properties } }
   * The /event endpoint returns events directly:
   *   { id, type, properties }
   * We handle both formats.
   */
  private handleServerEvent(event: Record<string, unknown>): void {
    // Unwrap /global/event payload envelope if present
    const inner = (event.payload || event) as Record<string, unknown>
    const type = inner.type as string | undefined

    if (type === 'server.instance.disposed' || type === 'global.disposed') {
      const props = (inner.properties || {}) as Record<string, unknown>
      const directory = (props.directory || event.directory) as string | undefined
      void this.handleInstanceDisposed(directory, type)
      return
    }

    if (type !== 'permission.asked') return

    const props = (inner.properties || inner) as Record<string, unknown>
    const permissionId = (props.id || props.permissionID) as string | undefined
    const sessionID = (props.sessionID || props.sessionId) as string | undefined
    const permission = (props.permission || props.name || 'unknown') as string
    const patterns = (props.patterns || []) as string[]

    if (!permissionId || !sessionID) {
      console.warn('[OpencodeAdapter] permission.asked event missing id or sessionID:', JSON.stringify(event).slice(0, 300))
      return
    }

    console.log(`[OpencodeAdapter] Permission requested: ${permission} for session ${sessionID} (${permissionId}) patterns=${patterns.join(', ')}`)

    // Auto-approve if the agent's permission mode is 'allow'
    const mode = this.sessionPermissionModes.get(sessionID) || 'ask'
    if (mode === 'allow') {
      console.log(`[OpencodeAdapter] Auto-approving permission ${permissionId} (permissionMode=allow)`)
      this.autoApprovePermission(sessionID, permissionId).catch(err => {
        console.error(`[OpencodeAdapter] Auto-approve failed for ${permissionId}:`, err)
      })
      return
    }

    // Append to the session's permission queue for UI handling
    let queue = this.pendingPermissions.get(sessionID)
    if (!queue) {
      queue = []
      this.pendingPermissions.set(sessionID, queue)
    }
    // Deduplicate by permissionId
    if (!queue.some(p => p.permissionId === permissionId)) {
      queue.push({ permissionId, permission, patterns })
    }

    // Trigger immediate poll so agent-manager renders the approval prompt
    if (this.onDataAvailable) {
      this.onDataAvailable(sessionID)
    }
  }

  /**
   * Silently approve a permission request (used when permissionMode is 'allow').
   * Uses the V2 SDK permission.reply() which hits the correct endpoint
   * (POST /permission/{requestID}/reply). The V1 endpoint
   * (POST /session/{id}/permissions/{permissionID}) returns 404 for
   * permissions created by the V2 system.
   */
  private async autoApprovePermission(sessionId: string, permissionId: string): Promise<void> {
    // Resolve the workspace directory for this session — the OpenCode server
    // may need it to properly scope the permission reply.
    const directory = this.sessionWorkspaceDirs.get(sessionId)

    try {
      // Try V2 SDK first — this is the correct endpoint for V2 permissions
      const v2 = this.getV2Client()
      if (v2) {
        await v2.permission.reply({
          requestID: permissionId,
          reply: 'always',
          ...(directory && { directory })
        })
        console.log(`[OpencodeAdapter] Auto-approved permission ${permissionId} via V2 API${directory ? ` (dir=${directory})` : ''}`)
        return
      }

      // Fallback to raw fetch if V2 SDK is not available
      const baseUrl = this.serverUrl || DEFAULT_SERVER_URL
      const dirQuery = directory ? `?directory=${encodeURIComponent(directory)}` : ''
      const url = `${baseUrl}/permission/${encodeURIComponent(permissionId)}/reply${dirQuery}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: 'always' })
      })
      if (!res.ok) {
        console.warn(`[OpencodeAdapter] Auto-approve HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      }
    } catch (err) {
      console.error(`[OpencodeAdapter] Auto-approve failed for ${permissionId}:`, err)
    }
  }

  private stopEventSubscription(): void {
    if (this.sseAbort) {
      this.sseAbort.abort()
      this.sseAbort = null
    }
  }

  async stopServer(): Promise<void> {
    this.stopEventSubscription()
    this.pendingPermissions.clear()
    if (this.serverInstance) {
      try {
        await (this.serverInstance as { close: () => Promise<void> }).close()
      } catch (error) {
        console.error('[OpencodeAdapter] Error stopping server:', error)
      }
    } else if (this.serverUrl) {
      // The server was adopted, not spawned by this app instance (see
      // findAccessibleServer), so it is not ours to close. Say so: an adopted
      // server outlives the app and keeps every MCP stdio child it ever
      // attached, which is how those children pile up over days.
      console.log(
        `[OpencodeAdapter] Not closing adopted opencode server at ${this.serverUrl} (not spawned by this instance)`
      )
    }
    // Reset client state in both cases — the adopted-server branch used to skip
    // this and leave stale clients pointing at a server the app no longer uses.
    this.serverInstance = null
    this.serverUrl = null
    this.sharedClient = null
    this.quickClient = null
    this.v2Client = null
    this.serverStarting = null
    this.configPushed = false
  }
}
