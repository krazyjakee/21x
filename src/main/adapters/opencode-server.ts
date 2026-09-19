/**
 * The shared `opencode serve` server: spawning or adopting it, its SDK clients,
 * config pushes and the SSE event stream.
 */

import { execSync } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { delimiter, join } from 'path'
import { homedir } from 'os'
import { setTimeout as sleep } from 'timers/promises'
import { Agent as UndiciAgent } from 'undici'
import { buildMergedOpencodeConfig } from '../utils/opencode-config'
import type { DatabaseManager } from '../database'
import { lazySdk } from './shared/lazy-sdk'

export const DEFAULT_SERVER_URL = 'http://localhost:4096'

export type OpencodeClient = import('@opencode-ai/sdk').OpencodeClient
export type V2OpencodeClient = import('@opencode-ai/sdk/v2/client').OpencodeClient
type V2Config = import('@opencode-ai/sdk/v2/client').Config

const opencodeSdk = lazySdk('OpenCode SDK', async () => ({
  v1: await import('@opencode-ai/sdk'),
  v2: await import('@opencode-ai/sdk/v2'),
  v2Client: await import('@opencode-ai/sdk/v2/client')
}))

type FetchLike = (request: Request) => ReturnType<typeof fetch>

function fetchWithDispatcher(dispatcher: UndiciAgent): FetchLike {
  return (request) => (globalThis.fetch as (req: unknown, init: unknown) => ReturnType<typeof fetch>)(request, { dispatcher })
}

// session.prompt() stays open for the whole agent loop (every tool call
// included), so its client must never time out. Every other call keeps the
// SDK's built-in 60s timeout.
const noTimeoutFetch = fetchWithDispatcher(new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 }))

// Health checks, config queries and provider listing.
const QUICK_OP_TIMEOUT_MS = 15_000
const quickTimeoutFetch = fetchWithDispatcher(new UndiciAgent({ headersTimeout: QUICK_OP_TIMEOUT_MS, bodyTimeout: QUICK_OP_TIMEOUT_MS })) as unknown as typeof fetch

/** Returns the first of url / its localhost↔127.0.0.1 twin whose health check answers. */
export async function findAccessibleServer(url: string): Promise<string | null> {
  const urls = [url]
  if (url.includes('localhost')) {
    urls.push(url.replace('localhost', '127.0.0.1'))
  } else if (url.includes('127.0.0.1')) {
    urls.push(url.replace('127.0.0.1', 'localhost'))
  }

  for (const testUrl of urls) {
    try {
      const response = await fetch(`${testUrl}/global/health`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return testUrl
    } catch {
      // Try next URL
    }
  }
  return null
}

/**
 * Adds common install locations (and the user-configured binary directory) to
 * PATH so the SDK's createOpencode can find the `opencode` binary. The custom
 * path is otherwise only added to PATH during the onboarding dependency check.
 */
export function ensureOpencodeBinaryPaths(customPath: string | null): void {
  const currentPath = process.env.PATH || ''
  const extraPaths = [
    ...(customPath ? [customPath] : []),
    join(homedir(), '.opencode', 'bin'),
    ...(process.platform === 'win32'
      ? [join(homedir(), 'AppData', 'Roaming', 'npm')]
      : ['/usr/local/bin']),
    join(homedir(), '.local', 'bin')
  ].filter(p => !currentPath.includes(p))

  if (extraPaths.length > 0) {
    process.env.PATH = [...extraPaths, currentPath].join(delimiter)
    console.log('[OpencodeAdapter] Added binary paths to PATH:', extraPaths)
  }
}

/**
 * Kills any opencode process on the default port (possibly left over from a
 * previous launch or a terminal session) and deletes the global database with
 * its WAL/SHM sidecars, which can be corrupted by a crash or a version upgrade.
 */
export function killServerAndClearDatabase(): void {
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM opencode.exe 2>nul', { stdio: 'ignore' })
    } else {
      execSync("lsof -ti :4096 | xargs kill -9 2>/dev/null || true", { stdio: 'ignore' })
    }
    console.log('[OpencodeAdapter] Killed opencode process on port 4096')
  } catch {
    // Process may already be gone
  }

  const dbDir = join(homedir(), '.local', 'share', 'opencode')
  for (const file of ['opencode.db', 'opencode.db-shm', 'opencode.db-wal']) {
    const filePath = join(dbDir, file)
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath)
        console.log(`[OpencodeAdapter] Deleted corrupted DB file: ${filePath}`)
      }
    } catch (err) {
      console.warn(`[OpencodeAdapter] Could not delete ${filePath}:`, err)
    }
  }
}

/**
 * Reads the server's SSE stream at `${baseUrl}/global/event` until `signal`
 * aborts, reconnecting after 3s on connection errors.
 */
export async function streamServerEvents(
  baseUrl: string,
  signal: AbortSignal,
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const url = `${baseUrl}/global/event`

  while (!signal.aborted) {
    try {
      const response = await (globalThis as unknown as { fetch: typeof fetch }).fetch(url, {
        signal,
        headers: { 'Accept': 'text/event-stream' }
      })
      const reader = response.body?.getReader()
      if (!reader) return

      const decoder = new TextDecoder()
      let buffer = ''
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let nlIdx: number
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIdx).trim()
          buffer = buffer.slice(nlIdx + 1)
          if (!line.startsWith('data:')) continue
          const json = line.slice(line.startsWith('data: ') ? 6 : 5)
          if (!json) continue
          try {
            onEvent(JSON.parse(json) as Record<string, unknown>)
          } catch {
            // Not valid JSON — skip
          }
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) return
      if (err instanceof Error && err.name === 'AbortError') return
      console.warn('[OpencodeAdapter] SSE connection error, reconnecting in 3s:', err instanceof Error ? err.message : err)
      await sleep(3_000)
    }
  }
}

interface OpencodeServerHooks {
  /** Plugin files to hand to a server this app spawns. */
  pluginFilePaths: () => string[]
  /**
   * Workspace directories to push config to while prompts are running, or null
   * when no prompt is running (a global config push is then safe).
   */
  busyDirectories: () => string[] | null
  onEvent: (event: Record<string, unknown>) => void
}

export class OpencodeServer {
  url: string | null = null
  private instance: { close: () => void | Promise<void> } | null = null
  private starting: Promise<void> | null = null
  private sharedClient: V2OpencodeClient | null = null
  /** Same server, bounded timeout. */
  private quickClient: V2OpencodeClient | null = null
  private v2Client: V2OpencodeClient | null = null
  /**
   * Config is pushed once on first connection; later pushes only come from
   * notifyConfigChanged(). This avoids PATCH /global/config storms that abort
   * every running session.
   */
  private configPushed = false
  private sseAbort: AbortController | null = null

  constructor(
    private readonly hooks: OpencodeServerHooks,
    private readonly db?: Pick<DatabaseManager, 'getSetting'>
  ) {}

  async loadSdk(): Promise<void> {
    await opencodeSdk.ready()
  }

  /** The shared client, starting or adopting the server first. `quick` bounds the timeout. */
  async client(serverUrl?: string, opts?: { quick?: boolean }): Promise<V2OpencodeClient> {
    await this.ensureRunning(serverUrl || this.url || DEFAULT_SERVER_URL)
    const client = opts?.quick ? this.quickClient : this.sharedClient
    if (!client) throw new Error('OpenCode client not available after server startup')
    return client
  }

  /** A default-timeout client for session calls and a no-timeout one for session.prompt(). */
  sessionClients(fallbackUrl?: string): { ocClient: OpencodeClient; promptClient: OpencodeClient } {
    const { v1 } = this.sdk()
    const baseUrl = this.url || fallbackUrl || DEFAULT_SERVER_URL
    return {
      ocClient: v1.createOpencodeClient({ baseUrl }),
      promptClient: v1.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch })
    }
  }

  /** V2 client for permission, question and part APIs; null until the SDK is loaded. */
  v2(serverUrl?: string): V2OpencodeClient | null {
    const sdk = opencodeSdk.current()
    if (!this.v2Client && sdk) {
      this.v2Client = sdk.v2Client.createOpencodeClient({ baseUrl: this.url || serverUrl || DEFAULT_SERVER_URL })
    }
    return this.v2Client
  }

  get needsConfigPush(): boolean {
    return !this.configPushed
  }

  async ensureRunning(targetUrl: string = DEFAULT_SERVER_URL): Promise<void> {
    if (this.url === targetUrl) return
    if (this.starting) return this.starting

    const sdk = await opencodeSdk.ready()
    ensureOpencodeBinaryPaths(this.db?.getSetting('OPENCODE_BINARY_PATH') ?? null)

    // Without a bash timeout a single hung `npm install` or `git clone` keeps
    // the session stuck forever. 10 minutes still fits legitimate long commands.
    if (!process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS) {
      process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = '600000'
      console.log('[OpencodeAdapter] Set OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=600000 (10min)')
    }

    const isDefaultUrl = targetUrl === DEFAULT_SERVER_URL || targetUrl === 'http://127.0.0.1:4096'

    this.starting = (async () => {
      try {
        const accessibleUrl = await findAccessibleServer(targetUrl)
        if (accessibleUrl) {
          this.url = accessibleUrl
          this.instance = null
          this.sharedClient = sdk.v2Client.createOpencodeClient({ baseUrl: accessibleUrl })
          this.quickClient = sdk.v2Client.createOpencodeClient({ baseUrl: accessibleUrl, fetch: quickTimeoutFetch })
          // The one automatic push: it injects auth.json keys so custom
          // providers (e.g. routerAI) authenticate. The quick client keeps a
          // slow adopted server from hanging startup.
          await this.pushMergedConfig(this.quickClient)
          return
        }

        if (!isDefaultUrl) {
          throw new Error(`OpenCode server not accessible at ${targetUrl}`)
        }

        // createOpencode starts server and client together and picks up
        // opencode.json itself; the merged config adds auth.json API keys to
        // custom provider options.
        const url = new URL(targetUrl)
        const hostname = url.hostname
        const port = parseInt(url.port || '4096', 10)

        const pluginFilePaths = this.hooks.pluginFilePaths()
        const extraConfig: Record<string, unknown> = {}
        if (pluginFilePaths.length > 0) {
          extraConfig.plugin = [...pluginFilePaths]
          console.log('[OpencodeAdapter] Passing plugins to server config:', pluginFilePaths)
        }

        console.log(`[OpencodeAdapter] Creating opencode instance at ${hostname}:${port} via SDK v2 createOpencode`)
        const { client, server } = await sdk.v2.createOpencode({
          hostname,
          port,
          timeout: 10000,
          config: buildMergedOpencodeConfig(extraConfig) as V2Config
        })

        this.instance = server
        this.url = server.url
        this.sharedClient = client
        this.quickClient = sdk.v2Client.createOpencodeClient({ baseUrl: server.url, fetch: quickTimeoutFetch })
        console.log(`[OpencodeAdapter] OpenCode instance created at ${server.url}`)
      } finally {
        this.starting = null
        this.startEventSubscription()
      }
    })()

    return this.starting
  }

  /**
   * Pushes the merged provider/auth config to the running server.
   *
   * PATCH /global/config makes the server call disposeAllInstancesAndEmitGlobalDisposed(),
   * which aborts every running session processor AND disconnects all MCP
   * servers. So while prompts are running, config is pushed per session
   * directory instead.
   */
  async pushMergedConfig(client: V2OpencodeClient | null = this.sharedClient): Promise<void> {
    if (!client) {
      console.log('[OpencodeAdapter] No server connection yet, skipping config push')
      return
    }
    try {
      const mergedConfig = buildMergedOpencodeConfig()
      if (!mergedConfig.provider) {
        console.log('[OpencodeAdapter] pushMergedConfig: no providers in merged config, skipping')
        return
      }
      console.log('[OpencodeAdapter] pushMergedConfig: pushing providers:', Object.keys(mergedConfig.provider as Record<string, unknown>).join(', '))
      const config = mergedConfig as V2Config

      const busyDirectories = this.hooks.busyDirectories()
      if (busyDirectories && busyDirectories.length > 0) {
        console.log(`[OpencodeAdapter] pushMergedConfig: prompts active — pushing to ${busyDirectories.length} directory(ies)`)
        for (const directory of busyDirectories) {
          try {
            await client.config.update({ config, directory })
          } catch {
            // One directory failing does not block the others
          }
        }
      } else if (busyDirectories) {
        console.warn('[OpencodeAdapter] pushMergedConfig: no known directories, using global endpoint (may disrupt active sessions)')
        await client.global.config.update({ config })
      } else {
        try {
          const result = await client.global.config.update({ config })
          if (result.error) {
            console.warn('[OpencodeAdapter] global.config.update returned error:', JSON.stringify(result.error))
            throw new Error('global.config.update returned error')
          }
        } catch {
          const result = await client.config.update({ config })
          if (result.error) {
            console.warn('[OpencodeAdapter] config.update returned error:', JSON.stringify(result.error))
          }
        }
      }
      this.configPushed = true
    } catch (err) {
      console.warn('[OpencodeAdapter] pushMergedConfig failed:', err instanceof Error ? err.message : err)
    }
  }

  /** Kills a broken server and clears its database so the next call spawns a fresh one. */
  async recover(): Promise<void> {
    console.log('[OpencodeAdapter] Starting recovery: stopping broken server and clearing database')
    await this.stop()
    killServerAndClearDatabase()
    // Let the OS release the port
    await sleep(500)
    console.log('[OpencodeAdapter] Recovery complete, will spawn fresh server on next call')
  }

  async stop(): Promise<void> {
    this.sseAbort?.abort()
    this.sseAbort = null
    if (this.instance) {
      try {
        await this.instance.close()
      } catch (error) {
        console.error('[OpencodeAdapter] Error stopping server:', error)
      }
    } else if (this.url) {
      // An adopted server (see findAccessibleServer) is not ours to close. It
      // outlives the app and keeps every MCP stdio child it ever attached,
      // which is how those children pile up over days.
      console.log(`[OpencodeAdapter] Not closing adopted opencode server at ${this.url} (not spawned by this instance)`)
    }
    // Reset in both cases so no client keeps pointing at a server the app no longer uses.
    this.instance = null
    this.url = null
    this.sharedClient = null
    this.quickClient = null
    this.v2Client = null
    this.starting = null
    this.configPushed = false
  }

  private sdk(): NonNullable<ReturnType<typeof opencodeSdk.current>> {
    const sdk = opencodeSdk.current()
    if (!sdk) throw new Error('OpenCode SDK not loaded')
    return sdk
  }

  /** Background SSE subscription (permission requests, instance disposal); reconnects on its own. */
  private startEventSubscription(): void {
    if (this.sseAbort || !this.url) return
    this.sseAbort = new AbortController()
    streamServerEvents(this.url, this.sseAbort.signal, this.hooks.onEvent).catch(() => {})
  }
}
