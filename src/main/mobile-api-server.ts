/**
 * Mobile API server — HTTP + WebSocket for controlling 20x from a mobile device.
 * Runs inside the Electron main process, shares DatabaseManager and AgentManager.
 * Serves the mobile SPA and provides REST + WebSocket endpoints.
 *
 * See docs/mobile-api-spec.md for the full API specification.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'http'
import { join, sep } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import type { DatabaseManager } from './database'
import type { AgentManager } from './agent-manager'
import type { GitHubManager } from './github-manager'
import type { GitLabManager } from './gitlab-manager'
import type { ForgejoManager } from './forgejo-manager'
import type { SyncManager } from './sync-manager'
import type { PluginRegistry } from './plugins/registry'
import { guardStream } from './child-stream-guards'
import { bearerToken, HttpError, readJsonBody } from './http-utils'
import { mimeTypeForPath } from './mime'
import { deps, setDeps, wsClients, type MobileApiDeps, type MobileRoute } from './mobile-api/state'
import { authRoutes, hashToken } from './mobile-api/auth-routes'
import { projectRoutes } from './mobile-api/project-routes'
import { taskRoutes } from './mobile-api/task-routes'
import { agentRoutes } from './mobile-api/agent-routes'
import { gitRoutes } from './mobile-api/git-routes'
import { sourceRoutes } from './mobile-api/source-routes'

export { broadcastToMobileClients, setMobileApiNotifier } from './mobile-api/state'
export { getPendingPin } from './mobile-api/auth-routes'

let server: HttpServer | null = null
let wss: WebSocketServer | null = null
let boundHost: string | null = null
let boundPort: number | null = null

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

function validateSession(provided: string | null | undefined): boolean {
  const db = deps?.db
  if (!provided || !db) return false
  const hash = hashToken(provided)
  const session = db.getMobileSessionByTokenHash(hash)
  if (!session) return false
  const idleSeconds = Math.floor(Date.now() / 1000) - session.last_seen
  if (idleSeconds > getMobileSessionIdleDays(db) * 86_400) {
    // Idle too long: revoke so the device also drops off the connected list.
    db.revokeMobileSession(session.id)
    return false
  }
  db.touchMobileSession(hash)
  return true
}

export function startMobileApiServer(
  db: DatabaseManager,
  agentManager: AgentManager,
  githubManager: GitHubManager,
  port = 20620,
  syncManager?: SyncManager | null,
  pluginRegistry?: PluginRegistry | null,
  gitlabManager?: GitLabManager | null,
  forgejoManager?: ForgejoManager | null,
  host = '127.0.0.1'
): Promise<number> {
  if (server) return Promise.resolve(boundPort ?? port)

  setDeps({ db, agentManager, githubManager, syncManager, pluginRegistry, gitlabManager, forgejoManager })
  pairWindowStart = 0
  pairWindowCount = 0

  return new Promise((resolve, reject) => {
    server = createServer(handleHttpRequest)

    wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
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
        wss!.handleUpgrade(req, socket, head, (ws) => {
          wsClients.add(ws)
          console.log(`[MobileAPI] WebSocket client connected (total: ${wsClients.size})`)

          ws.on('message', (data) => {
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
            console.log(`[MobileAPI] WebSocket client disconnected (total: ${wsClients.size})`)
          })

          ws.on('error', () => {
            wsClients.delete(ws)
          })
        })
      } else {
        socket.destroy()
      }
    })

    const starting = server
    server.listen(port, host, () => {
      const address = starting.address()
      boundPort = typeof address === 'object' && address ? address.port : port
      boundHost = host
      console.log(`[MobileAPI] Started on port ${boundPort} — http://${host}:${boundPort}`)
      resolve(boundPort)
    })

    starting.on('error', (err) => {
      if (server === starting) {
        wss?.close()
        wss = null
        server = null
      }
      reject(err)
    })
  })
}

let mobileDeps: MobileApiDeps | null = null
let applyQueue: Promise<unknown> = Promise.resolve()

export function setMobileApiDeps(next: MobileApiDeps): void {
  mobileDeps = next
}

/**
 * Starts, stops or rebinds the server to match the mobile access settings:
 * off → nothing listens; on → 127.0.0.1 only, or 0.0.0.0 when LAN access is
 * opted into. Calls are serialized so rapid toggles cannot race.
 * Resolves to the bound port, or null when mobile access is off.
 */
export function applyMobileAccessSettings(port = MOBILE_API_PORT): Promise<number | null> {
  const run = async (): Promise<number | null> => {
    const config = mobileDeps
    if (!config || !isMobileAccessEnabled(config.db)) {
      await stopMobileApiServer()
      return null
    }
    const host = isMobileLanAccessEnabled(config.db) ? '0.0.0.0' : '127.0.0.1'
    if (server && boundHost === host) return boundPort
    await stopMobileApiServer()
    return startMobileApiServer(
      config.db, config.agentManager, config.githubManager, port, config.syncManager,
      config.pluginRegistry, config.gitlabManager, config.forgejoManager, host
    )
  }
  const result = applyQueue.then(run, run)
  applyQueue = result.catch(() => {})
  return result
}

export function stopMobileApiServer(): Promise<void> {
  for (const ws of wsClients) {
    ws.close()
  }
  wsClients.clear()
  wss?.close()
  wss = null
  const closing = server
  server = null
  boundHost = null
  boundPort = null
  if (!closing) return Promise.resolve()
  return new Promise((resolve) => {
    closing.close(() => resolve())
    // Drop keep-alive sockets so the port is released now, not on idle timeout.
    closing.closeAllConnections()
  })
}

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
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

  if (pathname.startsWith('/api/auth/pair/') && !allowPairRequest()) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(PAIR_RATE_LIMIT_WINDOW_MS / 1000)) })
    res.end(JSON.stringify({ error: 'Too many pairing attempts. Try again in a minute.' }))
    return
  }
  // Pairing is how a phone gets a session, so it cannot require one.
  if (pathname === '/api/auth/pair/initiate' || pathname === '/api/auth/pair/verify') {
    void handleApiRoute(req, res, pathname, url)
    return
  }

  // Every other API route needs a paired session.
  if (pathname.startsWith('/api/')) {
    if (!validateSession(bearerToken(req))) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    void handleApiRoute(req, res, pathname, url)
    return
  }

  // Static file serving for mobile SPA — no auth needed
  // (the SPA reads the token from the URL hash fragment and sends it with API calls)
  serveMobileSPA(res, pathname)
}

const MAX_BODY_BYTES = 1_048_576

const ROUTES = [...authRoutes, ...projectRoutes, ...taskRoutes, ...agentRoutes, ...gitRoutes, ...sourceRoutes]

function findRoute(method: string, pathname: string): { route: MobileRoute; id: string } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, id: '' }
    } else {
      const match = pathname.match(route.path)
      if (match) return { route, id: match[1] }
    }
  }
  return null
}

async function handleApiRoute(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
  res.setHeader('Content-Type', 'application/json')

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405)
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  try {
    const params = req.method === 'POST' ? await readJsonBody(req, MAX_BODY_BYTES) : {}
    const found = findRoute(req.method, pathname)
    if (!found) throw new HttpError(404, 'Not found')
    const result = await found.route.handle({ id: found.id, params, url, req })
    res.writeHead(200)
    res.end(JSON.stringify(result))
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 500
    const message = err instanceof Error ? err.message : String(err)
    res.writeHead(status)
    res.end(JSON.stringify({ error: message }))
  }
}

function serveMobileSPA(res: ServerResponse, pathname: string): void {
  // The built SPA lives in out/mobile/.
  const mobileDir = join(__dirname, '../mobile')
  const resolved = join(mobileDir, pathname === '/' ? 'index.html' : pathname)

  // Guard against path traversal — ensure resolved path stays inside mobileDir
  let filePath: string
  if (!resolved.startsWith(mobileDir + sep) && resolved !== join(mobileDir, 'index.html')) {
    filePath = join(mobileDir, 'index.html')
  } else {
    filePath = resolved
  }

  // SPA fallback.
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(mobileDir, 'index.html')
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Mobile UI not built. Run: pnpm build:mobile')
    return
  }

  res.writeHead(200, { 'Content-Type': mimeTypeForPath(filePath) })
  res.end(readFileSync(filePath))
}
