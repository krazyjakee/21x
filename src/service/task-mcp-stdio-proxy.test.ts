import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskMcpStdioProxy } from './task-mcp-stdio-proxy'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { startTaskApiServer, closeTaskApiServer, getTaskApiToken } from '../main/task-api-server-core'
import { buildTaskMcpUrl } from '../main/task-mcp-endpoint'
import { browserTools } from '../main/mcp-servers/task-management-tools'

const api = 'http://127.0.0.1:4999'
const signed = `${api}/mcp?token=${'a'.repeat(64)}&project=project&scope_signature=${'b'.repeat(64)}`
const owners: TaskMcpStdioProxy[] = []
const databases: ReturnType<typeof createPortableTestDb>[] = []
const own = (fetcher: typeof fetch = vi.fn(), timeout = 15_000, url = signed, base = api): TaskMcpStdioProxy => {
  const proxy = new TaskMcpStdioProxy(base, url, fetcher, timeout); owners.push(proxy); return proxy
}
const response = (init: RequestInit | undefined, result: unknown): Response => Response.json({ jsonrpc: '2.0', id: JSON.parse(init!.body as string).id, result })
const errorText = (result: { content: Array<{ text: string }> }): string => result.content.map(item => item.text).join('')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.close()))
  await closeTaskApiServer()
  for (const db of databases.splice(0)) db.close()
  vi.restoreAllMocks()
})

describe('production signed task MCP stdio proxy', () => {
  it('requires one exact signed loopback endpoint and never substitutes plain environment scope', () => {
    for (const [base, endpoint] of [
      [undefined, signed], [api, undefined], [api, signed.replace('/mcp?', '/list_tasks?')],
      [api, signed.replace(':4999', ':5000')], [api, signed.replace('127.0.0.1', 'remote.invalid')],
      [api, signed + '#private'], [api, signed + '&project=foreign'], [api, signed + '&unexpected=private'],
      [api + '/list_tasks', signed], [api + '?token=private', signed],
      [api, signed.replace('scope_signature=', 'signature=')], [api, signed.replace('token=' + 'a'.repeat(64), 'token=')]
    ]) expect(() => new TaskMcpStdioProxy(base, endpoint)).toThrow('Task MCP transport unavailable')
    for (const timeout of [0, 15001, NaN]) expect(() => own(vi.fn(), timeout)).toThrow('Task MCP transport unavailable')
  })

  it('forwards list and every retained call through the signed endpoint, with no redirect or plain-route fallback', async () => {
    const http = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(signed); expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
      const frame = JSON.parse(init!.body as string)
      return response(init, frame.method === 'tools/list' ? { tools: [{ name: 'list_tasks' }, { name: 'browser_navigate' }] } : { content: [{ type: 'text', text: '{"tasks":[]}' }] })
    })
    const proxy = own(http)
    expect((await proxy.list()).tools.map(tool => tool.name)).toEqual(['list_tasks'])
    expect(await proxy.call('list_tasks', { project_id: 'spoofed', trustedScope: { projectId: 'foreign' } })).toEqual({ content: [{ type: 'text', text: '{"tasks":[]}' }] })
    expect(JSON.parse(http.mock.calls[1][1]!.body as string)).toMatchObject({ method: 'tools/call', params: { name: 'list_tasks', arguments: { project_id: 'spoofed' } } })
    for (const tool of browserTools) expect((await proxy.call(tool.name, {})).isError, tool.name).toBe(true)
    expect(http).toHaveBeenCalledTimes(2); expect(proxy.pendingCount).toBe(0)
  })

  it.each([401, 403, 307])('rejects HTTP %i and cancels the credential-bearing response without a fallback', async status => {
    const cancel = vi.fn()
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }))
    await expect(own(http).list()).rejects.toThrow('Task MCP transport unavailable')
    expect(http).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    { jsonrpc: '2.0', id: 'foreign', result: { content: [] } },
    { jsonrpc: '2.0', id: 'stdio-1', error: { message: 'private-token' } },
    { jsonrpc: '2.0', id: 'stdio-1', result: { content: [{ type: 'image', data: 'private-token' }] } },
    { jsonrpc: '2.0', id: 'stdio-1', result: { content: [], isError: 'private-token' } }
  ])('refuses malformed/wrong-associated RPC results with fixed errors', async frame => {
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(frame))
    const result = await own(http).call('list_tasks')
    expect(result.isError).toBe(true); expect(errorText(result)).toBe('Task MCP transport unavailable. Reconnect this session.')
    expect(JSON.stringify(result)).not.toContain('private-token'); expect(http).toHaveBeenCalledOnce()
  })

  it('bounds request and response bytes before forwarding or materializing unbounded data', async () => {
    const cancel = vi.fn()
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)) }, cancel }), { headers: { 'Content-Type': 'application/json' } }))
    const proxy = own(http)
    expect((await proxy.call('list_tasks', { oversized: 'x'.repeat(16 * 1024 * 1024) })).isError).toBe(true)
    expect(http).not.toHaveBeenCalled()
    expect((await proxy.call('list_tasks')).isError).toBe(true)
    expect(cancel).toHaveBeenCalledOnce(); expect(proxy.pendingCount).toBe(0)
  })

  it('cancels public calls promptly while owning an abort-ignoring fetch and late cleanup through close/retry', async () => {
    const late = deferred<Response>(), cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise)
    const http = vi.fn<typeof fetch>(() => late.promise), proxy = own(http), controller = new AbortController()
    const calling = proxy.call('list_tasks', {}, controller.signal)
    await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
    controller.abort(); expect((await calling).isError).toBe(true)
    await expect(proxy.close(5)).rejects.toThrow('Task MCP transport unavailable')
    late.resolve(new Response(new ReadableStream({ cancel })))
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    await expect(proxy.close(5)).rejects.toThrow('Task MCP transport unavailable')
    expect(proxy.pendingCount).toBe(1)
    cleanup.resolve(); await proxy.close(); expect(proxy.pendingCount).toBe(0)
    await expect(proxy.list()).rejects.toThrow('Task MCP transport unavailable'); expect(http).toHaveBeenCalledOnce()
  })

  it('owns reader cancellation after deadline and does not admit work beyond four raw requests', async () => {
    const cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise)
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }))
    const proxy = own(http, 10)
    expect((await proxy.call('list_tasks')).isError).toBe(true)
    expect(cancel).toHaveBeenCalledOnce(); await expect(proxy.close(5)).rejects.toThrow('Task MCP transport unavailable')
    cleanup.resolve(); await proxy.close()
    const late = Array.from({ length: 4 }, () => deferred<Response>())
    let index = 0
    const admitted = own(vi.fn<typeof fetch>(() => late[index++].promise))
    const calls = late.map(() => admitted.call('list_tasks'))
    expect((await admitted.call('list_tasks')).isError).toBe(true)
    admitted.shutdown(); expect((await Promise.all(calls)).every(result => result.isError)).toBe(true)
    for (const pending of late) pending.resolve(new Response())
    await admitted.close(); expect(admitted.pendingCount).toBe(0)
  })

  it('enforces launch tokens, signed project/artifact/subtask scope and retired tool exclusion against the actual task API', async () => {
    const db = createPortableTestDb(); databases.push(db)
    const a = db.createProject({ name: 'Scope A' })!, b = db.createProject({ name: 'Scope B' })!
    const mine = db.createTask({ title: 'Own task', project_id: a.id })!, foreign = db.createTask({ title: 'Foreign task', project_id: b.id })!
    const port = await startTaskApiServer(db), base = `http://127.0.0.1:${port}`
    const url = buildTaskMcpUrl(port, getTaskApiToken(), { projectId: a.id, taskId: mine.id, artifactTaskId: mine.id })
    const proxy = own(fetch, 15000, url, base)
    const listed = await proxy.list()
    expect(listed.tools.some(tool => tool.name === 'list_tasks')).toBe(true)
    expect(listed.tools.some(tool => browserTools.some(browser => browser.name === tool.name))).toBe(false)
    const tasks = await proxy.call('list_tasks', { project_id: b.id })
    expect(errorText(tasks)).toContain('Own task'); expect(errorText(tasks)).not.toContain('Foreign task')
    expect(errorText(await proxy.call('get_task', { task_id: foreign.id }))).toContain('not in this project')
    for (const changed of [url.replace(getTaskApiToken(), 'c'.repeat(64)), url.replace(a.id, b.id), url.replace(mine.id, foreign.id), url.replace('scope_signature=', 'scope_signature=c')]) {
      // Malformed signatures can be refused before fetch; valid-shape forgeries
      // must be rejected by the actual launch/signature owner.
      try { await expect(own(fetch, 15000, changed, base).list()).rejects.toThrow('Task MCP transport unavailable') }
      catch (error) { if (error instanceof Error && error.message === 'Task MCP transport unavailable. Reconnect this session.') continue; throw error }
    }
    const parent = db.createTask({ title: 'Parent', project_id: a.id })!, sibling = db.createTask({ title: 'Sibling', parent_task_id: parent.id, project_id: a.id })!
    const subtask = own(fetch, 15000, buildTaskMcpUrl(port, getTaskApiToken(), { projectId: a.id, taskId: sibling.id, parentTaskId: parent.id, artifactTaskId: sibling.id }), base)
    const tools = await subtask.list()
    expect(tools.tools.some(tool => tool.name === 'update_own_task')).toBe(true)
    expect(tools.tools.some(tool => tool.name === 'update_task')).toBe(false)
    expect((await subtask.call('update_task', { task_id: foreign.id, title: 'Must not change' })).isError).toBe(true)
    expect(db.getTask(foreign.id)?.title).toBe('Foreign task')
  })
})
