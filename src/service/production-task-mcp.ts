import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { TaskMcpStdioProxy } from './task-mcp-stdio-proxy'

/** Only production staging selects this entry. The shipping legacy entry
 * remains separate; production never falls back to unsigned JSON routes. */
async function main(): Promise<void> {
  const proxy = new TaskMcpStdioProxy(process.env.TASK_API_URL, process.env.TASK_MCP_URL)
  const server = new Server({ name: 'task-management', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', (_request, context) => proxy.list(context.mcpReq.signal))
  server.setRequestHandler('tools/call', (request, context) => {
    const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> }
    return proxy.call(name, args, context.mcpReq.signal)
  })
  let closing: Promise<void> | undefined
  const close = (): void => {
    proxy.shutdown()
    closing ??= Promise.resolve().then(async () => { await Promise.all([proxy.close(), server.close()]) }).catch(() => {
      console.error('Task MCP shutdown incomplete.'); process.exitCode = 1
    })
  }
  server.onclose = close
  server.onerror = () => { console.error('Task MCP protocol error.') }
  process.stdin.once('end', close)
  process.stdin.once('close', close)
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 16 * 1024 * 1024 }))
}

void main().catch(() => { console.error('Task MCP startup failed.'); process.exitCode = 1 })
