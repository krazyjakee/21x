import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { request } from 'node:http'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import {
  closeTaskApiServer, getTaskApiEnv, getTaskApiPort, getTaskApiToken,
  setTaskApiAgentController, startTaskApiServer, stopTaskApiServer
} from './task-api-server-core'
import { buildTaskMcpUrl } from './task-mcp-endpoint'
import { TaskApiListener } from './task-api/listener'
import { browserTools } from './mcp-servers/task-management-tools'

describe('portable task API lifetime and tool availability', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  beforeEach(() => { source = createPortableDbFixture() })
  afterEach(async () => {
    await closeTaskApiServer()
    setTaskApiAgentController(null)
    source.rawDb.close()
  })

  it('joins stop during startup without publishing a stale port or reviving its source', async () => {
    const startup = expect(startTaskApiServer(source.db)).rejects.toThrow('TASK_API_CLOSED')
    stopTaskApiServer()
    await closeTaskApiServer()
    await startup
    expect(getTaskApiPort()).toBeNull()
    expect(getTaskApiEnv()).toEqual({})
    await expect(startTaskApiServer(source.db)).rejects.toThrow('TASK_API_CLOSED')
    expect(source.rawDb.open).toBe(true)
  })

  it('retains raw route work after client disconnect and failed close until its final SQLite write', async () => {
    const task = source.db.createTask(makeTask({ title: 'Original fixture' }))!
    let finish!: () => void
    const held = new Promise<void>(done => { finish = done })
    let entered!: () => void
    const started = new Promise<void>(done => { entered = done })
    const send = vi.fn(async () => {
      entered()
      await held
      source.db.updateTask(task.id, { title: 'Joined fixture write' })
      return { sessionId: 'fixture-session' }
    })
    setTaskApiAgentController({ findSessionByTaskId: () => ({ sessionId: 'fixture-session' }), sendByTaskId: send } as unknown as NonNullable<Parameters<typeof setTaskApiAgentController>[0]>)
    const port = await startTaskApiServer(source.db)
    const abort = new AbortController()
    const response = fetch(`http://127.0.0.1:${port}/send_message`, {
      method: 'POST', signal: abort.signal,
      headers: { Authorization: `Bearer ${getTaskApiToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: task.id, text: 'fixture prompt' })
    }).catch(() => null)
    try {
      await started
      abort.abort()
      await response
      await expect(closeTaskApiServer(5)).rejects.toThrow('TASK_API_SHUTDOWN_INCOMPLETE')
      expect(source.rawDb.open).toBe(true)
      expect(source.db.getTask(task.id)?.title).toBe('Original fixture')
      await expect(startTaskApiServer(source.db)).rejects.toThrow('TASK_API_CLOSED')
      let closed = false
      const retry = closeTaskApiServer().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      finish()
      await retry
      expect(source.db.getTask(task.id)?.title).toBe('Joined fixture write')
      expect(send).toHaveBeenCalledOnce()
      expect(getTaskApiPort()).toBeNull()
    } finally { finish(); abort.abort(); await response; await closeTaskApiServer() }
  })

  it('serves real MCP task tools while excluding and refusing every legacy browser tool', async () => {
    const task = source.db.createTask(makeTask({ title: 'Portable MCP fixture' }))!
    const port = await startTaskApiServer(source.db)
    const client = new Client({ name: 'portable-api-fixture', version: '1.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(buildTaskMcpUrl(port, getTaskApiToken()))))
      const { tools } = await client.listTools()
      for (const tool of browserTools) expect(tools.some(visible => visible.name === tool.name)).toBe(false)
      const listed = await client.callTool({ name: 'list_tasks', arguments: {} })
      expect(JSON.stringify(listed)).toContain(task.id)
      for (const tool of browserTools) {
        const refused = await client.callTool({ name: tool.name, arguments: { task_id: task.id, url: 'https://fixture.invalid' } })
        expect(refused.isError).toBe(true)
        expect(JSON.stringify(refused)).toContain(`Unknown tool: ${tool.name}`)
      }
    } finally { await client.close() }
  })

  it('validates a close deadline before affecting admission or an active server', async () => {
    const port = await startTaskApiServer(source.db)
    await expect(closeTaskApiServer(0)).rejects.toBeInstanceOf(RangeError)
    expect(await startTaskApiServer(source.db)).toBe(port)
    const response = await fetch(`http://127.0.0.1:${port}/list_tasks?token=${getTaskApiToken()}`)
    expect(response.status).toBe(200)
  })

  it('closes an unused listener without leaving a pending startup or socket', async () => {
    const handler = vi.fn(async () => {})
    const listener = new TaskApiListener(handler)
    await listener.close()
    expect(listener.isFullyClosed).toBe(true)
    await expect(listener.start()).rejects.toThrow('TASK_API_CLOSED')
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects an oversized authenticated body before any task mutation', async () => {
    const before = source.rawDb.prepare('SELECT COUNT(*) AS n FROM tasks').get()
    const port = await startTaskApiServer(source.db)
    const response = await fetch(`http://127.0.0.1:${port}/create_task`, {
      method: 'POST', headers: { Authorization: `Bearer ${getTaskApiToken()}` },
      body: 'x'.repeat(16 * 1024 * 1024 + 1)
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Request body too large' })
    expect(source.rawDb.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual(before)
  })

  it('closes an unauthorized unfinished upload without a body reader or request error escaping', async () => {
    const port = await startTaskApiServer(source.db)
    let finish!: (status: number | undefined) => void
    const received = new Promise<number | undefined>(done => { finish = done })
    const upload = request(`http://127.0.0.1:${port}/create_task`, {
      method: 'POST', headers: { 'Content-Length': '1000000' }
    }, response => { response.resume(); finish(response.statusCode) })
    upload.on('error', () => {})
    try {
      upload.write('unfinished fixture body')
      expect(await received).toBe(401)
      await closeTaskApiServer()
      expect(source.rawDb.open).toBe(true)
    } finally { upload.destroy() }
  })
})
