import type { TaskMcpScope, ToolCallResult } from './task-management-core'
import { TASK_GROUP_TOOL_NAMES } from './task-management-tools'

export interface SignedTaskMcpForwarding { url: string; scope: TaskMcpScope }
/** The server verifies the HMAC. This side only pins forwarding to the exact
 * app-issued loopback URL and refuses a caller-supplied body scope. */
export function signedTaskMcpForwarding(value: string | undefined, apiUrl: string): SignedTaskMcpForwarding | null {
  if (!value) return null
  const url = new URL(value)
  const api = new URL(apiUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== api.origin || url.pathname !== '/mcp'
    || url.username || url.password || url.hash || !url.searchParams.get('token') || !/^[0-9a-f]{64}$/.test(url.searchParams.get('scope_signature') ?? '')) {
    throw new Error('An app-issued signed loopback MCP URL is required')
  }
  const taskId = url.searchParams.get('task') || null
  return { url: url.toString(), scope: { projectId: url.searchParams.get('project') || null, parentTaskId: url.searchParams.get('parent') || null,
    taskId, artifactTaskId: url.searchParams.get('artifact') || taskId, agentId: url.searchParams.get('agent') || null, sessionNonce: url.searchParams.get('session') || null } }
}

export async function forwardTaskGroupTool(forwarding: SignedTaskMcpForwarding | null, name: string, args: Record<string, unknown> | undefined,
  fetcher: typeof fetch = fetch): Promise<ToolCallResult> {
  const refused = (): ToolCallResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: 'Task groups require the app-issued signed MCP transport. Reconnect this session.' }) }], isError: true })
  if (!forwarding || !TASK_GROUP_TOOL_NAMES.has(name)) return refused()
  try {
    const response = await fetcher(forwarding.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      signal: AbortSignal.timeout(15000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args ?? {} } }) })
    if (!response.ok) return refused()
    const frame = await response.json() as { result?: ToolCallResult }
    const result = frame.result
    if (!result || !Array.isArray(result.content) || result.content.some(item => item.type !== 'text' || typeof item.text !== 'string')) return refused()
    return result
  } catch { return refused() }
}
