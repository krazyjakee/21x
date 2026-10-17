import { listToolsForScope, type ToolCallResult } from '../main/mcp-servers/task-management-core'
import { signedTaskMcpForwarding } from '../main/mcp-servers/task-group-stdio'

const MAX_BYTES = 16 * 1024 * 1024
const FAILURE = 'Task MCP transport unavailable. Reconnect this session.'
const invalid = (): Error => new Error(FAILURE)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
type Tools = ReturnType<typeof listToolsForScope>

/** Production stdio is a proxy, never a second task authority. All calls use
 * the exact app-issued signed URL; no environment/body scope or plain-route
 * fallback can substitute for the owning HTTP server's signature checks. */
export class TaskMcpStdioProxy {
  private readonly url: string
  private readonly tools: Tools
  private readonly names: Set<string>
  private readonly work = new Set<Promise<unknown>>()
  private readonly requests = new Set<AbortController>()
  private closing = false
  private sequence = 0

  constructor(apiUrl: string | undefined, signedUrl: string | undefined,
    private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 15_000) {
    try {
      if (!apiUrl || !signedUrl || signedUrl.length > 16384 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw invalid()
      const api = new URL(apiUrl), endpoint = new URL(signedUrl)
      if (api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || !api.port || api.pathname !== '/' || api.search || api.hash || api.username || api.password) throw invalid()
      const keys = new Set(['token', 'scope_signature', 'project', 'task', 'parent', 'artifact', 'agent', 'session'])
      for (const key of endpoint.searchParams.keys()) if (!keys.has(key) || endpoint.searchParams.getAll(key).length !== 1) throw invalid()
      if (!/^[0-9a-f]{64}$/.test(endpoint.searchParams.get('token') ?? '')) throw invalid()
      const forwarding = signedTaskMcpForwarding(signedUrl, apiUrl)
      if (!forwarding) throw invalid()
      this.url = forwarding.url
      this.tools = listToolsForScope(forwarding.scope, { includeLegacyBrowserTools: false })
      this.names = new Set(this.tools.map(tool => tool.name))
    } catch { throw invalid() }
  }

  get pendingCount(): number { return this.work.size }

  async list(signal?: AbortSignal): Promise<{ tools: Tools }> {
    // Even tools/list goes to the owning server: a syntactically valid but
    // forged/stale scope is never sufficient to advertise production tools.
    const result = await this.request('tools/list', {}, signal)
    if (!record(result) || !Array.isArray(result.tools) || result.tools.some(tool => !record(tool) || typeof tool.name !== 'string')) throw invalid()
    const names = new Set(result.tools.map(tool => (tool as { name: string }).name))
    return { tools: this.tools.filter(tool => names.has(tool.name)) }
  }

  async call(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult> {
    if (!this.names.has(name)) return { content: [{ type: 'text', text: 'Unknown or unavailable task tool.' }], isError: true }
    try {
      const result = await this.request('tools/call', { name, arguments: args ?? {} }, signal)
      if (!record(result) || !Array.isArray(result.content) || result.content.some(item => !record(item) || item.type !== 'text' || typeof item.text !== 'string') || result.isError !== undefined && typeof result.isError !== 'boolean') throw invalid()
      return { content: result.content.map(item => ({ type: 'text' as const, text: (item as { text: string }).text })), ...(result.isError === undefined ? {} : { isError: result.isError }) }
    } catch { return { content: [{ type: 'text', text: FAILURE }], isError: true } }
  }

  private request(method: 'tools/list' | 'tools/call', params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closing || signal?.aborted || this.work.size >= 4) return Promise.reject(invalid())
    const id = `stdio-${++this.sequence}`
    let body: string
    try {
      body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      if (Buffer.byteLength(body) > MAX_BYTES) throw invalid()
    } catch { return Promise.reject(invalid()) }
    const controller = new AbortController()
    let rejectAborted!: (error: Error) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
    controller.signal.addEventListener('abort', () => rejectAborted(invalid()), { once: true })
    const cancel = (): void => { controller.abort() }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const timer = setTimeout(cancel, this.timeoutMs)
    this.requests.add(controller)
    const raw = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      const response = await this.fetcher(this.url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, signal: controller.signal, body })
      if (controller.signal.aborted || !response.ok || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        await response.body?.cancel(); throw invalid()
      }
      const frame: unknown = JSON.parse(await this.read(response, controller.signal))
      if (!record(frame) || frame.jsonrpc !== '2.0' || frame.id !== id || 'error' in frame || !('result' in frame)) throw invalid()
      return frame.result
    }).catch(() => { throw invalid() }).finally(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      this.requests.delete(controller); this.work.delete(raw)
    })
    this.work.add(raw)
    // Public cancellation never discards the raw fetch/read/cancel flight.
    return Promise.race([raw, aborted])
  }

  private async read(response: Response, signal: AbortSignal): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) throw invalid()
    let cancellation: Promise<void> | undefined
    const cancel = (): Promise<void> => cancellation ??= reader.cancel()
    const abort = (): void => { void cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        size += value.length
        if (size > MAX_BYTES) throw invalid()
        chunks.push(value)
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } finally {
      signal.removeEventListener('abort', abort)
      try { await cancel() } finally { reader.releaseLock() }
    }
  }

  shutdown(): void {
    this.closing = true
    for (const request of this.requests) request.abort()
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid task MCP shutdown deadline')
    this.shutdown()
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([Promise.allSettled([...this.work]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(invalid()), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
}
