import type { TaskMcpScope } from './mcp-servers/task-management-core'
/**
 * Lightweight HTTP API server for task-management tools.
 * Runs in the owning service process with an explicit database.
 *
 * It serves two things:
 *   - one plain JSON route per tool (see ./task-api/*-routes.ts), and
 *   - the MCP endpoint at /mcp, which agent sessions connect to directly.
 *
 * Sessions no longer spawn a task-management-mcp.js child process. That child
 * only forwarded calls to this same server, so it was pure overhead, and one
 * copy per session stayed alive for as long as the agent CLI did.
 */
import type { IncomingMessage } from 'http'
import { TaskApiListener } from './task-api/listener'
import { randomBytes, timingSafeEqual } from 'crypto'
import type { DatabaseManager } from './database'
import { TASK_MCP_PATH, handleTaskMcpRequest, buildTaskMcpUrl } from './task-mcp-endpoint'
import { bearerToken, parseJsonBody, readBody } from './http-utils'
import { handleArtifactRoute } from './task-api/artifact-routes'
import { handleConcurrencyRoute } from './task-api/concurrency-routes'
import { handleSessionRoute } from './task-api/session-routes'
import { handleSkillRoute } from './task-api/skill-routes'
import { handleTaskRoute } from './task-api/task-routes'
import { handleTaskGroupRoute } from './task-api/task-group-routes'
import { handleReviewAttestationRoute } from './task-api/review-attestation-routes'
import { handlePrWriteRoute } from './pr-write-gate'
import { handleUiRoute } from './task-api/ui-routes'
import { installCaptainGithubTools } from './captain-github-tools'

export { setTaskApiAgentController, setTaskApiNotifier, setTaskApiUiState, setTranscriptProvider, setTaskApiTaskGroupService } from './task-api/state'

export type TaskApiRouteHandler = (db: DatabaseManager, route: string, params: Record<string, unknown>, scope?: TaskMcpScope) => Promise<unknown>
interface ServerOwner { db: DatabaseManager; listener: TaskApiListener; startup: Promise<number> }
export interface TaskApiHost {
  /** Only the legacy adapter supplies the retired embedded browser host. */
  legacyBrowserRoute?: TaskApiRouteHandler
}
let active: ServerOwner | null = null
let port: number | null = null
const owners = new Set<ServerOwner>()
const closedSources = new WeakSet<DatabaseManager>()
export function getTaskApiPort(): number | null {
  return active && !active.listener.isClosing ? port : null
}

// Every caller must present this. The server is on loopback, but any local
// process, and any web page that DNS-rebinds a hostname to 127.0.0.1, can
// reach it, and its routes drive agents that run shell commands.
const apiToken = randomBytes(32).toString('hex')

export function getTaskApiToken(): string {
  return apiToken
}

/** Environment for a child process that calls the task API directly. */
export function getTaskApiEnv(scope?: TaskMcpScope): Record<string, string> {
  const currentPort = getTaskApiPort()
  return currentPort ? { TASK_API_URL: `http://127.0.0.1:${currentPort}`, TASK_API_TOKEN: apiToken,
    ...(scope ? { TASK_MCP_URL: buildTaskMcpUrl(currentPort, apiToken, scope) } : {}) } : {}
}

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  const presented = bearerToken(req) ?? url.searchParams.get('token')
  if (!presented) return false
  const expected = Buffer.from(apiToken)
  const actual = Buffer.from(presented)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Waits for the server to finish starting; resolves to its port, or null. */
export async function waitForTaskApiServer(): Promise<number | null> {
  const currentPort = getTaskApiPort()
  if (currentPort) return currentPort
  if (active && !active.listener.isClosing) {
    try {
      return await active.startup
    } catch (err) {
      console.error('[TaskApiServer] waitForTaskApiServer - startup promise rejected:', err)
      return null
    }
  }
  console.warn('[TaskApiServer] waitForTaskApiServer - no startup promise exists (server not started?)')
  return null
}

export function startTaskApiServer(db: DatabaseManager, host: TaskApiHost = {}): Promise<number> {
  if (closedSources.has(db)) return Promise.reject(new Error('TASK_API_CLOSED'))
  if (active) return active.db === db ? active.startup : Promise.reject(new Error('TASK_API_ALREADY_STARTED'))
  if ([...owners].some(owner => owner.db === db && !owner.listener.isFullyClosed)) {
    return Promise.reject(new Error('TASK_API_SHUTTING_DOWN'))
  }
  installCaptainGithubTools(db)
  const listener: TaskApiListener = new TaskApiListener(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost`)
      const route = url.pathname

      if (!isAuthorized(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      const body = await readBody(req, 16 * 1024 * 1024)
      if (listener.isClosing) return

      // The MCP endpoint speaks JSON-RPC and sets its own headers, so it
      // must be served before anything below assumes a plain JSON route.
      if (route === TASK_MCP_PATH) {
        await handleTaskMcpRequest(req, res, url, body, (mcpRoute, params, trustedScope) => handleRoute(db, mcpRoute, params, trustedScope, host), { includeLegacyBrowserTools: !!host.legacyBrowserRoute })
        return
      }

      res.setHeader('Content-Type', 'application/json')
      const params = parseJsonBody(body)
      // Only route names and sizes are logged: bodies can carry typed
      // passwords (browser_type) and other sensitive content.
      console.log(`[TaskApiServer] → ${route} (${body.length} bytes)`)
      const resultStr = JSON.stringify(await handleRoute(db, route, params, undefined, host))
      console.log(`[TaskApiServer] ← ${route} 200 (${resultStr.length} bytes)`)
      res.writeHead(200)
      res.end(resultStr)
    } catch (err: unknown) {
      if (res.destroyed) return
      console.error(`[TaskApiServer] ERROR ${new URL(req.url || '/', 'http://localhost').pathname}:`, (err as Error).message)
      // The MCP endpoint may have written its headers already; writing them
      // twice throws and would take the whole server down.
      if (res.headersSent) {
        res.end()
        return
      }
      res.writeHead((err as { status?: number }).status || 500)
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
  })
  const owner: ServerOwner = { db, listener, startup: Promise.resolve(0) }
  active = owner
  owners.add(owner)
  owner.startup = listener.start().then(value => {
    if (active !== owner || listener.isClosing) throw new Error('TASK_API_CLOSED')
    port = value
    console.log(`[TaskApiServer] Started on port ${port}`)
    return value
  }, error => {
    if (active === owner) { active = null; port = null }
    listener.stop()
    throw error
  })
  void owner.startup.catch(() => {})
  return owner.startup
}

/** Stop admission, retaining every retired listener and its raw handlers. */
export function stopTaskApiServer(): void {
  for (const owner of owners) owner.listener.stop()
  active = null
  port = null
}

/** Database ownership may release only after this bounded join succeeds. */
export async function closeTaskApiServer(timeoutMs = 2000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
    throw new RangeError('Task API shutdown deadline must be an integer from 1 to 3000 ms')
  }
  for (const owner of owners) closedSources.add(owner.db)
  stopTaskApiServer()
  const results = await Promise.allSettled([...owners].map(async owner => {
    await owner.listener.close(timeoutMs)
    owners.delete(owner)
  }))
  const incomplete = results.find(result => result.status === 'rejected')
  if (incomplete?.status === 'rejected') throw incomplete.reason
}

const ROUTE_HANDLERS = [handleTaskGroupRoute, handleTaskRoute, handleSkillRoute, handleSessionRoute, handleUiRoute, handleArtifactRoute, handleConcurrencyRoute, handleReviewAttestationRoute, handlePrWriteRoute]

/** Exported so the routes can be tested without starting an HTTP server. */
export async function handleRoute(db: DatabaseManager, route: string, params: Record<string, unknown>, trustedScope?: TaskMcpScope, host: TaskApiHost = {}): Promise<unknown> {
  for (const handle of [...ROUTE_HANDLERS, ...(host.legacyBrowserRoute ? [host.legacyBrowserRoute] : [])]) {
    const result = await handle(db, route, params, trustedScope)
    if (result !== undefined) return result
  }
  return { error: 'Unknown route' }
}
