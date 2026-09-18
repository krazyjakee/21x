import { spawn } from 'child_process'
import { getTaskApiEnv } from '../task-api-server'
import { guardChildStreams, writeToChildStdin } from '../child-stream-guards'
import {
  MCP_INITIALIZE_ID,
  MCP_TOOLS_LIST_ID,
  mcpErrorMessage,
  mcpInitializeRequest,
  mcpInitializedNotification,
  mcpToolsListRequest,
  summarizeMcpTools,
  type McpRpcResponse,
  type McpToolSummary
} from '../mcp-client-messages'

export interface McpServerProbeInput {
  name: string
  type?: string
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  environment?: Record<string, string>
}

export interface McpServerProbeResult {
  status: 'connected' | 'failed'
  error?: string
  errorDetail?: string
  toolCount?: number
  tools?: McpToolSummary[]
}

/**
 * Tests an MCP server by speaking the MCP protocol directly
 * (JSON-RPC over stdio for local, HTTP POST for remote). The handshake
 * messages live in mcp-client-messages.ts; see there for why the SDK client
 * is not used.
 */
export function testMcpServer(serverData: McpServerProbeInput): Promise<McpServerProbeResult> {
  return serverData.type === 'remote' ? testRemoteMcpServer(serverData) : testLocalMcpServer(serverData)
}

function testLocalMcpServer(serverData: McpServerProbeInput): Promise<McpServerProbeResult> {
  if (!serverData.command) {
    return Promise.resolve({ status: 'failed', error: 'No command specified' })
  }

  return new Promise((resolve) => {
    let resolved = false
    const finish = (result: McpServerProbeResult): void => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      try { proc.kill('SIGTERM') } catch {}
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({ status: 'failed', error: 'Connection timeout (30s)' })
    }, 30000)

    const extraEnv: Record<string, string> = {}
    if (serverData.name === 'task-management') Object.assign(extraEnv, getTaskApiEnv())

    // Spawn directly with args array (no shell quoting) to avoid Windows single-quote issues.
    // Only use shell mode for commands that need it (npx, .cmd/.bat wrappers).
    const needsShell = /^(npx|uvx|bunx)\b/.test(serverData.command!) || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(serverData.command!))
    const proc = spawn(serverData.command!, serverData.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(needsShell ? { shell: true } : {}),
      env: { ...process.env, npm_config_yes: 'true', ...(serverData.environment || {}), ...extraEnv }
    })

    // Every pipe needs an error listener before the first write. A server that
    // exits mid-probe must not crash the main process with EPIPE.
    guardChildStreams(proc, 'mcp-probe')

    let buffer = ''
    let stderrBuf = ''
    let phase: 'init' | 'tools' = 'init'

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
    })

    const send = (message: Record<string, unknown>): void => {
      writeToChildStdin(proc, JSON.stringify(message) + '\n', 'mcp-probe')
    }

    const handleMessage = (msg: McpRpcResponse): void => {
      if (msg.error) {
        finish({ status: 'failed', error: mcpErrorMessage(msg.error, 'MCP server returned an error') })
        return
      }

      if (phase === 'init' && msg.id === MCP_INITIALIZE_ID && msg.result) {
        phase = 'tools'
        send(mcpInitializedNotification())
        send(mcpToolsListRequest())
      } else if (phase === 'tools' && msg.id === MCP_TOOLS_LIST_ID && msg.result) {
        const tools = summarizeMcpTools(msg.result)
        finish({ status: 'connected', toolCount: tools.length, tools })
      }
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        try { handleMessage(JSON.parse(line)) } catch {}
      }
      // Try parsing buffer as complete JSON (server may not send trailing newline)
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim())
          buffer = ''
          handleMessage(msg)
        } catch {}
      }
    })

    proc.on('error', (err) => {
      finish({ status: 'failed', error: err.message })
    })

    proc.on('exit', (code) => {
      const lines = stderrBuf.trim().split('\n')
      // Find a line matching an error pattern (e.g. "TypeError: ...", "Error [ERR_...]: ...")
      const errorLine = lines.find((l) => /\bError\b/.test(l) && !/^\s+at /.test(l) && !/^Node\.js v/.test(l))
      const errMsg = errorLine?.trim() || `Process exited with code ${code}`
      const detail = stderrBuf.trim().replace(/\nNode\.js v.+$/, '').trim()
      finish({ status: 'failed', error: errMsg, errorDetail: detail || undefined })
    })

    send(mcpInitializeRequest())
  })
}

async function testRemoteMcpServer(serverData: McpServerProbeInput): Promise<McpServerProbeResult> {
  if (!serverData.url) {
    return { status: 'failed', error: 'No URL specified' }
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...serverData.headers }

    // Try streamable HTTP — POST initialize directly
    const initRes = await fetch(serverData.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(mcpInitializeRequest()),
      signal: AbortSignal.timeout(10000)
    })

    if (!initRes.ok) {
      return { status: 'failed', error: `HTTP ${initRes.status}: ${initRes.statusText}` }
    }

    const contentType = initRes.headers.get('content-type') || ''

    if (contentType.includes('application/json')) {
      const initData = await initRes.json() as McpRpcResponse
      if (initData.error) {
        return { status: 'failed', error: mcpErrorMessage(initData.error, 'Initialize failed') }
      }

      fetch(serverData.url, {
        method: 'POST', headers,
        body: JSON.stringify(mcpInitializedNotification())
      }).catch(() => {})

      const toolsRes = await fetch(serverData.url, {
        method: 'POST', headers,
        body: JSON.stringify(mcpToolsListRequest()),
        signal: AbortSignal.timeout(10000)
      })
      const toolsData = await toolsRes.json() as McpRpcResponse
      const tools = summarizeMcpTools(toolsData.result)
      return { status: 'connected', toolCount: tools.length, tools }
    }

    // Non-JSON response (SSE or other) — server is reachable but uses SSE transport
    return { status: 'connected' }
  } catch (error: unknown) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'Connection failed' }
  }
}
