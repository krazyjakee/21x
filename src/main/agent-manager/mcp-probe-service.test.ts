import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import { McpProbeService, type McpProbeHost } from './mcp-probe-service'

const owners: McpProbeService[] = []
function own(overrides: Partial<McpProbeHost> = {}, timeout = 30_000): McpProbeService {
  const owner = new McpProbeService({
    spawn: (command, args, options) => spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
    fetch: vi.fn(), environment: () => ({ ...process.env }), taskApiEnvironment: () => ({}), platform: process.platform,
    ...overrides
  }, timeout)
  owners.push(owner)
  return owner
}
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); vi.restoreAllMocks() })
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true), pid: 123456
  }) as unknown as ChildProcessWithoutNullStreams
}
const json = (id: number, result: unknown): Response => Response.json({ jsonrpc: '2.0', id, result })
const remote = { name: 'fixture', type: 'remote', url: 'http://127.0.0.1:1/fixture', headers: { Authorization: 'Bearer fixture-private' } }

describe('portable MCP probe ownership', () => {
  it('runs an actual owning Node fixture and waits for native close after discovering tools', async () => {
    let pid = 0
    const owner = own({ spawn: (command, args, options) => {
      const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
      pid = child.pid!
      return child
    } })
    const script = `let data=''; process.stdin.on('data',chunk=>{data+=chunk;let i;while((i=data.indexOf('\\n'))>=0){const msg=JSON.parse(data.slice(0,i));data=data.slice(i+1);if(msg.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:msg.method==='tools/list'?{tools:[{name:'fixture_tool',description:'fixture only'}]}:{protocolVersion:'2024-11-05'}})+'\\n')}});`
    expect(await owner.probe({ name: 'fixture', command: process.execPath, args: ['-e', script] })).toEqual({ status: 'connected', toolCount: 1, tools: [{ name: 'fixture_tool', description: 'fixture only' }] })
    expect(pid).toBeGreaterThan(0)
    await owner.close()
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

  it('keeps a successful stdio handshake pending until actual child close', async () => {
    const child = fakeChild(), spawn = vi.fn(() => child), owner = own({ spawn })
    const result = owner.probe({ name: 'fixture', command: 'fixture' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    child.stdout.emit('data', JSON.stringify({ id: 1, result: {} }) + '\n')
    child.stdout.emit('data', JSON.stringify({ id: 2, result: { tools: [] } }) + '\n')
    const settled = vi.fn(); void result.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', 0)
    expect(await result).toEqual({ status: 'connected', toolCount: 0, tools: [] })
  })

  it('keeps a failed native process and its pipes owned through shutdown timeout and retry', async () => {
    const child = fakeChild(), spawn = vi.fn(() => child), owner = own({ spawn })
    const result = owner.probe({ name: 'fixture', command: 'fixture' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    child.emit('error', new Error('credential-bearing failure'))
    child.stdin.emit('error', new Error('credential-bearing pipe failure'))
    await expect(owner.close(5)).rejects.toThrow('MCP_PROBE_SHUTDOWN_INCOMPLETE')
    expect(await result).toEqual({ status: 'failed', error: 'MCP probe cancelled' })
    const retry = owner.close()
    child.emit('close', 1)
    await retry
    await expect(owner.probe({ name: 'late' })).rejects.toThrow('MCP_PROBE_SERVICE_CLOSED')
  })

  it('bounds unframed stdout without retaining or returning secret-bearing stderr', async () => {
    const child = fakeChild(), spawn = vi.fn(() => child), owner = own({ spawn })
    const result = owner.probe({ name: 'fixture', command: 'fixture' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    child.stderr.emit('data', Buffer.from('fixture-private'))
    child.stdout.emit('data', 'x'.repeat(256 * 1024 + 1))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', 1)
    expect(await result).toEqual({ status: 'failed', error: 'MCP response exceeded its byte limit' })
  })

  it('runs the HTTP handshake sequentially with its negotiated session and closes response bodies', async () => {
    const methods: string[] = []
    const http = vi.fn<typeof fetch>(async (_url, options) => {
      const message = JSON.parse(options!.body as string); methods.push(message.method)
      if (message.method === 'initialize') return new Response(JSON.stringify({ id: 1, result: {} }), { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-session' } })
      expect(options!.headers).toHaveProperty('Mcp-Session-Id', 'fixture-session')
      if (!message.id) return new Response(null, { status: 202 })
      return json(2, { tools: [{ name: 'fixture', description: 'fixture' }] })
    })
    expect(await own({ fetch: http }).probe(remote)).toEqual({ status: 'connected', toolCount: 1, tools: [{ name: 'fixture', description: 'fixture' }] })
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
  })

  it('completes the authenticated handshake against an actual loopback HTTP server', async () => {
    const received: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        if (request.headers.authorization !== 'Bearer fixture-private') { response.writeHead(401).end(); return }
        const message = JSON.parse(body)
        received.push(message.method)
        if (message.method !== 'initialize' && request.headers['mcp-session-id'] !== 'fixture-session') { response.writeHead(400).end(); return }
        if (!message.id) { response.writeHead(202).end(); return }
        response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-session' })
        response.end(JSON.stringify({ id: message.id, result: message.id === 1 ? {} : { tools: [{ name: 'fixture', description: 'local' }] } }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const owner = own({ fetch })
    try {
      expect(await owner.probe({ ...remote, url: `http://127.0.0.1:${port}/mcp` })).toEqual({ status: 'connected', toolCount: 1, tools: [{ name: 'fixture', description: 'local' }] })
      expect(received).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
      await owner.close()
    } finally {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
    }
  })

  it('retains an abort-ignoring fetch through shutdown and cancels a late response without another request', async () => {
    const response = deferred<Response>(), cancel = vi.fn()
    const http = vi.fn<typeof fetch>(() => response.promise), owner = own({ fetch: http })
    const result = owner.probe(remote)
    await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
    await expect(owner.close(5)).rejects.toThrow('MCP_PROBE_SHUTDOWN_INCOMPLETE')
    expect(await result).toEqual({ status: 'failed', error: 'MCP probe cancelled' })
    response.resolve(new Response(new ReadableStream({ cancel })))
    await owner.close()
    expect(cancel).toHaveBeenCalledOnce()
    expect(http).toHaveBeenCalledOnce()
  })

  it('joins the initialized notification body cleanup and fences the later tools request', async () => {
    const cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise)
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(json(1, {}))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
    const owner = own({ fetch: http }), result = owner.probe(remote)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    await expect(owner.close(5)).rejects.toThrow('MCP_PROBE_SHUTDOWN_INCOMPLETE')
    cleanup.resolve()
    await owner.close()
    expect((await result).status).toBe('failed')
    expect(http).toHaveBeenCalledTimes(2)
  })

  it('retains an abort-ignoring response reader through a public timeout', async () => {
    let finish!: () => void
    const body = new ReadableStream<Uint8Array>({ start(controller) { finish = () => controller.close() } })
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    const owner = own({ fetch: http }, 25), result = owner.probe(remote)
    expect(await result).toEqual({ status: 'failed', error: 'MCP probe timed out' })
    await expect(owner.close(5)).rejects.toThrow('MCP_PROBE_SHUTDOWN_INCOMPLETE')
    finish()
    await owner.close()
    expect(http).toHaveBeenCalledOnce()
  })

  it('cancels oversized JSON and reports HTTP/protocol failures without reflected credential data', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)) }, cancel })
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('fixture-private', { status: 401, statusText: 'fixture-private' }))
      .mockRejectedValueOnce(new Error('fixture-private'))
      .mockResolvedValueOnce(Response.json({ id: 1, error: { message: 'fixture-private' } }))
    const owner = own({ fetch: http })
    expect(await owner.probe(remote)).toEqual({ status: 'failed', error: 'MCP probe failed' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(await owner.probe(remote)).toEqual({ status: 'failed', error: 'MCP initialize HTTP 401' })
    expect(await owner.probe(remote)).toEqual({ status: 'failed', error: 'MCP probe failed' })
    expect(await owner.probe(remote)).toEqual({ status: 'failed', error: 'MCP initialize protocol error' })
  })

  it('fences queued work before host access and refuses invalid shutdown bounds', async () => {
    const http = vi.fn<typeof fetch>(), spawn = vi.fn(), owner = own({ fetch: http, spawn })
    await expect(owner.close(0)).rejects.toThrow(RangeError)
    const result = owner.probe(remote)
    owner.shutdown()
    expect((await result).status).toBe('failed')
    await owner.close()
    expect(http).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  })

  it('counts abort-ignoring probes toward admission until raw cleanup finishes', async () => {
    const responses = Array.from({ length: 16 }, () => deferred<Response>())
    let index = 0
    const http = vi.fn<typeof fetch>(() => responses[index++].promise)
    const owner = own({ fetch: http }), results = responses.map(() => owner.probe(remote))
    expect(await owner.probe(remote)).toEqual({ status: 'failed', error: 'Too many active MCP probes' })
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(16))
    await expect(owner.close(5)).rejects.toThrow('MCP_PROBE_SHUTDOWN_INCOMPLETE')
    for (const response of responses) response.resolve(new Response())
    await owner.close()
    expect((await Promise.all(results)).every(result => result.status === 'failed')).toBe(true)
  })
})
