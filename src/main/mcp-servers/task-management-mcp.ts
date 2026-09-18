/**
 * Stdio entry point for the task-management MCP server.
 *
 * 20x no longer spawns this for agent sessions. Sessions use the in-process HTTP
 * endpoint instead (see task-mcp-endpoint.ts), which serves every session from
 * the process that already runs, so no child process starts and none can leak.
 *
 * This file stays for a direct run outside the app, for example
 * `TASK_API_URL=... TASK_API_TOKEN=... node task-management-mcp.js`. All tool definitions and all
 * scope rules live in task-management-core.ts and task-management-tools.ts, so
 * both paths behave the same.
 */
import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import {
  callToolForScope,
  isScopedSession,
  listToolsForScope,
  type TaskMcpScope
} from './task-management-core'

const apiUrl = process.env.TASK_API_URL
if (!apiUrl) {
  throw new Error('TASK_API_URL environment variable is required')
}

// Scope: TASK_SCOPE_PARENT_ID + TASK_SCOPE_TASK_ID make this a subtask agent's
// server (parent + siblings only); TASK_SCOPE_PROJECT_ID limits it to one
// project. With neither it has full access, which is for debugging only.
const scope: TaskMcpScope = {
  parentTaskId: process.env.TASK_SCOPE_PARENT_ID || null,
  taskId: process.env.TASK_SCOPE_TASK_ID || null,
  // Every real task session receives this even when it needs unscoped task
  // orchestration tools. Artifact file operations are always pinned to the
  // current task so an agent cannot mutate another task's workpieces.
  artifactTaskId: process.env.TASK_ARTIFACT_SCOPE_ID || process.env.TASK_SCOPE_TASK_ID || null,
  projectId: process.env.TASK_SCOPE_PROJECT_ID || null
}

async function callApi(route: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = `${apiUrl}${route}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TASK_API_TOKEN ?? ''}` },
      body: JSON.stringify(params)
    })
    return res.json()
  } catch (err) {
    const cause = (err as Error).cause
    const causeMsg = cause instanceof Error ? cause.message : (cause ? String(cause) : '')
    const scopeText = isScopedSession(scope)
      ? `task=${scope.taskId} parent=${scope.parentTaskId}`
      : scope.projectId ? `project=${scope.projectId}` : 'full'
    return { error: `fetch failed: ${(err as Error).message}${causeMsg ? ` (cause: ${causeMsg})` : ''} | url=${url} | scope=${scopeText}` }
  }
}

const server = new Server(
  { name: 'task-management', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler('tools/list', async () => ({
  tools: listToolsForScope(scope)
}))

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> }
  return callToolForScope(name, args, scope, callApi)
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const scopeText = isScopedSession(scope)
    ? ` (scoped: task=${scope.taskId}, parent=${scope.parentTaskId})`
    : scope.projectId ? ` (project: ${scope.projectId})` : ' (full access)'
  console.error(`Task Management MCP server started${scopeText}`)
}

main().catch(console.error)
