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
const sse = (text: string, cancel = vi.fn()): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode(text)) }, cancel
}), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })

describe('bounded Streamable HTTP MCP discovery', () => {
  it('discovers tools over actual authenticated SSE replies that remain open after each RPC response', async () => {
    const received: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        if (request.headers.authorization !== remote.headers.Authorization) { response.writeHead(401).end(); return }
        const message = JSON.parse(body)
        received.push(message.method)
        if (message.method !== 'initialize' && request.headers['mcp-session-id'] !== 'sse-fixture-session') { response.writeHead(400).end(); return }
        if (!message.id) { response.writeHead(202).end(); return }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sse-fixture-session' })
        response.write(': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\r\n\r\n')
        response.write('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.id === 1 ? {} : { tools: [{ name: 'sse_lookup', description: 'Synthetic loopback tool' }] } }) + '\r\n\r\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const owner = own({ fetch })
    try {
      const port = (server.address() as { port: number }).port
      expect(await owner.probe({ ...remote, url: `http://127.0.0.1:${port}/mcp` }, undefined)).toEqual({ status: 'connected', toolCount: 1, tools: [{ name: 'sse_lookup', description: 'Synthetic loopback tool' }] })
      await owner.close()
      expect(received).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
      expect(owner.pendingCount).toBe(0)
    } finally {
      await owner.close()
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
    }
  })

  it('handles split UTF-8, BOM, CR/LF/CRLF, comments, multiline data and batched notifications', async () => {
    const cancelled = vi.fn()
    const bytes = new TextEncoder().encode('\uFEFF: keepalive\r\nevent: ignored\rdata: not JSON\r\rdata: [{"method":"notifications/message"},\r\ndata: {"id":99,"result":{}},{"id":1,"result":{}}]\r\n\r\n')
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)) }, cancel: cancelled })
    const tools = '\ndata: {"id":2,"result":{"tools":[{"name":"lookup","description":"雪 🐾"}]}}\n\n'
    const toolBytes = new TextEncoder().encode(tools), toolCancel = vi.fn()
    const toolBody = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of toolBytes) controller.enqueue(Uint8Array.of(byte)) }, cancel: toolCancel })
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'Text/Event-Stream; charset=utf-8' } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 })).mockResolvedValueOnce(new Response(toolBody, { headers: { 'Content-Type': 'text/event-stream' } }))
    expect(await own({ fetch: http }).probe(remote)).toEqual({ status: 'connected', toolCount: 1, tools: [{ name: 'lookup', description: '雪 🐾' }] })
    expect(cancelled).toHaveBeenCalledOnce(); expect(toolCancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false); expect(toolBody.locked).toBe(false)
  })

  it.each([
    ['HTML', '<html>fixture-private</html>', 'text/html'],
    ['missing type', 'fixture-private', ''],
    ['JSON lookalike type', '{"id":1,"result":{}}', 'application/json-invalid'],
    ['empty SSE', '', 'text/event-stream'],
    ['notification only', 'data: {"method":"notifications/message"}\n\n', 'text/event-stream'],
    ['wrong response ID', 'data: {"id":99,"result":{}}\n\n', 'text/event-stream'],
    ['request with matching ID', 'data: {"id":1,"method":"ping"}\n\n', 'text/event-stream'],
    ['unterminated event', 'data: {"id":1,"result":{}}\n', 'text/event-stream'],
    ['malformed JSON', 'data: fixture-private\n\n', 'text/event-stream'],
    ['malformed envelope', 'data: null\n\n', 'text/event-stream']
  ])('rejects %s without claiming connected or advancing protocol', async (_label, text, type) => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(text, { headers: type ? { 'Content-Type': type } : undefined }))
    const result = await own({ fetch: http }).probe(remote)
    expect(result).toEqual({ status: 'failed', error: 'MCP probe failed' })
    expect(JSON.stringify(result)).not.toContain('fixture-private'); expect(http).toHaveBeenCalledOnce()
  })

  it('bounds SSE bytes, cancels an unfinished response and redacts RPC error data', async () => {
    const oversizedCancel = vi.fn(), errorCancel = vi.fn()
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(sse(':' + 'x'.repeat(256 * 1024), oversizedCancel))
      .mockResolvedValueOnce(sse('data: {"id":1,"error":{"message":"fixture-private"}}\n\n', errorCancel))
    const owner = own({ fetch: http })
    expect(await owner.probe(remote)).toEqual({ status: 'failed', error: 'MCP probe failed' })
    expect(oversizedCancel).toHaveBeenCalledOnce()
    expect(await owner.probe(remote)).toEqual({ status: 'failed', error: 'MCP initialize protocol error' })
    expect(errorCancel).toHaveBeenCalledOnce()
  })

  it('joins successful SSE reader cancellation before sending the initialized notification', async () => {
    const cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise)
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(sse('data: {"id":1,"result":{}}\n\n', cancel))
      .mockResolvedValueOnce(new Response(null, { status: 202 })).mockResolvedValueOnce(json(2, { tools: [] }))
    const owner = own({ fetch: http }), receipt = owner.probeOwned(remote)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(http).toHaveBeenCalledOnce(); expect(owner.pendingCount).toBe(1)
    cleanup.resolve()
    expect(await receipt.result).toEqual({ status: 'connected', toolCount: 0, tools: [] }); await receipt.closed
    expect(http).toHaveBeenCalledTimes(3)
  })

  it('cancels pending SSE reads on timeout, retains a held cancellation acknowledgement and fences later requests', async () => {
    const cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise)
    const response = sse(': waiting for response\n\n', cancel)
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(response)
    const owner = own({ fetch: http }, 25), receipt = owner.probeOwned(remote)
    expect(await receipt.result).toEqual({ status: 'failed', error: 'MCP probe timed out' })
    expect(cancel).toHaveBeenCalledOnce()
    await expect(owner.close(5)).rejects.toThrow('MCP_PROBE_SHUTDOWN_INCOMPLETE')
    expect(owner.pendingCount).toBe(1)
    cleanup.resolve(); await owner.close(); await receipt.closed
    expect(response.body?.locked).toBe(false); expect(http).toHaveBeenCalledOnce(); expect(owner.pendingCount).toBe(0)
  })

  it('does not advance after authority is withdrawn while an SSE reply is being cancelled', async () => {
    let allowed = true
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(sse('data: {"id":1,"result":{}}\n\n', vi.fn(() => { allowed = false })))
    const receipt = own({ fetch: http }).probeOwned(remote, undefined, { beforeEffect() { if (!allowed) throw new Error('private authority') } })
    expect(await receipt.result).toEqual({ status: 'failed', error: 'MCP probe cancelled' }); await receipt.closed
    expect(http).toHaveBeenCalledOnce()
  })
})

describe('portable MCP probe ownership', () => {
  it('refuses retired authority before environment or spawn access', async () => {
    const environment = vi.fn(() => ({})), spawn = vi.fn(), owner = own({ environment, spawn })
    const receipt = owner.probeOwned({ name: 'fixture', command: 'fixture' }, undefined,
      { beforeEffect: () => { throw new Error('Private caller authority was withdrawn') } })
    expect(await receipt.result).toEqual({ status: 'failed', error: 'MCP probe cancelled' })
    await receipt.closed
    expect(environment).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  })

  it('fences stdio protocol writes after revocation and retains the exact child until close', async () => {
    const child = fakeChild(), spawn = vi.fn(() => child), owner = own({ spawn })
    const write = vi.spyOn(child.stdin, 'write'), closed = vi.fn()
    let allowed = true
    const receipt = owner.probeOwned({ name: 'fixture', command: 'fixture' }, undefined,
      { beforeEffect: () => { if (!allowed) throw new Error('Revoked') } })
    void receipt.closed.then(closed)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(write).toHaveBeenCalledOnce()
    allowed = false
    child.stdout.emit('data', JSON.stringify({ id: 1, result: {} }) + '\n')
    expect(await receipt.result).toEqual({ status: 'failed', error: 'MCP probe cancelled' })
    expect(write).toHaveBeenCalledOnce(); expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(closed).not.toHaveBeenCalled(); expect(owner.pendingCount).toBe(1)
    child.emit('close', 1); await receipt.closed
    expect(closed).toHaveBeenCalledOnce()
  })

  it('uses literal portable arguments and never injects task API credentials by a user server name', async () => {
    const child = fakeChild(), spawn = vi.fn(() => child), taskApiEnvironment = vi.fn(() => ({ TASK_API_TOKEN: 'private-launch-token' }))
    const owner = own({ spawn, taskApiEnvironment, environment: () => ({ PATH: '/fixture' }) })
    const args = ['--fixture', 'literal; argument'], environment = { OWNED: 'fixture' }
    const receipt = owner.probeOwned({ name: 'task-management', command: 'npx', args, environment }, undefined, { beforeEffect: () => {} })
    args[1] = 'changed after admission'; environment.OWNED = 'changed'
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn).toHaveBeenCalledWith('npx', ['--fixture', 'literal; argument'], { env: { PATH: '/fixture', npm_config_yes: 'true', OWNED: 'fixture' } })
    expect(taskApiEnvironment).not.toHaveBeenCalled()
    child.emit('close', 1); await receipt.closed; await receipt.result
  })

  it('refuses portable Windows shell-script probes before host access', async () => {
    const spawn = vi.fn(), environment = vi.fn(), owner = own({ spawn, environment, platform: 'win32' })
    const receipt = owner.probeOwned({ name: 'fixture', command: 'fixture.cmd' }, undefined, { beforeEffect: () => {} })
    expect(await receipt.result).toEqual({ status: 'failed', error: 'MCP shell-script probes are unavailable in this host' })
    await receipt.closed; expect(spawn).not.toHaveBeenCalled(); expect(environment).not.toHaveBeenCalled()
  })

  it('joins late HTTP response cleanup after authority loss and never sends the next protocol request', async () => {
    const response = deferred<Response>(), cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise)
    const http = vi.fn<typeof fetch>(() => response.promise), owner = own({ fetch: http })
    let allowed = true
    const receipt = owner.probeOwned(remote, undefined, { beforeEffect: () => { if (!allowed) throw new Error('Revoked') } })
    await vi.waitFor(() => expect(http).toHaveBeenCalledOnce())
    expect(http.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' })
    allowed = false; response.resolve(new Response(new ReadableStream({ cancel })))
    expect(await receipt.result).toEqual({ status: 'failed', error: 'MCP probe cancelled' })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    const closed = vi.fn(); void receipt.closed.then(closed)
    await Promise.resolve(); expect(closed).not.toHaveBeenCalled()
    cleanup.resolve(); await receipt.closed
    expect(http).toHaveBeenCalledOnce()
  })

  it('fences protocol advancement when authority changes during response cleanup', async () => {
    let allowed = true
    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(json(1, {}))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: () => { allowed = false } })))
    const owner = own({ fetch: http })
    const receipt = owner.probeOwned(remote, undefined, { beforeEffect: () => { if (!allowed) throw new Error('Revoked') } })
    expect(await receipt.result).toEqual({ status: 'failed', error: 'MCP probe cancelled' })
    await receipt.closed; expect(http).toHaveBeenCalledTimes(2)
  })

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

  it('separates external cancellation from the exact raw child-close receipt', async () => {
    const child = fakeChild(), spawn = vi.fn(() => child), owner = own({ spawn })
    const controller = new AbortController(), receipt = owner.probeOwned({ name: 'fixture', command: 'fixture' }, controller.signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    controller.abort()
    expect(await receipt.result).toEqual({ status: 'failed', error: 'MCP probe cancelled' })
    const closed = vi.fn(); void receipt.closed.then(closed)
    await Promise.resolve(); expect(closed).not.toHaveBeenCalled(); expect(owner.pendingCount).toBe(1)
    child.emit('close', 1); await receipt.closed
    expect(closed).toHaveBeenCalledOnce(); expect(owner.pendingCount).toBe(0)
    const cancelled = new AbortController(); cancelled.abort()
    const beforeSpawn = spawn.mock.calls.length
    expect((await owner.probe({ name: 'late', command: 'fixture' }, cancelled.signal)).status).toBe('failed')
    expect(spawn).toHaveBeenCalledTimes(beforeSpawn)
  })

  it('retains auth response cleanup and requests a non-following HTTP transport', async () => {
    const cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise)
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 401 }))
    const owner = own({ fetch: http }), result = owner.probeForAuth(remote.url)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(http.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' })
    await expect(owner.close(5)).rejects.toThrow('MCP_PROBE_SHUTDOWN_INCOMPLETE')
    const cancelled = expect(result).rejects.toBeDefined()
    cleanup.resolve(); await cancelled; await owner.close()
    expect(http).toHaveBeenCalledOnce()
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
