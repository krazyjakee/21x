import { describe, it, expect, vi } from 'vitest'
import { buildMcpServers } from './session-config-core'
import type { SessionConfigHost } from './host'
import type { DatabaseManager } from '../database'

const managed = { id: 'managed', name: 'task-management', type: 'local', command: '/node', args: ['/mcp.js'], environment: {}, headers: {}, tools: [] }
const user = { id: 'user', name: 'github', type: 'local', command: '/gh-mcp', args: [], environment: {}, headers: {}, tools: [] }

function dbWith(serverIds: string[]): DatabaseManager {
  const servers: Record<string, unknown> = { managed, user }
  return {
    getAgent: () => ({ id: 'agent', config: { mcp_servers: serverIds } }),
    getMcpServer: (id: string) => servers[id]
  } as unknown as DatabaseManager
}

function host(managedTaskMcp: SessionConfigHost['managedTaskMcp']): SessionConfigHost {
  return { secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp }
}

const server = (): SessionConfigHost['managedTaskMcp'] => ({
  kind: 'server', waitUntilReady: vi.fn(async () => 4000),
  buildConfig: vi.fn(() => ({ type: 'http' as const, url: 'http://127.0.0.1:4000/mcp?token=t' }))
})

describe('buildMcpServers on a host without user-configured MCP', () => {
  it('starts a seeded agent whose only server is the app-managed task-management server', async () => {
    const result = await buildMcpServers(dbWith(['managed']), null, 'agent', { taskId: 't' }, host(server()))
    expect(Object.keys(result)).toEqual(['task-management'])
  })

  it('ignores a deleted server reference instead of refusing the session', async () => {
    const result = await buildMcpServers(dbWith(['managed', 'gone']), null, 'agent', { taskId: 't' }, host(server()))
    expect(Object.keys(result)).toEqual(['task-management'])
  })

  it('still refuses a user-configured server', async () => {
    await expect(buildMcpServers(dbWith(['managed', 'user']), null, 'agent', { taskId: 't' }, host(server())))
      .rejects.toThrow('Configured MCP servers are unavailable in this host')
  })

  it('refuses the task-management row when the host does not own the task API', async () => {
    await expect(buildMcpServers(dbWith(['managed']), null, 'agent', { taskId: 't' }, host({ kind: 'disabled' })))
      .rejects.toThrow('Configured MCP servers are unavailable in this host')
  })
})
