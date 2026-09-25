import type { TaskMcpScope } from './mcp-servers/task-management-core'
/**
 * Lightweight HTTP API server for task-management tools.
 * Runs inside the Electron main process so it can use better-sqlite3.
 *
 * It serves two things:
 *   - one plain JSON route per tool (see ./task-api/*-routes.ts), and
 *   - the MCP endpoint at /mcp, which agent sessions connect to directly.
 *
 * Sessions no longer spawn a task-management-mcp.js child process. That child
 * only forwarded calls to this same server, so it was pure overhead, and one
 * copy per session stayed alive for as long as the agent CLI did.
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import type { DatabaseManager } from './database'
import { TASK_MCP_PATH, handleTaskMcpRequest } from './task-mcp-endpoint'
import { bearerToken, parseJsonBody, readBody } from './http-utils'
import { handleArtifactRoute } from './task-api/artifact-routes'
import { handleBrowserRoute } from './task-api/browser-routes'
import { handleConcurrencyRoute } from './task-api/concurrency-routes'
import { handleSessionRoute } from './task-api/session-routes'
import { handleSkillRoute } from './task-api/skill-routes'
import { handleTaskRoute } from './task-api/task-routes'
import { handleReviewAttestationRoute } from './task-api/review-attestation-routes'
import { handlePrWriteRoute } from './pr-write-gate'
import { handleUiRoute } from './task-api/ui-routes'
import { installCaptainGithubTools } from './captain-github-tools'

export { setTaskApiAgentController, setTaskApiNotifier, setTaskApiUiState, setTranscriptProvider } from './task-api/state'

let server: HttpServer | null = null
let port: number | null = null
let startupPromise: Promise<number> | null = null

export function getTaskApiPort(): number | null {
  return port
}

// Every caller must present this. The server is on loopback, but any local
// process, and any web page that DNS-rebinds a hostname to 127.0.0.1, can
// reach it, and its routes drive agents that run shell commands.
const apiToken = randomBytes(32).toString('hex')

export function getTaskApiToken(): string {
  return apiToken
}

/** Environment for a child process that calls the task API directly. */
export function getTaskApiEnv(): Record<string, string> {
  return port ? { TASK_API_URL: `http://127.0.0.1:${port}`, TASK_API_TOKEN: apiToken } : {}
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
  if (port) return port
  if (startupPromise) {
    try {
      return await startupPromise
    } catch (err) {
      console.error('[TaskApiServer] waitForTaskApiServer - startup promise rejected:', err)
      return null
    }
  }
  console.warn('[TaskApiServer] waitForTaskApiServer - no startup promise exists (server not started?)')
  return null
}

export function startTaskApiServer(db: DatabaseManager): Promise<number> {
  if (server && port) return Promise.resolve(port)
  if (startupPromise) return startupPromise

  // The Captain's merge and issue tools are answered in the main process.
  // Installed with the server because the MCP endpoint lives here; tests
  // that call the routes directly install their own.
  installCaptainGithubTools(db)

  startupPromise = new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://localhost`)
        const route = url.pathname

        if (!isAuthorized(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }

        const body = await readBody(req)

        // The MCP endpoint speaks JSON-RPC and sets its own headers, so it
        // must be served before anything below assumes a plain JSON route.
        if (route === TASK_MCP_PATH) {
          await handleTaskMcpRequest(req, res, url, body, (mcpRoute, params, trustedScope) => handleRoute(db, mcpRoute, params, trustedScope))
          return
        }

        res.setHeader('Content-Type', 'application/json')
        const params = parseJsonBody(body)
        // Only route names and sizes are logged: bodies can carry typed
        // passwords (browser_type) and other sensitive content.
        console.log(`[TaskApiServer] → ${route} (${body.length} bytes)`)
        const resultStr = JSON.stringify(await handleRoute(db, route, params))
        console.log(`[TaskApiServer] ← ${route} 200 (${resultStr.length} bytes)`)
        res.writeHead(200)
        res.end(resultStr)
      } catch (err: unknown) {
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

    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (typeof addr === 'object' && addr) {
        port = addr.port
        console.log(`[TaskApiServer] Started on port ${port}`)
        resolve(port)
      } else {
        reject(new Error('Failed to get server address'))
      }
    })

    server.on('error', (err) => {
      console.error('[TaskApiServer] Server error:', err)
      reject(err)
    })
  })

  return startupPromise
}

export function stopTaskApiServer(): void {
  if (server) {
    server.close()
    server = null
    port = null
  }
  startupPromise = null
}

const ROUTE_HANDLERS = [handleTaskRoute, handleSkillRoute, handleSessionRoute, handleUiRoute, handleArtifactRoute, handleBrowserRoute, handleConcurrencyRoute, handleReviewAttestationRoute, handlePrWriteRoute]

/** Exported so the routes can be tested without starting an HTTP server. */
export async function handleRoute(db: DatabaseManager, route: string, params: Record<string, unknown>, trustedScope?: TaskMcpScope): Promise<unknown> {
  for (const handle of ROUTE_HANDLERS) {
    const result = await handle(db, route, params, trustedScope)
    if (result !== undefined) return result
  }
  return { error: 'Unknown route' }
}
