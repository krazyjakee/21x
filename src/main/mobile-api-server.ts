/**
 * Mobile API server — HTTP + WebSocket for controlling 20x from a mobile device.
 * Runs inside the Electron main process, shares DatabaseManager and AgentManager.
 * Serves the mobile SPA and provides REST + WebSocket endpoints.
 *
 * See docs/mobile-api-spec.md for the full API specification.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'http'
import { join, sep, resolve, isAbsolute } from 'path'
import { existsSync, readFileSync, statSync, lstatSync, realpathSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID, createHash, randomInt } from 'crypto'
import type { CreateTaskData, DatabaseManager, UpdateTaskData } from './database'
import type { AgentManager } from './agent-manager-core'
import type { GitHubManager } from './github-manager'
import type { GitLabManager } from './gitlab-manager'
import type { ForgejoManager } from './forgejo-manager'
import { isGitProvider, recordRepoProviders } from './repo-providers'
import type { SyncManager } from './sync-manager'
import type { PluginRegistry } from './plugins/registry'
import { listTaskArtifactEntries, readTaskArtifact } from './artifacts'
import type { Artifact, ArtifactFileEntry } from '../shared/artifacts'
import { MOBILE_VOICE_CAPABILITIES } from '../shared/voice'
import { TaskStatus } from '../shared/constants'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import { buildProjectOverview } from './project-overview'
import { guardStream } from './child-stream-guards'
import { bearerToken, readJsonBody } from './http-utils'
import { completeTaskAtSource, updateTaskFromUser } from './session-feedback'
import { afterTaskCreated, afterTaskUpdated, assertTaskLifecycleOwners, prepareUserTaskUpdate, startPreparedTask } from './task-updates'
import type { RecurrenceSchedulerCore } from './recurrence-scheduler-core'
import type { HeartbeatSchedulerCore } from './heartbeat-scheduler-core'
import type { TaskAutomationScheduler } from './task-automation-scheduler'
import { mimeTypeForPath } from './mime'
import { hasExactKeys, isRecord } from '../shared/service-protocol'
import { TASK_LIFECYCLE_CODECS, projectTaskLifecycleTask, isTaskLifecycleCreate, isTaskLifecycleUpdate } from '../shared/task-lifecycle-codecs'
import { isDatabaseId } from '../shared/database-desktop-codecs'

// ── State ────────────────────────────────────────────────────
interface MobileServerOwner {
  db: DatabaseManager
  deps: MobileApiDeps
  http: HttpServer
  websocket: WebSocketServer
  requests: Set<Promise<void>>
  closing: boolean
  startup: Promise<number>
  rejectStartup: (error: Error) => void
  nativeClosed: Promise<void>
  websocketClosed: Promise<void>
  drain: Promise<void> | null
  expiryTimer: ReturnType<typeof setInterval>
}
const mobileOwners = new Set<MobileServerOwner>()
const closedMobileSources = new WeakSet<DatabaseManager>()
let currentOwner: MobileServerOwner | null = null
let server: HttpServer | null = null
let wss: WebSocketServer | null = null
let dbRef: DatabaseManager | null = null
let agentRef: AgentManager | null = null
let githubRef: GitHubManager | null = null
let gitlabRef: GitLabManager | null = null
let forgejoRef: ForgejoManager | null = null
let syncManagerRef: SyncManager | null = null
let pluginRegistryRef: PluginRegistry | null = null
let notifyDesktop: ((channel: string, data: unknown) => void) | null = null
let pendingPin: { pin: string; pairCodeId: string; expiresAt: number } | null = null
let boundHost: string | null = null
let boundPort: number | null = null

export function getPendingPin(): { pin: string; pairCodeId: string; expiresAt: number } | null {
  if (!pendingPin) return null
  if (Math.floor(Date.now() / 1000) > pendingPin.expiresAt) {
    pendingPin = null
    return null
  }
  return pendingPin
}

const wsClients = new Set<WebSocket>()
const wsTokens = new Map<WebSocket, string>()
let mobileDistRoot: string | null = null

const PIN_EXPIRY_SECONDS = 60
const PIN_MAX_ATTEMPTS = 3

export const MOBILE_API_PORT = 20620
/** Settings keys. Mobile access and LAN exposure are both opt-in. */
export const MOBILE_ACCESS_ENABLED_SETTING = 'mobile_access_enabled'
export const MOBILE_LAN_ACCESS_SETTING = 'mobile_lan_access'
export const MOBILE_SESSION_IDLE_DAYS_SETTING = 'mobile_session_idle_days'
export const DEFAULT_MOBILE_SESSION_IDLE_DAYS = 7

/**
 * Global (not per-IP) budget for /api/auth/pair/*. Every request through the
 * cloudflared tunnel arrives from 127.0.0.1, so a per-client limit would not
 * hold back an internet attacker.
 */
export const PAIR_RATE_LIMIT_MAX = 20
export const PAIR_RATE_LIMIT_WINDOW_MS = 60_000
let pairWindowStart = 0
let pairWindowCount = 0

function allowPairRequest(): boolean {
  const now = Date.now()
  if (now - pairWindowStart >= PAIR_RATE_LIMIT_WINDOW_MS) {
    pairWindowStart = now
    pairWindowCount = 0
  }
  pairWindowCount++
  return pairWindowCount <= PAIR_RATE_LIMIT_MAX
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isMobileAccessEnabled(db: DatabaseManager): boolean {
  return db.getSetting(MOBILE_ACCESS_ENABLED_SETTING) === 'true'
}

export function isMobileLanAccessEnabled(db: DatabaseManager): boolean {
  return db.getSetting(MOBILE_LAN_ACCESS_SETTING) === 'true'
}

export function getMobileSessionIdleDays(db: DatabaseManager): number {
  const days = Number(db.getSetting(MOBILE_SESSION_IDLE_DAYS_SETTING))
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_MOBILE_SESSION_IDLE_DAYS
}

function validateSession(provided: string | null | undefined, touch = true): boolean {
  if (!provided || !dbRef || mobileDistRoot && !isMobileAccessEnabled(dbRef)) return false
  if (provided.length > 128 || /[\u0000-\u0020\u007f]/.test(provided)) return false
  const hash = hashToken(provided)
  if (dbRef.db.prepare('SELECT 1 FROM mobile_sessions WHERE token_hash=? AND (length(CAST(id AS BLOB))>128 OR length(CAST(device_name AS BLOB))>256) LIMIT 1').get(hash)) return false
  const session = dbRef.getMobileSessionByTokenHash(hash)
  if (!session) return false
  const idleSeconds = Math.floor(Date.now() / 1000) - session.last_seen
  if (idleSeconds > getMobileSessionIdleDays(dbRef) * 86_400) {
    // Idle too long: revoke so the device also drops off the connected list.
    dbRef.revokeMobileSession(session.id)
    return false
  }
  if (touch) dbRef.touchMobileSession(hash)
  return true
}

// ── Public API ───────────────────────────────────────────────

export function startMobileApiServer(
  db: DatabaseManager,
  agentManager: AgentManager,
  githubManager: GitHubManager,
  port = 20620,
  syncManager?: SyncManager | null,
  pluginRegistry?: PluginRegistry | null,
  gitlabManager?: GitLabManager | null,
  forgejoManager?: ForgejoManager | null,
  host = '127.0.0.1',
  distRoot?: string,
  taskOwners?: MobileApiDeps['taskOwners'],
  taskActions?: MobileTaskActions
): Promise<number> {
  if (closedMobileSources.has(db)) return Promise.reject(new Error('MOBILE_API_CLOSED'))
  const deps: MobileApiDeps = { db, agentManager, githubManager, syncManager, pluginRegistry, gitlabManager, forgejoManager, mobileDistRoot: distRoot, taskActions, taskOwners: taskOwners ? { ...taskOwners } : undefined }
  if (currentOwner) return sameMobileDeps(currentOwner.deps, deps) ? currentOwner.startup : Promise.reject(new Error('MOBILE_API_ALREADY_STARTED'))
  if (mobileOwners.size) return stopMobileApiServer().then(() => startMobileApiServer(
    db, agentManager, githubManager, port, syncManager, pluginRegistry, gitlabManager, forgejoManager, host, distRoot, taskOwners, taskActions))

  if (distRoot !== undefined) {
    try {
      if (!isAbsolute(distRoot) || realpathSync(distRoot) !== resolve(distRoot) || !statSync(distRoot).isDirectory() || !taskOwners) throw new Error()
      assertTaskLifecycleOwners(taskOwners.recurrence, taskOwners.heartbeat, taskOwners.automation)
    } catch { return Promise.reject(new Error('MOBILE_API_RESOURCES_UNAVAILABLE')) }
  }

  dbRef = db
  agentRef = agentManager
  githubRef = githubManager
  gitlabRef = gitlabManager ?? null
  forgejoRef = forgejoManager ?? null
  syncManagerRef = syncManager ?? null
  pluginRegistryRef = pluginRegistry ?? null
  mobileDistRoot = distRoot ?? null
  pairWindowStart = 0
  pairWindowCount = 0

  let owner!: MobileServerOwner
  const startup = new Promise<number>((resolve, reject) => {
    server = createServer((req, res) => {
      req.on('error', () => {})
      const work = Promise.resolve().then(async () => {
        if (owner.closing) { if (!res.destroyed) { res.writeHead(503); res.end() }; return }
        await handleHttpRequest(req, res, () => owner.closing)
      })
      owner.requests.add(work)
      void work.then(() => owner.requests.delete(work), () => { owner.requests.delete(work); res.destroy() })
    })

    // WebSocket upgrade
    wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    const http = server
    const websocket = wss
    const nativeClosed = new Promise<void>(done => http.once('close', () => {
      if (owner.closing) reject(new Error('MOBILE_API_CLOSED'))
      done()
    }))
    const websocketClosed = new Promise<void>(done => websocket.once('close', done))
    const expiryTimer = setInterval(() => revalidateMobileClients(), 30_000)
    expiryTimer.unref()
    owner = { db, deps, http, websocket, requests: new Set(), closing: false, startup: Promise.resolve(0), expiryTimer,
      rejectStartup: reject, nativeClosed, websocketClosed, drain: null }
    currentOwner = owner
    mobileOwners.add(owner)

    server.on('upgrade', (req, socket, head) => {
      if (owner.closing) { socket.destroy(); return }
      const url = new URL(req.url || '/', `http://localhost`)
      const token = url.searchParams.get('token')
      if (!validateSession(token)) {
        // A client that has already hung up turns this write into an
        // unhandled ECONNRESET/EPIPE, which would crash the main process.
        guardStream(socket, 'MobileAPI/upgrade')
        try {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        } catch { /* the client went away */ }
        socket.destroy()
        return
      }

      if (req.url?.startsWith('/ws')) {
        websocket.handleUpgrade(req, socket, head, (ws) => {
          if (owner.closing) { ws.terminate(); return }
          wsClients.add(ws)
          wsTokens.set(ws, token!)
          console.log(`[MobileAPI] WebSocket client connected (total: ${wsClients.size})`)

          ws.on('message', (data) => {
            if (!validateSession(wsTokens.get(ws) ?? null)) { ws.terminate(); return }
            try {
              const msg = JSON.parse(String(data))
              if (msg.type === 'ping') {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'pong' }))
                }
              }
            } catch {
              // ignore malformed messages
            }
          })

          ws.on('close', () => {
            wsClients.delete(ws)
            wsTokens.delete(ws)
            console.log(`[MobileAPI] WebSocket client disconnected (total: ${wsClients.size})`)
          })

          ws.on('error', () => {
            wsClients.delete(ws)
            wsTokens.delete(ws)
          })
        })
      } else {
        socket.destroy()
      }
    })

    const starting = server
    server.listen(port, host, () => {
      if (owner.closing || currentOwner !== owner) { reject(new Error('MOBILE_API_CLOSED')); return }
      const address = starting.address()
      boundPort = typeof address === 'object' && address ? address.port : port
      boundHost = host
      console.log(`[MobileAPI] Started on port ${boundPort} — http://${host}:${boundPort}`)
      resolve(boundPort)
    })

    starting.on('error', () => {
      reject(new Error('MOBILE_API_STARTUP_FAILED'))
      if (currentOwner === owner) void stopMobileApiServer()
    })
  })
  owner.startup = startup
  void startup.catch(() => {})
  return startup

}

export interface MobileTaskActions {
  create(data: CreateTaskData, guard: () => void): Promise<unknown>
  update(id: string, data: UpdateTaskData, guard: () => void): Promise<unknown>
  reorder(id: string, ids: string[], guard: () => void): Promise<unknown>
  complete(id: string, atSource: boolean, guard: () => void): Promise<unknown>
}
export interface MobileApiDeps {
  db: DatabaseManager
  agentManager: AgentManager
  githubManager: GitHubManager
  syncManager?: SyncManager | null
  pluginRegistry?: PluginRegistry | null
  gitlabManager?: GitLabManager | null
  forgejoManager?: ForgejoManager | null
  /** Trusted host-selected physical SPA root; never supplied by a renderer. */
  mobileDistRoot?: string
  taskActions?: MobileTaskActions
  taskOwners?: { recurrence: RecurrenceSchedulerCore; heartbeat: HeartbeatSchedulerCore; automation: TaskAutomationScheduler }
}

let mobileDeps: MobileApiDeps | null = null
let applyQueue: Promise<unknown> = Promise.resolve()
let applying = 0

function sameMobileDeps(left: MobileApiDeps, right: MobileApiDeps): boolean {
  return left.db === right.db && left.agentManager === right.agentManager && left.githubManager === right.githubManager &&
    (left.syncManager ?? null) === (right.syncManager ?? null) && (left.pluginRegistry ?? null) === (right.pluginRegistry ?? null) &&
    (left.gitlabManager ?? null) === (right.gitlabManager ?? null) && (left.forgejoManager ?? null) === (right.forgejoManager ?? null) &&
    (left.mobileDistRoot ?? null) === (right.mobileDistRoot ?? null) && left.taskActions === right.taskActions && left.taskOwners?.recurrence === right.taskOwners?.recurrence && left.taskOwners?.heartbeat === right.taskOwners?.heartbeat && left.taskOwners?.automation === right.taskOwners?.automation
}

/** Proves the installed singleton is the borrowed production owner's exact lease. */
export function assertMobileApiDeps(deps: MobileApiDeps): void {
  if (!mobileDeps || !sameMobileDeps(mobileDeps, deps) || closedMobileSources.has(deps.db) ||
    [...mobileOwners].some(owner => !sameMobileDeps(owner.deps, deps))) throw new Error('MOBILE_API_OWNER_MISMATCH')
  if (deps.mobileDistRoot) { if (!deps.taskOwners) throw new Error('MOBILE_API_OWNER_MISMATCH'); assertTaskLifecycleOwners(deps.taskOwners.recurrence, deps.taskOwners.heartbeat, deps.taskOwners.automation) }
}

export function setMobileApiDeps(deps: MobileApiDeps): void {
  if (mobileDeps && !sameMobileDeps(mobileDeps, deps) && mobileDeps.db.db.open && !closedMobileSources.has(mobileDeps.db)) throw new Error('MOBILE_API_OWNER_MISMATCH')
  if ((mobileOwners.size || applying) && (!mobileDeps || !sameMobileDeps(mobileDeps, deps) || [...mobileOwners].some(owner => !sameMobileDeps(owner.deps, deps)))) throw new Error('MOBILE_API_OWNER_MISMATCH')
  if (!mobileDeps || !sameMobileDeps(mobileDeps, deps)) pendingPin = null
  mobileDeps = { ...deps, taskOwners: deps.taskOwners ? { ...deps.taskOwners } : undefined }
}

/**
 * Starts, stops or rebinds the server to match the mobile access settings:
 * off → nothing listens; on → 127.0.0.1 only, or 0.0.0.0 when LAN access is
 * opted into. Calls are serialized so rapid toggles cannot race.
 * Resolves to the bound port, or null when mobile access is off.
 */
export function applyMobileAccessSettings(port = MOBILE_API_PORT): Promise<number | null> {
  const run = async (): Promise<number | null> => {
    const deps = mobileDeps
    if (deps && closedMobileSources.has(deps.db)) return null
    if (!deps || !isMobileAccessEnabled(deps.db)) {
      await stopMobileApiServer()
      return null
    }
    const host = isMobileLanAccessEnabled(deps.db) ? '0.0.0.0' : '127.0.0.1'
    if (server && boundHost === host) return boundPort
    await stopMobileApiServer()
    return startMobileApiServer(
      deps.db, deps.agentManager, deps.githubManager, port, deps.syncManager,
      deps.pluginRegistry, deps.gitlabManager, deps.forgejoManager, host, deps.mobileDistRoot, deps.taskOwners, deps.taskActions
    )
  }
  applying++
  const result = applyQueue.then(run, run).finally(() => { applying-- })
  applyQueue = result.catch(() => {})
  return result
}

export function getMobileApiBinding(): { host: string; port: number } | null {
  return server && boundHost && boundPort != null ? { host: boundHost, port: boundPort } : null
}

/** Notifies the desktop renderer of events that originate from a phone. */
export function setMobileApiNotifier(fn: (channel: string, data: unknown) => void): void {
  notifyDesktop = fn
}

/** Close network admission while retaining native close and raw route ownership. */
export function stopMobileApiServer(): Promise<void> {
  currentOwner = null
  server = null
  wss = null
  boundHost = null
  boundPort = null
  wsClients.clear()
  wsTokens.clear()
  for (const owner of mobileOwners) {
    if (owner.closing) continue
    owner.closing = true
    clearInterval(owner.expiryTimer)
    owner.rejectStartup(new Error('MOBILE_API_CLOSED'))
    for (const ws of owner.websocket.clients) ws.terminate()
    owner.websocket.close()
    owner.http.close()
    owner.http.closeAllConnections()
    owner.drain = (async () => {
      await Promise.allSettled([owner.nativeClosed, owner.websocketClosed, owner.startup])
      do { await Promise.allSettled([...owner.requests]) } while (owner.requests.size)
      mobileOwners.delete(owner)
    })()
  }
  return Promise.all([...mobileOwners].map(owner => owner.drain)).then(() => {})
}

/** Final source shutdown; incomplete joins retain ownership for a later retry. */
export async function closeMobileApiServer(timeoutMs = 2000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
    throw new RangeError('Mobile API shutdown deadline must be an integer from 1 to 3000 ms')
  }
  if (mobileDeps) closedMobileSources.add(mobileDeps.db)
  pendingPin = null
  if (dbRef) closedMobileSources.add(dbRef)
  for (const owner of mobileOwners) closedMobileSources.add(owner.db)
  const drain = stopMobileApiServer()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('MOBILE_API_SHUTDOWN_INCOMPLETE')), timeoutMs)
  })
  try { await Promise.race([Promise.allSettled([drain, applyQueue]), expired]) }
  finally { if (timer) clearTimeout(timer) }
}

/**
 * Called by AgentManager (via external listener) whenever it sends an event.
 * Broadcasts to all connected WebSocket clients.
 */
export function broadcastToMobileClients(channel: string, data: unknown): void {
  // Speech PCM and synthesis metadata are desktop-only, including direct callers.
  if (channel.startsWith('voice:speech:') || channel.startsWith('voice:tts:')) return
  if (wsClients.size === 0) return

  // Public task rows carry no private MCP scope nonce or checklist storage.
  if (mobileDistRoot && isRecord(data)) {
    const packet = data
    if (channel === 'task:created') data = { task: projectTaskLifecycleTask(packet.task) }
    if (channel === 'task:updated' && typeof packet.taskId === 'string') {
      const task = dbRef?.getTask(packet.taskId)
      if (!task) return
      data = { taskId: packet.taskId, updates: projectTaskLifecycleTask(task) }
    }
  }
  const message = JSON.stringify({ type: channel, payload: data })
  for (const ws of wsClients) {
    if (!validateSession(wsTokens.get(ws) ?? null, false)) { ws.terminate(); continue }
    if (ws.readyState === WebSocket.OPEN) {
      // Backpressure is a disconnected projection, never silently omitted data.
      // The phone rehydrates from the durable HTTP snapshot on reconnect.
      if (Buffer.byteLength(message) > 1024 * 1024 || ws.bufferedAmount > 1024 * 1024) { ws.terminate(); continue }
      ws.send(message)
    }
  }
}

/** Credential revocation closes admitted sockets immediately. */
export function revalidateMobileClients(): void {
  for (const ws of wsClients) if (!validateSession(wsTokens.get(ws) ?? null, false)) ws.terminate()
}

// ── HTTP request handler ─────────────────────────────────────

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, isClosing: () => boolean): Promise<void> {
  // CORS — only allow localhost origins (for Vite dev server).
  // The mobile SPA is served from the same origin and doesn't need CORS.
  const origin = req.headers.origin
  if (origin) {
    try {
      const originUrl = new URL(origin)
      if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      }
    } catch {
      // invalid origin header — ignore
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url || '/', `http://localhost`)
  const pathname = url.pathname

  // Pairing endpoints — no session required
  if (pathname.startsWith('/api/auth/pair/') && !allowPairRequest()) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(PAIR_RATE_LIMIT_WINDOW_MS / 1000)) })
    res.end(JSON.stringify({ error: 'Too many pairing attempts. Try again in a minute.' }))
    return
  }
  if (pathname === '/api/auth/pair/initiate' || pathname === '/api/auth/pair/verify') {
    await handleApiRoute(req, res, pathname, url, isClosing)
    return
  }

  // All other API routes — require valid session
  if (pathname.startsWith('/api/')) {
    if (!validateSession(bearerToken(req))) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    await handleApiRoute(req, res, pathname, url, isClosing)
    return
  }

  // Static file serving for mobile SPA — no auth needed
  // (the SPA reads the token from the URL hash fragment and sends it with API calls)
  serveMobileSPA(res, pathname)
}

// ── API router ───────────────────────────────────────────────

const MAX_BODY_BYTES = 1_048_576

async function handleApiRoute(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL, isClosing: () => boolean): Promise<void> {
  res.setHeader('Content-Type', 'application/json')

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405)
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  try {
    const body = req.method === 'POST' ? await readJsonBody(req, MAX_BODY_BYTES) : undefined
    if (isClosing()) return
    if (mobileDistRoot && !isMobileAccessEnabled(dbRef!)) throw Object.assign(new Error('Mobile access is disabled.'), { status: 503 })
    if (pathname !== '/api/auth/pair/initiate' && pathname !== '/api/auth/pair/verify' && !validateSession(bearerToken(req))) throw Object.assign(new Error('Unauthorized'), { status: 401 })
    if (mobileDistRoot) { assertMobileApiDeps(currentOwner!.deps); preflightMobileData(pathname) }
    const owner = currentOwner!
    const token = bearerToken(req)
    const guard = (): void => {
      if (owner.closing || currentOwner !== owner || !validateSession(token, false))
        throw Object.assign(new Error('Mobile access ended.'), { status: 401 })
    }
    const result = body && mobileDistRoot && !pathname.startsWith('/api/auth/pair/')
      ? await owner.deps.agentManager.withTaskGroupRequestGuard(() => routePost(pathname, body, req, guard), guard, new AbortController().signal)
      : body ? await routePost(pathname, body, req) : await routeGet(pathname, url)
    if (mobileDistRoot && !pathname.startsWith('/api/auth/pair/')) guard()
    if (res.destroyed) return
    const encoded = JSON.stringify(result)
    if (mobileDistRoot && Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw Object.assign(new Error('Mobile response exceeds the supported size.'), { status: 413 })
    res.writeHead(200)
    res.end(encoded)
  } catch (err: unknown) {
    if (res.destroyed) return
    const status = (err as { status?: number }).status || 500
    const message = mobileDistRoot && status >= 500 ? 'Mobile request failed.' : err instanceof Error ? err.message : String(err)
    res.writeHead(status)
    res.end(JSON.stringify({ error: message }))
  }
}

/** Reject oversized legacy rows before their JSON deserializers are entered.
 * This keeps the existing unpaginated HTTP contract honest; no truncation. */
function preflightMobileData(pathname: string): void {
  const db = dbRef!.db
  const check = (table: string, columns: string[], limit: number, maxRow: number): void => {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))
    const fields = columns.filter(column => existing.has(column)).map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`)
    const size = fields.join('+') || '0'
    const stats = db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(${size}),0) AS largest, COALESCE(SUM(${size}),0) AS bytes FROM ${table}`).get() as { count: number; largest: number; bytes: number }
    if (stats.count > limit || stats.largest > maxRow || stats.bytes > 8 * 1024 * 1024) throw Object.assign(new Error('Mobile data exceeds the supported size.'), { status: 413 })
  }
  if (/^\/api\/(tasks|projects|sessions)(\/|$)/.test(pathname)) {
    check('tasks', ['id', 'title', 'description', 'labels', 'attachments', 'repos', 'output_fields', 'recurrence_pattern', 'result', 'session_id'], 4096, 1024 * 1024)
    check('agents', ['id', 'name', 'server_url', 'config'], 256, 512 * 1024)
  }
  if (pathname.includes('/transcript')) check('transcript_parts', ['task_id', 'part_id', 'content', 'payload'], 4096, 1024 * 1024)
  if (pathname.startsWith('/api/agents')) check('agents', ['id', 'name', 'server_url', 'config'], 256, 512 * 1024)
  if (pathname.startsWith('/api/task-sources')) check('task_sources', ['id', 'name', 'config'], 256, 512 * 1024)
  if (pathname.startsWith('/api/task-sources')) check('tasks', ['id', 'project_id', 'source_id', 'role', 'group_id', 'external_id'], 4096, 1024 * 1024)
  if (pathname.startsWith('/api/skills')) check('skills', ['id', 'name', 'description', 'content', 'tags'], 512, 512 * 1024)
}

// ── GET routes ───────────────────────────────────────────────

async function routeGet(pathname: string, url: URL): Promise<unknown> {
  const db = dbRef!

  // GET /api/projects — active projects with cheap task counts. `current`
  // marks the project a task created without a project_id lands in.
  if (pathname === '/api/projects') {
    const counts = new Map<string, { total: number; open: number }>()
    for (const task of db.getTasks()) {
      const entry = counts.get(task.project_id) ?? { total: 0, open: 0 }
      entry.total++
      if (task.status !== TaskStatus.Completed) entry.open++
      counts.set(task.project_id, entry)
    }
    const currentId = resolveDefaultProjectId(db)
    return db.getProjects().map(project => ({
      id: project.id,
      name: project.name,
      brief: project.description,
      is_default: project.id === DEFAULT_PROJECT_ID,
      current: project.id === currentId,
      task_count: counts.get(project.id)?.total ?? 0,
      open_task_count: counts.get(project.id)?.open ?? 0,
      sort_order: project.sort_order
    }))
  }

  // GET /api/projects/status — the all-projects overview (#63): every active
  // project's status counts, approvals, agents, limit state and last activity,
  // the same rows the desktop overview shows. Read-only.
  if (pathname === '/api/projects/status') {
    return buildProjectOverview(db, agentRef)
  }

  // GET /api/tasks
  if (pathname === '/api/tasks') {
    const projectId = url.searchParams.get('project_id')
    if (projectId && !db.getProject(projectId)) {
      throw Object.assign(new Error('Project not found'), { status: 404 })
    }
    let tasks = db.getTasks(projectId ? { projectId } : undefined)

    const status = url.searchParams.get('status')
    if (status) tasks = tasks.filter(t => t.status === status)

    const priority = url.searchParams.get('priority')
    if (priority) tasks = tasks.filter(t => t.priority === priority)

    const source = url.searchParams.get('source')
    if (source) tasks = tasks.filter(t => t.source === source)

    const search = url.searchParams.get('search')
    if (search) {
      const q = search.toLowerCase()
      tasks = tasks.filter(t =>
        t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
      )
    }

    const sort = url.searchParams.get('sort') || 'created_at'
    const order = url.searchParams.get('order') || 'desc'
    const dir = order === 'asc' ? 1 : -1

    const PRIORITY_ORDER: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 }
    const STATUS_ORDER: Record<string, number> = { agent_working: 5, agent_learning: 4, triaging: 3, ready_for_review: 2, not_started: 1, completed: 0 }

    tasks.sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[sort]
      const vb = (b as unknown as Record<string, unknown>)[sort]
      if (va == null && vb == null) return 0
      if (va == null) return dir
      if (vb == null) return -dir
      // Use semantic ordering for priority and status instead of alphabetical
      if (sort === 'priority') {
        const pa = PRIORITY_ORDER[va as string] ?? 0
        const pb = PRIORITY_ORDER[vb as string] ?? 0
        return (pa - pb) * dir
      }
      if (sort === 'status') {
        const sa = STATUS_ORDER[va as string] ?? 0
        const sb = STATUS_ORDER[vb as string] ?? 0
        return (sa - sb) * dir
      }
      if (va < vb) return -dir
      if (va > vb) return dir
      return 0
    })

    return mobileDistRoot ? tasks.map(projectTaskLifecycleTask) : tasks
  }

  // GET /api/tasks/:taskId/transcript — full durable transcript snapshot.
  // Mobile is a PURE READER of the projection: read straight from the DB, never
  // via AgentManager.getTranscriptSnapshot (which can trigger the one-time
  // backfill/ingest). A mobile client connecting must not mutate the projection
  // or broadcast deltas to other clients. The desktop (session owner) owns the
  // one-time seed of pre-store sessions.
  const transcriptMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/transcript$/)
  if (transcriptMatch) {
    return db.getTranscriptParts(decodeURIComponent(transcriptMatch[1]))
  }

  // GET /api/tasks/:taskId/transcript/delta?sinceRev=N — parts changed since rev.
  // Pure DB read (see above): no backfill, no writes, no broadcast.
  const deltaMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/transcript\/delta$/)
  if (deltaMatch) {
    const sinceRev = Number(url.searchParams.get('sinceRev') || '0') || 0
    return db.getTranscriptDelta(decodeURIComponent(deltaMatch[1]), sinceRev)
  }

  // GET /api/tasks/:taskId/artifacts/content?path=... — authenticated artifact
  // content read constrained to this task's workspace by readTaskArtifact.
  const artifactContentMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/content$/)
  if (artifactContentMatch) {
    const taskId = decodeURIComponent(artifactContentMatch[1])
    if (!db.getTask(taskId)) throw Object.assign(new Error('Task not found'), { status: 404 })
    const artifactPath = url.searchParams.get('path')
    if (!artifactPath) throw Object.assign(new Error('path is required'), { status: 400 })
    const content = await readTaskArtifact(db.getWorkspaceDir(taskId), artifactPath)
    if (!content) throw Object.assign(new Error('Artifact not found or cannot be previewed'), { status: 404 })
    return content
  }

  // GET /api/tasks/:taskId/artifacts — explicit workpiece registry plus the
  // bounded legacy import/recovery scan.
  const artifactsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts$/)
  if (artifactsMatch) {
    const taskId = decodeURIComponent(artifactsMatch[1])
    if (!db.getTask(taskId)) throw Object.assign(new Error('Task not found'), { status: 404 })
    const entries = await listTaskArtifactEntries(db.getWorkspaceDir(taskId), taskId)
    return entries.map((entry) => artifactFromFileEntry(taskId, entry))
  }

  // GET /api/github/pull-request?url=... — authenticated, read-only PR details.
  if (pathname === '/api/github/pull-request') {
    const pullRequestUrl = url.searchParams.get('url')
    if (!pullRequestUrl) throw Object.assign(new Error('url is required'), { status: 400 })
    if (forgejoRef && !/^https:\/\/github\.com\//i.test(pullRequestUrl) && await forgejoRef.isForgejoUrl(pullRequestUrl)) {
      return forgejoRef.fetchPullRequestDetails(pullRequestUrl)
    }
    if (!githubRef) throw Object.assign(new Error('GitHub not configured'), { status: 500 })
    return githubRef.fetchPullRequestDetails(pullRequestUrl)
  }

  // GET /api/tasks/:id
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskMatch) {
    const task = db.getTask(taskMatch[1])
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 })
    return mobileDistRoot ? projectTaskLifecycleTask(task) : task
  }

  // GET /api/agents
  if (pathname === '/api/agents') {
    return db.getAgents().map(stripSensitiveAgentFields)
  }

  // GET /api/agents/:id
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/)
  if (agentMatch) {
    const agent = db.getAgent(agentMatch[1])
    if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 })
    return stripSensitiveAgentFields(agent)
  }

  // GET /api/capabilities — what this client can and cannot do.
  // Voice capture is desktop-only in phase 1, so mobile shows a clear note
  // instead of a button that cannot work (design §5.11).
  if (pathname === '/api/capabilities') {
    return { voice: MOBILE_VOICE_CAPABILITIES }
  }

  // GET /api/skills
  if (pathname === '/api/skills') {
    return db.getSkills()
  }

  // GET /api/sessions
  if (pathname === '/api/sessions') {
    return getActiveSessions()
  }

  // GET /api/auth/sessions — connected devices list
  if (pathname === '/api/auth/sessions') {
    return db.getMobileSessions()
  }

  // GET /api/task-sources — list all configured task sources
  if (pathname === '/api/task-sources') {
    return db.getTaskSources().map(withoutSourceConfig)
  }

  // GET /api/plugins — list available plugins
  if (pathname === '/api/plugins') {
    if (!pluginRegistryRef) return []
    return pluginRegistryRef.list()
  }

  // GET /api/plugins/:id/schema — get config schema for a plugin
  const pluginSchemaMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/schema$/)
  if (pluginSchemaMatch) {
    if (!pluginRegistryRef) throw Object.assign(new Error('Plugin registry not available'), { status: 503 })
    const plugin = pluginRegistryRef.get(pluginSchemaMatch[1])
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 })
    return plugin.getConfigSchema()
  }

  // GET /api/plugins/:id/documentation — get setup documentation for a plugin
  const pluginDocMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/documentation$/)
  if (pluginDocMatch) {
    if (!pluginRegistryRef) throw Object.assign(new Error('Plugin registry not available'), { status: 503 })
    const plugin = pluginRegistryRef.get(pluginDocMatch[1])
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 })
    return { documentation: plugin.getSetupDocumentation?.() ?? null }
  }

  // GET /api/github/org — returns the configured github org
  if (pathname === '/api/github/org') {
    const org = db.getSetting('github_org') || ''
    return { org }
  }

  // GET /api/git/provider — returns the configured git provider
  if (pathname === '/api/git/provider') {
    const provider = db.getSetting('git_provider') || 'github'
    return { provider }
  }

  // GET /api/github/orgs — returns available orgs + personal accounts
  // Fetches from ALL authenticated providers (GitHub and/or GitLab)
  if (pathname === '/api/github/orgs') {
    const owners: Array<{ value: string; label: string; provider: string }> = []

    // Try GitHub
    if (githubRef) {
      try {
        const [status, orgs] = await Promise.all([
          githubRef.checkGhCli(),
          githubRef.fetchUserOrgs()
        ])
        if (status.authenticated) {
          if (status.username) {
            owners.push({ value: status.username, label: `${status.username} (GitHub personal)`, provider: 'github' })
          }
          for (const orgName of orgs) {
            owners.push({ value: orgName, label: `${orgName} (GitHub)`, provider: 'github' })
          }
        }
      } catch { /* GitHub not available — skip */ }
    }

    // Try GitLab
    if (gitlabRef) {
      try {
        const [status, orgs] = await Promise.all([
          gitlabRef.checkGlabCli(),
          gitlabRef.fetchUserOrgs()
        ])
        if (status.authenticated) {
          if (status.username) {
            owners.push({ value: status.username, label: `${status.username} (GitLab personal)`, provider: 'gitlab' })
          }
          for (const orgName of orgs) {
            owners.push({ value: orgName, label: `${orgName} (GitLab)`, provider: 'gitlab' })
          }
        }
      } catch { /* GitLab not available — skip */ }
    }

    // Try Forgejo (via the tea login selected in 20x)
    if (forgejoRef) {
      try {
        const status = await forgejoRef.checkTeaCli()
        if (status.authenticated) {
          const orgs = await forgejoRef.fetchUserOrgs()
          if (status.username) {
            owners.push({ value: status.username, label: `${status.username} (Forgejo personal)`, provider: 'forgejo' })
          }
          for (const orgName of orgs) {
            owners.push({ value: orgName, label: `${orgName} (Forgejo)`, provider: 'forgejo' })
          }
        }
      } catch { /* Forgejo not available — skip */ }
    }

    if (owners.length === 0) {
      throw Object.assign(new Error('No git provider authenticated'), { status: 500 })
    }

    return owners
  }

  throw Object.assign(new Error('Not found'), { status: 404 })
}

// ── POST routes ──────────────────────────────────────────────

async function routePost(pathname: string, params: Record<string, unknown>, req?: IncomingMessage, guard?: () => void): Promise<unknown> {
  const agent = agentRef!
  const db = dbRef!
  const actions = mobileDistRoot ? currentOwner?.deps.taskActions : undefined
  if (mobileDistRoot && !isRecord(params)) throw Object.assign(new Error('Invalid request.'), { status: 400 })

  // POST /api/auth/pair/initiate — phone sends init code, server generates PIN
  if (pathname === '/api/auth/pair/initiate') {
    const { code } = params as { code?: string }
    if (typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(code)) throw Object.assign(new Error('code is required'), { status: 400 })

    const now = Math.floor(Date.now() / 1000)
    // Validate init code exists and not expired
    const validCode = db.getSetting(`mobile_init_code_${code}`)
    const validUntil = db.getSetting(`mobile_init_code_${code}_exp`)
    if (!validCode || !validUntil || !/^\d{1,16}$/.test(validUntil) || now > Number(validUntil)) {
      throw Object.assign(new Error('Invalid or expired QR code. Please scan a new QR code.'), { status: 401 })
    }
    // Delete init code — single use
    db.deleteSetting(`mobile_init_code_${code}`)
    db.deleteSetting(`mobile_init_code_${code}_exp`)

    // Generate PIN and pair code ID
    db.db.prepare('DELETE FROM mobile_pair_codes WHERE expires_at<?').run(now)
    const pairCount = db.db.prepare('SELECT COUNT(*) AS count FROM mobile_pair_codes').get() as { count: number }
    if (pairCount.count >= 128) throw Object.assign(new Error('Pairing capacity reached. Try again after existing codes expire.'), { status: 429 })
    const pin = String(randomInt(100000, 1000000))
    const pairCodeId = randomUUID()
    db.createMobilePairCode(pairCodeId, pin, now + PIN_EXPIRY_SECONDS)

    // Store pending PIN so renderer can fetch it if Settings isn't open when event fires
    pendingPin = { pin, pairCodeId, expiresAt: now + PIN_EXPIRY_SECONDS }

    // Push PIN to desktop
    if (notifyDesktop) {
      notifyDesktop('mobile:pairing-initiated', { pin, pairCodeId, expiresAt: now + PIN_EXPIRY_SECONDS })
    }

    return { pairCodeId, expiresIn: PIN_EXPIRY_SECONDS }
  }

  // POST /api/auth/pair/verify — phone submits PIN
  if (pathname === '/api/auth/pair/verify') {
    const { pairCodeId, pin } = params as { pairCodeId?: string; pin?: string }
    if (typeof pairCodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(pairCodeId) || typeof pin !== 'string' || !/^\d{6}$/.test(pin.trim())) throw Object.assign(new Error('pairCodeId and pin are required'), { status: 400 })

    const now = Math.floor(Date.now() / 1000)
    const record = db.getMobilePairCode(pairCodeId)

    if (!record) throw Object.assign(new Error('Invalid pairing session'), { status: 401 })
    if (now > record.expires_at) {
      db.deleteMobilePairCode(pairCodeId)
      throw Object.assign(new Error('PIN expired. Please scan the QR code again.'), { status: 401 })
    }

    const attempts = db.incrementPairCodeAttempts(pairCodeId)
    if (attempts > PIN_MAX_ATTEMPTS) {
      db.deleteMobilePairCode(pairCodeId)
      throw Object.assign(new Error('Too many incorrect attempts. Please scan the QR code again.'), { status: 401 })
    }

    if (record.pin !== pin.trim()) {
      const remaining = PIN_MAX_ATTEMPTS - attempts
      throw Object.assign(new Error(`Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`), { status: 401 })
    }

    // PIN correct — issue session token
    const sessionCount = db.db.prepare('SELECT COUNT(*) AS count FROM mobile_sessions WHERE revoked=0').get() as { count: number }
    if (sessionCount.count >= 128) throw Object.assign(new Error('Device capacity reached. Revoke an existing device first.'), { status: 429 })
    pendingPin = null
    db.deleteMobilePairCode(pairCodeId)
    const sessionToken = randomUUID()
    const tokenHash = hashToken(sessionToken)
    const sessionId = randomUUID()
    const userAgent = req?.headers['user-agent'] || 'Unknown device'
    const deviceName = parseDeviceName(userAgent)
    db.createMobileSession(sessionId, tokenHash, deviceName)

    // Notify desktop of new connection
    if (notifyDesktop) {
      notifyDesktop('mobile:device-connected', { sessionId, deviceName })
    }

    return { sessionToken, sessionId, deviceName }
  }

  // POST /api/plugins/:id/resolve-options — resolve dynamic options for a plugin config field
  const pluginResolveMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/resolve-options$/)
  if (pluginResolveMatch) {
    if (mobileDistRoot) throw Object.assign(new Error('Configure integration options on the desktop.'), { status: 503 })
    if (!pluginRegistryRef) throw Object.assign(new Error('Plugin registry not available'), { status: 503 })
    const pluginId = pluginResolveMatch[1]
    const plugin = pluginRegistryRef.get(pluginId)
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 })

    const { resolverKey, config } = params as { resolverKey?: string; config?: Record<string, unknown> }
    if (!resolverKey) throw Object.assign(new Error('resolverKey is required'), { status: 400 })

    return plugin.resolveOptions(resolverKey, config || {}, { db })
  }

  // POST /api/task-sources — create a new task source
  if (pathname === '/api/task-sources') {
    if (mobileDistRoot) throw Object.assign(new Error('Create task sources on the desktop.'), { status: 503 })
    const { name, plugin_id, config, mcp_server_id } = params as {
      name?: string; plugin_id?: string; config?: Record<string, unknown>; mcp_server_id?: string | null
    }
    if (!name || !plugin_id) throw Object.assign(new Error('name and plugin_id are required'), { status: 400 })
    const source = db.createTaskSource({ name, plugin_id, config: config || {}, mcp_server_id: mcp_server_id || null })
    return withoutSourceConfig(source)
  }

  // POST /api/task-sources/sync-all — sync all enabled task sources (must be before :id routes)
  if (pathname === '/api/task-sources/sync-all') {
    if (mobileDistRoot && !hasExactKeys(params, [])) throw Object.assign(new Error('Invalid sync request.'), { status: 400 })
    if (!syncManagerRef) throw Object.assign(new Error('Sync manager not available'), { status: 503 })
    const sources = db.getTaskSources().filter((s: { enabled: boolean }) => s.enabled)
    const results = await Promise.allSettled(
      sources.map((s: { id: string }) => syncManagerRef!.importTasks(s.id, guard))
    )
    return results.map((r) =>
      r.status === 'fulfilled' ? (mobileDistRoot ? fixedMobileSyncResult(r.value) : r.value) : { error: mobileDistRoot ? 'Task source sync failed.' : String((r as PromiseRejectedResult).reason) }
    )
  }

  // POST /api/task-sources/:id/sync — sync a single task source
  const sourceSyncMatch = pathname.match(/^\/api\/task-sources\/([^/]+)\/sync$/)
  if (sourceSyncMatch) {
    if (mobileDistRoot && (!isDatabaseId(sourceSyncMatch[1]) || !hasExactKeys(params, []))) throw Object.assign(new Error('Invalid sync request.'), { status: 400 })
    if (!syncManagerRef) throw Object.assign(new Error('Sync manager not available'), { status: 503 })
    const result = await syncManagerRef.importTasks(sourceSyncMatch[1], guard)
    return mobileDistRoot ? fixedMobileSyncResult(result) : result
  }

  // POST /api/task-sources/:id — update a task source
  const sourceUpdateMatch = pathname.match(/^\/api\/task-sources\/([^/]+)$/)
  if (sourceUpdateMatch) {
    const sourceId = sourceUpdateMatch[1]
    const source = db.getTaskSource(sourceId)
    if (!source) throw Object.assign(new Error('Task source not found'), { status: 404 })
    if (mobileDistRoot) {
      if (!isDatabaseId(sourceId) || !hasExactKeys(params, [], ['name', 'enabled']) || Object.keys(params).length === 0 || params.name !== undefined && (typeof params.name !== 'string' || !params.name.trim() || Buffer.byteLength(params.name) > 512 || /[\u0000-\u001f\u007f]/.test(params.name)) || params.enabled !== undefined && typeof params.enabled !== 'boolean') throw Object.assign(new Error('Change task source credentials and bindings on the desktop.'), { status: 400 })
      if (!syncManagerRef) throw Object.assign(new Error('Task source owner unavailable.'), { status: 503 })
      const snapshot = (): string => JSON.stringify({ source: db.db.prepare('SELECT * FROM task_sources WHERE id=?').get(sourceId), tasks: db.db.prepare('SELECT id,project_id,source_id,role,group_id,external_id FROM tasks WHERE source_id=? ORDER BY id').all(sourceId) })
      const expected = snapshot()
      const updated = await syncManagerRef.runSourceMutation(sourceId, () => {
        if (!currentOwner || currentOwner.closing || currentOwner.db !== db || !validateSession(req ? bearerToken(req) : null, false) || snapshot() !== expected) throw Object.assign(new Error('Task source changed or access ended.'), { status: 409 })
        return db.updateTaskSource(sourceId, params as Parameters<DatabaseManager['updateTaskSource']>[1])
      })
      return withoutSourceConfig(updated)
    }
    const updated = db.updateTaskSource(sourceId, params as Parameters<DatabaseManager['updateTaskSource']>[1])
    return withoutSourceConfig(updated)
  }

  // POST /api/tasks/reorder-subtasks — reorder subtasks under a parent
  if (pathname === '/api/tasks/reorder-subtasks') {
    const { parentId, orderedIds } = params as { parentId?: string; orderedIds?: string[] }
    if (!parentId || !Array.isArray(orderedIds)) {
      throw Object.assign(new Error('parentId and orderedIds are required'), { status: 400 })
    }
    if (mobileDistRoot) {
      if (!hasExactKeys(params, ['parentId', 'orderedIds']) || !TASK_LIFECYCLE_CODECS['db:reorderSubtasks'].validateArguments([parentId, orderedIds])) throw Object.assign(new Error('Invalid task order.'), { status: 400 })
      assertProductionOrdinaryTask(db, parentId)
      const children = db.getSubtasks(parentId)
      if (children.length !== orderedIds.length || children.some(task => task.group_id || task.role !== 'task' || !orderedIds.includes(task.id))) throw Object.assign(new Error('Task order must include only the current subtasks.'), { status: 409 })
    }
    if (actions && guard) return actions.reorder(parentId, orderedIds, guard)
    if (mobileDistRoot) await runMobileTaskMutation(db, agent, [parentId, ...orderedIds], req, async () => { db.reorderSubtasks(parentId, orderedIds) })
    else db.reorderSubtasks(parentId, orderedIds)
    broadcastToMobileClients('task:subtasks-reordered', { parentId, orderedIds })
    if (notifyDesktop) notifyDesktop('task:subtasks-reordered', { parentId, orderedIds })
    return { success: true }
  }

  // POST /api/tasks — create task (must be checked before the :id update route)
  if (pathname === '/api/tasks') {
    if (mobileDistRoot) {
      if (!isTaskLifecycleCreate(params) || Object.hasOwn(params, 'recurrence_parent_id') || Object.hasOwn(params, 'next_subtask_ids') || params.status !== undefined && params.status !== TaskStatus.NotStarted) throw Object.assign(new Error('Invalid task fields.'), { status: 400 })
      if (!hasExactKeys(params, ['title'], CREATE_TASK_FIELDS.filter(key => key !== 'title'))) throw Object.assign(new Error('Create this task configuration on the desktop.'), { status: 400 })
      if (Array.isArray(params.attachments) && params.attachments.length) throw Object.assign(new Error('Import attachments on the desktop.'), { status: 409 })
      if (!actions) assertProductionTaskFields(db, params)
      if (typeof params.parent_task_id === 'string') {
        assertProductionOrdinaryTask(db, params.parent_task_id)
        const parent = db.getTask(params.parent_task_id)!
        if (params.project_id != null && params.project_id !== parent.project_id) throw Object.assign(new Error('A subtask must keep its parent project.'), { status: 400 })
      }
    }
    if (!params.title) throw Object.assign(new Error('title is required'), { status: 400 })
    const data = pickCreateTaskFields(params)
    if (data.project_id !== undefined && data.project_id !== null) {
      const project = typeof data.project_id === 'string' ? db.getProject(data.project_id) : undefined
      if (!project || project.archived) {
        throw Object.assign(new Error('project_id must name an active project'), { status: 400 })
      }
    } else if (!data.parent_task_id) {
      // A subtask always joins its parent's project (DatabaseManager decides);
      // anything else lands in the desktop's current project.
      data.project_id = resolveDefaultProjectId(db)
    }
    if (actions && guard) return actions.create(data, guard)
    const created = mobileDistRoot && data.parent_task_id
      ? await runMobileTaskMutation(db, agent, [data.parent_task_id, ...db.getSubtasks(data.parent_task_id).map(child => child.id)], req, async () => db.createTask(data)) : db.createTask(data)
    if (!created) throw Object.assign(new Error('Failed to create task'), { status: 500 })
    afterTaskCreated(created)
    const task = db.getTask(created.id) ?? created
    broadcastToMobileClients('task:created', { task })
    if (notifyDesktop) notifyDesktop('task:created', { task })
    return task
  }

  // Source-less tasks are local 20x records. Only sourced tasks delegate
  // completion to their external authority.
  const taskCompleteMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/complete$/)
  if (taskCompleteMatch) {
    const taskId = taskCompleteMatch[1]
    const task = db.getTask(taskId)
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 })
    if (mobileDistRoot) {
      if (!hasExactKeys(params, [], ['completeAtSource']) || params.completeAtSource !== undefined && typeof params.completeAtSource !== 'boolean') throw Object.assign(new Error('Invalid completion choice.'), { status: 400 })
      assertProductionOrdinaryTask(db, taskId)
      if (actions && guard) return actions.complete(taskId, params.completeAtSource !== false, guard)
      if (task.source_id && params.completeAtSource !== false) throw Object.assign(new Error('Complete this task at its source on the desktop.'), { status: 503 })
      if (agent.hasTaskStartOwnership(taskId) || task.status === TaskStatus.AgentLearning) throw Object.assign(new Error('Stop the task before completing it on mobile.'), { status: 409 })
      if (db.getSubtasks(taskId).some(child => ![TaskStatus.Completed, TaskStatus.ReadyForReview].includes(child.status as TaskStatus))) throw Object.assign(new Error('Finish the subtasks before completing this task.'), { status: 409 })
    }
    const completeAtSource = (params as { completeAtSource?: boolean }).completeAtSource !== false
    // A second explicit completion while feedback learning is pending cancels
    // that learning cycle first. Without clearing its durable marker, the
    // database protects AgentLearning and silently preserves the old status.
    if (task.status === TaskStatus.AgentLearning) {
      updateTaskFromUser(db, taskId, { status: TaskStatus.ReadyForReview })
    }
    if (!task.source_id || !completeAtSource) {
      const data: UpdateTaskData = { status: TaskStatus.Completed, ...(task.source_id ? { complete_at_source: false } : {}) }
      const fresh = mobileDistRoot ? await runMobileTaskMutation(db, agent, [taskId], req, async () => {
        if (agent.hasTaskStartOwnership(taskId)) throw Object.assign(new Error('Stop the task before completing it on mobile.'), { status: 409 })
        return db.updateTask(taskId, data)
      }) : db.updateTask(taskId, data)
      if (fresh) {
        broadcastToMobileClients('task:updated', { taskId, updates: fresh })
        if (notifyDesktop) notifyDesktop('task:updated', { taskId, updates: fresh })
        afterTaskUpdated(db, agent, task, data, fresh)
      }
      return { completed: true, status: fresh?.status }
    }
    if (!syncManagerRef) {
      throw Object.assign(new Error('Task source is unavailable.'), { status: 409 })
    }
    db.updateTask(taskId, { complete_at_source: true })
    try {
      await completeTaskAtSource(syncManagerRef, task)
    } catch (err) {
      throw Object.assign(err as Error, { status: 409 })
    }
    const fresh = db.getTask(taskId)
    if (fresh) {
      broadcastToMobileClients('task:updated', { taskId, updates: fresh })
    }
    return { completed: true, status: fresh?.status }
  }

  // POST /api/tasks/:id — update task
  const taskUpdateMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskUpdateMatch) {
    const taskId = taskUpdateMatch[1]
    const existing = db.getTask(taskId)
    if (!existing) throw Object.assign(new Error('Task not found'), { status: 404 })
    if (mobileDistRoot) {
      assertProductionOrdinaryTask(db, taskId)
      if (actions && Object.hasOwn(params, 'attachments')) throw Object.assign(new Error('Attachment replacement requires an explicit baseline on the desktop.'), { status: 409 })
      if (!isTaskLifecycleUpdate(params) || ['parent_task_id', 'next_subtask_ids', 'last_occurrence_at', 'next_occurrence_at', 'heartbeat_last_check_at', 'heartbeat_next_check_at'].some(key => Object.hasOwn(params, key))) throw Object.assign(new Error('Invalid task fields.'), { status: 400 })
      if (params.status === TaskStatus.Completed && (existing.source_id || agent.findSessionByTaskId(taskId))) throw Object.assign(new Error('Use the task completion controls after stopping this task.'), { status: 409 })
    }
    if (actions && guard) return actions.update(taskId, params as UpdateTaskData, guard)
    if (mobileDistRoot) assertProductionTaskFields(db, params, existing)
    const update = async () => {
      const previous = db.getTask(taskId)!
      if (mobileDistRoot && params.agent_id !== undefined && params.agent_id !== previous.agent_id) await agent.stopByTaskId(taskId)
      const prepared = await prepareUserTaskUpdate(agent, previous, params as UpdateTaskData)
      if (mobileDistRoot && (!currentOwner || !validateSession(req ? bearerToken(req) : null, false))) throw Object.assign(new Error('Mobile access ended.'), { status: 401 })
      const updated = Object.keys(prepared.data).length > 0 ? updateTaskFromUser(db, taskId, prepared.data) : db.getTask(taskId)
      return { prepared, updated }
    }
    const { prepared, updated } = mobileDistRoot ? await runMobileTaskMutation(db, agent, [taskId, ...db.getSubtasks(taskId).map(task => task.id)], req, update) : await update()
    if (updated && Object.keys(prepared.data).length > 0) {
      broadcastToMobileClients('task:updated', { taskId, updates: updated })
      if (notifyDesktop) notifyDesktop('task:updated', { taskId, updates: updated })
      afterTaskUpdated(db, agent, existing, prepared.data, updated)
    }
    if (prepared.startAfterWrite) await startPreparedTask(agent, taskId, true)
    return db.getTask(taskId) ?? updated
  }

  // POST /api/sessions/start
  if (pathname === '/api/sessions/start') {
    const { agentId, taskId, skipInitialPrompt } = params as { agentId?: string; taskId: string; skipInitialPrompt?: boolean }
    if (mobileDistRoot && (!hasExactKeys(params, ['taskId'], ['agentId', 'skipInitialPrompt']) || !isDatabaseId(taskId) || agentId !== undefined && !isDatabaseId(agentId) || skipInitialPrompt !== undefined && typeof skipInitialPrompt !== 'boolean')) throw Object.assign(new Error('Invalid session start.'), { status: 400 })
    if (!taskId) throw Object.assign(new Error('taskId is required'), { status: 400 })
    if (!agentId) {
      // No explicit agent: the same routing as the desktop's Start button and
      // the scheduler (next subtask, triage, the task's own agent), which is
      // admission-controlled too.
      if (!db.getTask(taskId)) throw Object.assign(new Error('Task not found'), { status: 404 })
      const result = await agent.startTask(taskId, { resumeManualStop: true, explicitUserStart: true })
      return {
        sessionId: result.sessionId ?? '',
        action: result.action,
        startedTaskId: result.startedTaskId,
        agentId: result.agentId,
        ...(result.action === 'queued'
          ? { queued: true, queuePosition: result.queuePosition, queueReason: result.queueReason }
          : {})
      }
    }
    // Admission-controlled: over a concurrency limit the start waits in the
    // main-process queue and starts on its own when a slot frees. This is the
    // path the desktop's agent:start IPC takes.
    const outcome = await agent.requestSession(agentId, taskId, undefined, skipInitialPrompt as boolean | undefined)
    if (outcome.status === 'queued') return { sessionId: '', queued: true, queuePosition: outcome.position, queueReason: outcome.reason }
    return { sessionId: outcome.sessionId }
  }

  // POST /api/sessions/:sessionId/resume
  const resumeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/)
  if (resumeMatch) {
    const sessionId = resumeMatch[1]
    const { agentId, taskId } = params as { agentId: string; taskId: string }
    if (mobileDistRoot && (!hasExactKeys(params, ['agentId', 'taskId']) || !isDatabaseId(agentId) || !isDatabaseId(taskId) || db.getTask(taskId)?.session_id !== sessionId || db.getTask(taskId)?.agent_id !== agentId)) throw Object.assign(new Error('Session binding changed.'), { status: 409 })
    if (!agentId || !taskId) throw Object.assign(new Error('agentId and taskId are required'), { status: 400 })
    const newSessionId = await agent.resumeSession(agentId, taskId, sessionId)
    return { sessionId: newSessionId }
  }

  // POST /api/sessions/:sessionId/send
  const sendMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/send$/)
  if (sendMatch) {
    const sessionId = sendMatch[1]
    const { message, taskId, agentId: aid, attachments } = params as {
      message: string
      taskId?: string
      agentId?: string
      attachments?: Array<{ id: string; filename: string; size: number; mime_type: string }>
    }
    if (mobileDistRoot) {
      const live = agent.getSession(sessionId)
      if (!hasExactKeys(params, ['message'], ['taskId', 'agentId', 'attachments']) || typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 65_536 || message.includes('\0') || !live || taskId !== undefined && taskId !== live.taskId || aid !== undefined && aid !== live.agentId || attachments !== undefined && (!Array.isArray(attachments) || attachments.length !== 0)) throw Object.assign(new Error('Invalid session message or attachment binding.'), { status: 400 })
    }
    if (!message) throw Object.assign(new Error('message is required'), { status: 400 })
    const result = await agent.sendMessage(sessionId, message, taskId, aid, attachments)
    return { success: true, ...result }
  }

  // POST /api/sessions/:sessionId/approve
  const approveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/approve$/)
  if (approveMatch) {
    const sessionId = approveMatch[1]
    const { approved, message, responseType, requestId } = params as {
      approved: boolean
      message?: string
      responseType?: 'permission' | 'question'
      requestId?: string
    }
    if (mobileDistRoot && (!hasExactKeys(params, ['approved', 'responseType', 'requestId'], ['message']) || !agent.getSession(sessionId) || !['permission', 'question'].includes(responseType as string) || typeof requestId !== 'string' || !requestId || Buffer.byteLength(requestId) > 512 || message !== undefined && (typeof message !== 'string' || Buffer.byteLength(message) > 65_536 || message.includes('\0')))) throw Object.assign(new Error('Invalid current approval request.'), { status: 400 })
    if (typeof approved !== 'boolean') throw Object.assign(new Error('approved (boolean) is required'), { status: 400 })
    if (mobileDistRoot) {
      const live = agent.getSession(sessionId)!
      const result = await agent.respondToScopedPermission({ sessionId, taskId: live.taskId, agentId: live.agentId, approved, message, responseType: responseType!, requestId: requestId! })
      if (!result.handled) throw Object.assign(new Error('Approval request is no longer current.'), { status: 409 })
    } else await agent.respondToPermission(sessionId, approved, message, undefined, responseType, requestId)
    return { success: true }
  }

  // POST /api/sessions/:sessionId/sync — status ping. Transcript is no longer
  // replayed here; the mobile client renders the durable projection (GET
  // /api/tasks/:taskId/transcript + `transcript:changed` deltas).
  const syncMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/sync$/)
  if (syncMatch) {
    if (mobileDistRoot && !hasExactKeys(params, [])) throw Object.assign(new Error('Invalid sync request.'), { status: 400 })
    const status = agent.getSessionStatus(syncMatch[1])
    if (!status) throw Object.assign(new Error('Session not found or not running'), { status: 404 })
    return { success: true, status: status.status }
  }

  // POST /api/sessions/:sessionId/abort
  const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/)
  if (abortMatch) {
    if (mobileDistRoot && (!hasExactKeys(params, []) || !agent.getSession(abortMatch[1]))) throw Object.assign(new Error('Session is not running.'), { status: 409 })
    await agent.abortSession(abortMatch[1])
    return { success: true }
  }

  // POST /api/sessions/:sessionId/stop
  const stopMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/)
  if (stopMatch) {
    if (mobileDistRoot && (!hasExactKeys(params, []) || !agent.getSession(stopMatch[1]))) throw Object.assign(new Error('Session is not running.'), { status: 409 })
    await agent.stopSession(stopMatch[1])
    return { success: true }
  }

  // POST /api/github/repos — fetch org repos
  // Accepts optional `provider` param ('github' | 'gitlab') to route to the right backend.
  // Falls back to the configured git_provider setting for backward compat.
  if (pathname === '/api/github/repos') {
    const { org, provider: reqProvider } = params as { org?: string; provider?: string }
    if (!org) throw Object.assign(new Error('org is required'), { status: 400 })

    const provider = reqProvider || db.getSetting('git_provider') || 'github'

    if (provider === 'gitlab') {
      if (!gitlabRef) throw Object.assign(new Error('GitLab not configured'), { status: 500 })
      const repos = await gitlabRef.fetchOrgRepos(org)
      return repos
    }

    if (provider === 'forgejo') {
      if (!forgejoRef) throw Object.assign(new Error('Forgejo not configured'), { status: 500 })
      return await forgejoRef.fetchOrgRepos(org)
    }

    if (!githubRef) throw Object.assign(new Error('GitHub not configured'), { status: 500 })
    const repos = await githubRef.fetchOrgRepos(org)
    return repos
  }

  // POST /api/git/repo-providers — remember which provider attached repos came from
  if (pathname === '/api/git/repo-providers') {
    const { repos, provider } = params as { repos?: unknown; provider?: unknown }
    if (!Array.isArray(repos) || !isGitProvider(provider)) {
      throw Object.assign(new Error('repos and a valid provider are required'), { status: 400 })
    }
    recordRepoProviders(db, repos.filter((repo): repo is string => typeof repo === 'string'), provider)
    return { success: true }
  }

  // POST /api/github/org — set configured github org
  if (pathname === '/api/github/org') {
    const { org } = params as { org?: string }
    if (!org) throw Object.assign(new Error('org is required'), { status: 400 })
    db.setSetting('github_org', org)
    return { org }
  }

  throw Object.assign(new Error('Not found'), { status: 404 })
}

// ── Helpers ──────────────────────────────────────────────────

function assertProductionOrdinaryTask(db: DatabaseManager, id: string): void {
  const task = isDatabaseId(id) ? db.getTask(id) : undefined
  if (!task || task.role !== 'task' || task.group_id) throw Object.assign(new Error('Use the desktop controls for Captain and grouped tasks.'), { status: 409 })
}

/** Complex resource/role edits need the desktop's complete reference and effect
 * service. Ordinary phone edits keep the real scheduler semantics and owners. */
function assertProductionTaskFields(db: DatabaseManager, data: Record<string, unknown>, previous?: ReturnType<DatabaseManager['getTask']>): void {
  const desktopFields = ['agent_id', 'skill_ids', 'source_id', 'external_id', 'source', 'secret_ids', 'next_subtask_ids', 'recurrence_parent_id', 'feedback_rating', 'feedback_comment', 'learn_from_feedback', 'is_heartbeat', 'heartbeat_enabled', 'heartbeat_interval_minutes', 'heartbeat_active_hours_start', 'heartbeat_active_hours_end', 'heartbeat_instructions']
  if (desktopFields.some(key => Object.hasOwn(data, key)) || previous && ['project_id', 'parent_task_id', 'repos', 'attachments'].some(key => Object.hasOwn(data, key)) ||
    !previous && [data.repos, data.attachments].some(value => Array.isArray(value) && value.length > 0) || data.status === TaskStatus.AgentLearning || previous?.heartbeat_enabled)
    throw Object.assign(new Error('Change task resources, learning and heartbeat configuration on the desktop.'), { status: 503 })
  if (previous?.source_id && data.status === TaskStatus.Completed && previous.status !== TaskStatus.Completed && data.complete_at_source !== false)
    throw Object.assign(new Error('Choose app-only completion or complete at the source on the desktop.'), { status: 503 })
  if (previous && data.status === TaskStatus.Completed && db.getSubtasks(previous.id).some(child => ![TaskStatus.Completed, TaskStatus.ReadyForReview].includes(child.status as TaskStatus)))
    throw Object.assign(new Error('Finish the subtasks before completing this task.'), { status: 409 })
  const recurring = data.is_recurring ?? previous?.is_recurring
  const pattern = data.recurrence_pattern === undefined ? previous?.recurrence_pattern : data.recurrence_pattern
  if (recurring && (!pattern || !mobileDeps?.taskOwners?.recurrence.calculateNextOccurrence(pattern as Parameters<RecurrenceSchedulerCore['calculateNextOccurrence']>[0], new Date().toISOString())))
    throw Object.assign(new Error('Invalid recurring task pattern.'), { status: 400 })
}

function fixedMobileSyncResult(value: { source_id: string; imported: number; updated: number; errors: string[] }) {
  return { source_id: value.source_id, imported: value.imported, updated: value.updated, errors: value.errors.length ? ['Task source sync failed.'] : [] }
}
async function runMobileTaskMutation<T>(db: DatabaseManager, agent: AgentManager, ids: string[], req: IncomingMessage | undefined, effect: () => Promise<T>): Promise<T> {
  if (ids.length > 128) throw Object.assign(new Error('Task change exceeds supported size.'), { status: 413 })
  const binding = (): string => JSON.stringify(ids.map(id => {
    assertProductionOrdinaryTask(db, id)
    return db.db.prepare('SELECT id,project_id,source_id,role,group_id,external_id,agent_id,parent_task_id,next_subtask_ids FROM tasks WHERE id=?').get(id)
  }))
  const expected = binding()
  return agent.runTaskLifecycleMutation(ids, async () => {
    if (!currentOwner || currentOwner.closing || currentOwner.db !== db || !validateSession(req ? bearerToken(req) : null, false) || binding() !== expected) throw Object.assign(new Error('Task binding changed or access ended.'), { status: 409 })
    return effect()
  })
}

// A phone creates local tasks only: the source link (source_id, external_id,
// source) and recurrence-instance fields are owned by sync and the scheduler.
const CREATE_TASK_FIELDS = [
  'title', 'description', 'type', 'priority', 'status', 'assignee', 'due_date', 'labels', 'attachments',
  'repos', 'output_fields', 'is_recurring', 'recurrence_pattern', 'cron', 'auto_start_agent',
  'auto_complete_without_review', 'parent_task_id', 'project_id'
] as const satisfies ReadonlyArray<keyof CreateTaskData>

function pickCreateTaskFields(params: Record<string, unknown>): CreateTaskData {
  const data: Record<string, unknown> = {}
  for (const key of CREATE_TASK_FIELDS) {
    if (params[key] !== undefined) data[key] = params[key]
  }
  return data as unknown as CreateTaskData
}

/**
 * The desktop's current-project setting, written by the desktop project
 * switcher. Tasks a phone creates without a project_id land there.
 */
export const CURRENT_PROJECT_SETTING = 'current_project_id'

/** The desktop's current project when it is set and active, else Default. */
function resolveDefaultProjectId(db: DatabaseManager): string {
  const current = db.getSetting(CURRENT_PROJECT_SETTING)
  if (current) {
    const project = db.getProject(current)
    if (project && !project.archived) return project.id
  }
  return DEFAULT_PROJECT_ID
}

function parseDeviceName(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return 'iPhone'
  if (/iPad/i.test(userAgent)) return 'iPad'
  if (/Android/i.test(userAgent)) return 'Android'
  if (/Windows/i.test(userAgent)) return 'Windows Browser'
  if (/Mac/i.test(userAgent)) return 'Mac Browser'
  return 'Unknown device'
}

function getActiveSessions(): Array<{ sessionId: string; agentId: string; taskId: string; status: string }> {
  if (!dbRef) return []

  // Walk all tasks that have a session_id and check against AgentManager
  const tasks = dbRef.getTasks()
  const results: Array<{ sessionId: string; agentId: string; taskId: string; status: string }> = []

  for (const task of tasks) {
    if (!task.session_id || !task.agent_id) continue
    const sessionStatus = agentRef?.getSessionStatus(task.session_id)
    if (sessionStatus) {
      results.push({
        sessionId: task.session_id,
        agentId: sessionStatus.agentId,
        taskId: sessionStatus.taskId,
        status: sessionStatus.status
      })
    }
  }
  return results
}

/** Strip sensitive fields (api_keys, secret_ids) from agent config before sending over the network. */
function stripSensitiveAgentFields(agent: ReturnType<DatabaseManager['getAgent']>) {
  if (!agent) return agent
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { api_keys: _keys, secret_ids: _secrets, ...safeConfig } = (agent.config || {}) as Record<string, unknown>
  return { ...agent, config: safeConfig }
}

// Source configs hold third-party API tokens. The mobile app never reads them,
// so they do not leave the desktop.
function withoutSourceConfig<T extends { config?: unknown }>(source: T | undefined) {
  if (!source) return source
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { config: _config, ...rest } = source
  return rest
}

function artifactFromFileEntry(taskId: string, entry: ArtifactFileEntry): Artifact {
  return {
    id: entry.workpieceKey
      ? `${taskId}:workpiece:${encodeURIComponent(entry.workpieceKey)}`
      : `${taskId}:${entry.type}:${encodeURIComponent(entry.path)}`,
    taskId,
    type: entry.type,
    title: entry.title,
    path: entry.path,
    workpieceKey: entry.workpieceKey,
    files: entry.files,
    updatedAt: entry.updatedAt,
    reloadTrigger: Math.floor(entry.updatedAt)
  }
}

function serveMobileSPA(res: ServerResponse, pathname: string): void {
  // Resolve static file from out/mobile/
  const mobileDir = mobileDistRoot ?? join(__dirname, '../mobile')
  const resolved = join(mobileDir, pathname === '/' ? 'index.html' : pathname)

  // Guard against path traversal — ensure resolved path stays inside mobileDir
  let filePath: string
  if (!resolved.startsWith(mobileDir + sep) && resolved !== join(mobileDir, 'index.html')) {
    filePath = join(mobileDir, 'index.html')
  } else {
    filePath = resolved
  }

  // If not found, serve index.html (SPA fallback)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(mobileDir, 'index.html')
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Mobile UI not built. Run: pnpm build:mobile')
    return
  }

  if (mobileDistRoot) {
    // Portable assets are physical host-owned resources. Reject every symlink
    // component, including a leaf changed after the initial existence check.
    const safe = (): boolean => {
      try {
        if (!filePath.startsWith(mobileDir + sep) || realpathSync(mobileDir) !== mobileDir) return false
        let cursor = mobileDir
        for (const part of filePath.slice(mobileDir.length + 1).split(sep)) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) return false }
        return realpathSync(filePath) === filePath && statSync(filePath).isFile() && statSync(filePath).size <= 8 * 1024 * 1024
      } catch { return false }
    }
    if (!safe()) { res.writeHead(404); res.end('Mobile resource unavailable.'); return }
    const content = readFileSync(filePath)
    if (content.length > 8 * 1024 * 1024 || !safe()) { res.writeHead(404); res.end('Mobile resource unavailable.'); return }
    res.writeHead(200, { 'Content-Type': mimeTypeForPath(filePath) }); res.end(content); return
  }
  res.writeHead(200, { 'Content-Type': mimeTypeForPath(filePath) })
  res.end(readFileSync(filePath))
}
