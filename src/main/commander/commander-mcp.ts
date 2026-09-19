/**
 * The Commander's tools, served over MCP to its agent (docs/commander.md).
 *
 * A Commander session is an ordinary agent session, so its tools reach it the
 * way the Captain's do: as an HTTP MCP server on the Task API server, with the
 * scope in the URL (`/mcp?commander=<sessionId>`, see task-mcp-endpoint.ts).
 * That scope serves the Commander's registry and nothing else: no task tools,
 * and never the full-access set.
 *
 * The tools themselves live in the main process (CommanderService), so the
 * endpoint reaches them through this seam, installed by ipc/commander.ts. With
 * no host installed the scope serves no tools.
 */
import type { Tool } from '@modelcontextprotocol/server'
import type { ChatToolInputSchema, ChatToolResult } from './tools'

export interface CommanderToolHost {
  listTools(sessionId: string): Array<{ name: string; description: string; inputSchema: ChatToolInputSchema }>
  callTool(sessionId: string, name: string, input: Record<string, unknown>, toolCallId: string, signal: AbortSignal): Promise<ChatToolResult>
}

let host: CommanderToolHost | null = null

export function setCommanderToolHost(next: CommanderToolHost | null): void {
  host = next
}

/** The MCP server name the Commander's tools appear under in its agent. */
export const COMMANDER_MCP_SERVER_NAME = 'commander'

export function listCommanderMcpTools(sessionId: string): Tool[] {
  if (!host) return []
  try {
    // The schemas are plain JSON Schema objects, which is what Tool describes.
    return host.listTools(sessionId).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }) as Tool)
  } catch (err) {
    console.error('[CommanderMcp] Listing tools failed:', err)
    return []
  }
}

/** An MCP tools/call result. Never throws. */
export async function callCommanderMcpTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown> | undefined,
  toolCallId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!host) {
    return { content: [{ type: 'text', text: 'The Commander is not available.' }], isError: true }
  }
  try {
    const result = await host.callTool(sessionId, name, args ?? {}, toolCallId, new AbortController().signal)
    return { content: [{ type: 'text', text: result.content }], ...(result.isError ? { isError: true } : {}) }
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
}
