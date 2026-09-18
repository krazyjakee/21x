/**
 * Attaching MCP servers to a running OpenCode server (mcp.add + mcp.connect),
 * waiting for readiness, and detaching them again.
 */

import { setTimeout as sleep } from 'timers/promises'
import type { McpServerConfig } from './coding-agent-adapter'

type OpencodeClient = import('@opencode-ai/sdk').OpencodeClient
type McpStatusMap = Record<string, { status?: string; error?: string }>

/** Outcome of attaching MCP servers to an OpenCode session. */
export type McpAttachResult = { attached: string[]; failed: string[] }

/**
 * The MCP config OpenCode already holds for one directory, as
 * `name -> serialized config`. Lets an unchanged server skip a re-add.
 */
export type DirectoryMcpConfigs = Map<string, string>

function directoryQuery(workspaceDir?: string): { query?: { directory: string } } {
  return workspaceDir ? { query: { directory: workspaceDir } } : {}
}

function parseMcpListData(data: unknown): McpStatusMap | undefined {
  if (!data) return undefined

  const out: McpStatusMap = {}
  if (Array.isArray(data)) {
    for (const item of data) {
      const rec = item as {
        name?: string
        id?: string
        status?: string
        state?: string
        error?: string
        auth?: { status?: string; error?: string }
      }
      const name = rec.name || rec.id
      if (!name) continue
      out[name] = {
        status: rec.status || rec.state || rec.auth?.status,
        error: rec.error || rec.auth?.error
      }
    }
  } else if (typeof data === 'object') {
    for (const [name, value] of Object.entries(data as Record<string, { status?: string; state?: string; error?: string }>)) {
      out[name] = {
        status: value?.status || value?.state,
        error: value?.error
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Prefers mcp.list() (same view as `opencode mcp list`), falling back to mcp.status(). */
async function getMcpStatusMap(ocClient: OpencodeClient, workspaceDir?: string): Promise<McpStatusMap | undefined> {
  const query = directoryQuery(workspaceDir)
  const mcpClient = ocClient.mcp as unknown as {
    list?: (args?: unknown) => Promise<{ data?: unknown; error?: unknown }>
    status: (args?: unknown) => Promise<{ data?: unknown; error?: unknown }>
  }

  if (typeof mcpClient.list === 'function') {
    try {
      const listResult = await mcpClient.list(query)
      if (!listResult.error) {
        const parsed = parseMcpListData(listResult.data)
        if (parsed) return parsed
      }
    } catch (err) {
      console.warn('[OpencodeAdapter] mcp.list failed, falling back to mcp.status:', err)
    }
  }

  const statusResult = await mcpClient.status(query)
  return statusResult.data as McpStatusMap | undefined
}

/**
 * Waits for MCP servers to reach a terminal state, with one batched status
 * query per attempt instead of polling each server.
 */
export async function waitForMcpServersReady(
  ocClient: OpencodeClient,
  serverNames: string[],
  workspaceDir?: string,
  maxAttempts = 5,
  delayMs = 300
): Promise<Map<string, 'connected' | 'failed' | 'timeout'>> {
  const pending = new Set(serverNames)
  const states = new Map<string, 'connected' | 'failed' | 'timeout'>()

  for (let attempt = 0; attempt < maxAttempts && pending.size > 0; attempt++) {
    try {
      const statusMap = await getMcpStatusMap(ocClient, workspaceDir)
      for (const name of [...pending]) {
        const serverStatus = statusMap?.[name]
        if (serverStatus?.status === 'connected') {
          states.set(name, 'connected')
          pending.delete(name)
          console.log(`[OpencodeAdapter] MCP server '${name}' status: connected (attempt ${attempt + 1})`)
        } else if (serverStatus?.status === 'failed') {
          states.set(name, 'failed')
          pending.delete(name)
          console.error(`[OpencodeAdapter] MCP server '${name}' status: failed${serverStatus.error ? ` - ${serverStatus.error}` : ''}`)
        }
      }
    } catch (statusErr) {
      console.warn('[OpencodeAdapter] Failed to query MCP status:', statusErr)
    }

    if (pending.size > 0 && attempt < maxAttempts - 1 && delayMs > 0) {
      await sleep(delayMs)
    }
  }

  for (const name of pending) {
    states.set(name, 'timeout')
  }
  return states
}

/**
 * Registers MCP servers with the OpenCode backend. Used on create and on
 * resume (after a 20x restart the stdio MCP server processes are dead).
 */
async function registerMcpServers(
  ocClient: OpencodeClient,
  mcpServers: Record<string, McpServerConfig>,
  workspaceDir: string | undefined,
  known: DirectoryMcpConfigs
): Promise<McpAttachResult> {
  const connectCandidates: string[] = []
  const attached: string[] = []
  const failed: string[] = []

  // What OpenCode already has for this directory, so an unchanged server is not
  // rebuilt. mcp.add is destructive: it discards the current client and its
  // cached tool list before it builds the replacement, and if the new one fails
  // to connect the server is left with no tools at all. The registry is shared
  // by every session in the directory, so that would strip the tools from a
  // session that is in the middle of a conversation.
  const statusMap = Object.keys(mcpServers).length > 0
    ? await getMcpStatusMap(ocClient, workspaceDir).catch(() => undefined)
    : undefined

  for (const [name, mcpConfig] of Object.entries(mcpServers)) {
    try {
      const mcpAddConfig = mcpConfig.type === 'http'
        ? { type: 'remote' as const, url: mcpConfig.url ?? '', headers: mcpConfig.headers }
        : { type: 'local' as const, command: [mcpConfig.command ?? '', ...(mcpConfig.args ?? [])], environment: mcpConfig.env }
      const serialized = JSON.stringify(mcpAddConfig)

      if (statusMap?.[name]?.status === 'connected' && known.get(name) === serialized) {
        console.log(`[OpencodeAdapter] MCP server '${name}' is already connected with the same config — not re-adding`)
        attached.push(name)
        continue
      }

      // Only the transport type: the config carries auth headers, env secrets and the task API token.
      console.log(`[OpencodeAdapter] Registering MCP server: ${name} (${mcpAddConfig.type})`)
      known.set(name, serialized)

      const addResult = await ocClient.mcp.add({
        body: { name, config: mcpAddConfig },
        ...directoryQuery(workspaceDir)
      })
      if (addResult.error) {
        console.error(`[OpencodeAdapter] mcp.add error for ${name}:`, addResult.error)
        failed.push(name)
        continue
      }

      // mcp.add may already report the final state.
      const addStatus = addResult.data?.[name] as { status: string; error?: string } | undefined
      if (addStatus) {
        console.log(`[OpencodeAdapter] mcp.add status for '${name}': ${addStatus.status}${addStatus.error ? ` - ${addStatus.error}` : ''}`)
        if (addStatus.status === 'failed') {
          failed.push(name)
          continue
        }
        if (addStatus.status === 'connected') {
          attached.push(name)
          continue
        }
      }

      const connectResult = await ocClient.mcp.connect({
        path: { name },
        ...directoryQuery(workspaceDir)
      })
      if (connectResult.error) {
        console.error(`[OpencodeAdapter] mcp.connect error for ${name}:`, connectResult.error)
        failed.push(name)
        continue
      }
      if (connectResult.data === false) {
        console.error(`[OpencodeAdapter] mcp.connect returned false for ${name} — server failed to connect`)
        failed.push(name)
        continue
      }
      connectCandidates.push(name)
    } catch (mcpError) {
      console.error(`[OpencodeAdapter] Failed to register MCP server ${name}:`, mcpError)
      failed.push(name)
    }
  }

  if (connectCandidates.length > 0) {
    const readiness = await waitForMcpServersReady(ocClient, connectCandidates, workspaceDir)
    for (const name of connectCandidates) {
      if (readiness.get(name) === 'connected') {
        attached.push(name)
      } else {
        console.error(`[OpencodeAdapter] MCP server '${name}' did not reach connected status (${readiness.get(name)}) — tools may not work`)
        failed.push(name)
      }
    }
  }

  return { attached, failed }
}

/**
 * Attaches a session's MCP servers, retrying failures once, and reports what
 * is still missing.
 *
 * OpenCode keeps MCP servers only in the memory of the `opencode serve`
 * process, so an attach failure is invisible in the session itself: the agent
 * simply has no task-management tools while AGENTS.md advertises them. The
 * caller must act on `failed` instead of continuing silently.
 */
export async function attachAndVerifyMcpServers(
  ocClient: OpencodeClient,
  mcpServers: Record<string, McpServerConfig>,
  workspaceDir: string | undefined,
  context: string,
  known: DirectoryMcpConfigs
): Promise<McpAttachResult> {
  const first = await registerMcpServers(ocClient, mcpServers, workspaceDir, known)
  if (first.failed.length === 0) return first

  console.warn(
    `[OpencodeAdapter] ${context}: MCP servers not attached on first try (${first.failed.join(', ')}) — retrying once`
  )
  const retryTargets = Object.fromEntries(
    first.failed.filter((name) => mcpServers[name]).map((name) => [name, mcpServers[name]])
  )
  const second = await registerMcpServers(ocClient, retryTargets, workspaceDir, known)
  const result: McpAttachResult = {
    attached: [...first.attached, ...second.attached],
    failed: second.failed
  }

  if (result.failed.length > 0) {
    // Loud, single-line marker: the agent runs without these servers' tools.
    console.error(
      `[OpencodeAdapter] MCP ATTACH FAILED — ${context}: ${result.failed.join(', ')} not attached. ` +
      `Agent tools from these servers are NOT available in this session.`
    )
  }
  return result
}

/** Disconnects the named MCP servers; failures are logged, never thrown. */
export async function disconnectMcpServers(
  ocClient: OpencodeClient,
  names: string[],
  workspaceDir: string | undefined,
  sessionId: string,
  known: DirectoryMcpConfigs
): Promise<void> {
  const mcpClient = ocClient.mcp as unknown as {
    disconnect?: (args: unknown) => Promise<{ error?: unknown }>
  }
  if (typeof mcpClient.disconnect !== 'function') return

  for (const name of names) {
    try {
      const result = await mcpClient.disconnect({ path: { name }, ...directoryQuery(workspaceDir) })
      if (result?.error) {
        console.warn(`[OpencodeAdapter] mcp.disconnect error for ${name}:`, result.error)
      } else {
        // OpenCode no longer holds it, so neither may our record of it.
        known.delete(name)
        console.log(`[OpencodeAdapter] Disconnected MCP server '${name}' for session ${sessionId}`)
      }
    } catch (err) {
      console.warn(`[OpencodeAdapter] mcp.disconnect failed for ${name}:`, err instanceof Error ? err.message : err)
    }
  }
}
