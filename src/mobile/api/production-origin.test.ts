import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('./client')
vi.unmock('./websocket')
class Socket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static CLOSING = 2
  static instances: Socket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  close = vi.fn(() => { this.readyState = 3 })
  send = vi.fn()
  constructor(readonly url: string) { Socket.instances.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
}
let transport: typeof import('./websocket') | undefined
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket); localStorage.clear() })
afterEach(() => { transport?.disconnectWebSocket?.(); transport = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function location(protocol: string, port: string) {
  vi.stubGlobal('window', { location: { protocol, port, hostname: 'mobile.example.test', host: `mobile.example.test${port ? ':' + port : ''}` } })
}
describe('actual mobile HTTP and WebSocket clients without desktop bridge', () => {
  it.each([['http:', '24080'], ['https:', '24443'], ['https:', '']])('retains exact production %s origin/port %s for reads and authenticated sockets', async (protocol, port) => {
    vi.stubEnv('DEV', false); location(protocol, port)
    const fetcher = vi.fn(async (_url: string, _options?: unknown) => ({ ok: true, json: async () => [] })); vi.stubGlobal('fetch', fetcher)
    const auth = await import('./auth'); auth.saveSessionToken('synthetic-mobile-token')
    const client = await import('./client'); transport = await import('./websocket')
    await client.api.tasks.list(); transport.connectWebSocket()
    expect(fetcher).toHaveBeenCalledWith('/api/tasks', { headers: { Authorization: 'Bearer synthetic-mobile-token' } })
    expect(Socket.instances[0].url).toBe(`${protocol === 'https:' ? 'wss:' : 'ws:'}//mobile.example.test${port ? ':' + port : ''}/ws?token=synthetic-mobile-token`)
  })
  it('keeps the explicit Vite development port override', async () => {
    vi.stubEnv('DEV', true); location('http:', '5173')
    const fetcher = vi.fn(async (_url: string, _options?: unknown) => ({ ok: true, json: async () => [] })); vi.stubGlobal('fetch', fetcher)
    const client = await import('./client'); transport = await import('./websocket')
    await client.api.tasks.list(); transport.connectWebSocket()
    expect(fetcher.mock.calls[0][0]).toBe('http://mobile.example.test:20620/api/tasks')
    expect(Socket.instances[0].url).toBe('ws://mobile.example.test:20620/ws')
  })
  it('stale socket close/error/events cannot retire or publish into its replacement; disposal joins document observers/timers', async () => {
    vi.stubEnv('DEV', false); location('http:', '24080'); transport = await import('./websocket')
    const state = vi.fn(), event = vi.fn(); transport.setStatusChangeHandler(state); transport.onEvent('task:updated', event)
    transport.connectWebSocket(); const first = Socket.instances[0]; first.open()
    first.readyState = Socket.CLOSED; transport.connectWebSocket(); const next = Socket.instances[1]; next.open()
    state.mockClear(); first.onclose?.(); first.onerror?.(); first.onmessage?.({ data: JSON.stringify({ type: 'task:updated', payload: { title: 'stale' } }) })
    expect(state).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled(); expect(next.close).not.toHaveBeenCalled()
    next.onmessage?.({ data: JSON.stringify({ type: 'task:updated', payload: { title: 'current' } }) })
    expect(event).toHaveBeenCalledWith({ title: 'current' })
    transport.disconnectWebSocket(); expect(next.close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30000); expect(Socket.instances).toHaveLength(2)
  })
})
