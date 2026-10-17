import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import {
  MCP_INITIALIZE_ID, MCP_TOOLS_LIST_ID, mcpInitializeRequest,
  mcpInitializedNotification, mcpToolsListRequest, summarizeMcpTools,
  type McpRpcResponse, type McpToolSummary
} from '../mcp-client-messages'

export interface McpServerProbeInput {
  name: string
  type?: string
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  environment?: Record<string, string>
}
export interface McpServerProbeResult {
  status: 'connected' | 'failed'
  error?: string
  errorDetail?: string
  toolCount?: number
  tools?: McpToolSummary[]
}
export interface McpProbeReceipt<T> { result: Promise<T>; closed: Promise<void> }
/** Trusted request authority, never inferred from an RPC payload. */
export interface McpProbeControls { beforeEffect(): void }
export interface McpProbeHost {
  spawn(command: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams
  fetch: typeof fetch
  environment(): NodeJS.ProcessEnv
  taskApiEnvironment(): Record<string, string>
  platform: NodeJS.Platform
}
const MAX_RESPONSE_BYTES = 256 * 1024
const failed = (error: string): McpServerProbeResult => ({ status: 'failed', error })

/** Owns raw HTTP/stdio probe work even after its public deadline expires. */
export class McpProbeService {
  private closing = false
  private readonly work = new Set<Promise<void>>()
  private readonly controllers = new Set<AbortController>()

  constructor(private readonly host: McpProbeHost, private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError('Invalid MCP probe deadline')
  }
  get isClosed(): boolean { return this.closing }
  get pendingCount(): number { return this.work.size }

  probe(input: McpServerProbeInput, signal?: AbortSignal): Promise<McpServerProbeResult> { return this.probeOwned(input, signal).result }
  probeOwned(input: McpServerProbeInput, signal?: AbortSignal, controls?: McpProbeControls): McpProbeReceipt<McpServerProbeResult> {
    if (this.closing) return { result: Promise.reject(new Error('MCP_PROBE_SERVICE_CLOSED')), closed: Promise.resolve() }
    if (this.work.size >= 16) return { result: Promise.resolve(failed('Too many active MCP probes')), closed: Promise.resolve() }
    const controller = new AbortController()
    let authorityLost = false
    const current = (): void => {
      controller.signal.throwIfAborted()
      try { controls?.beforeEffect() } catch (cause) { authorityLost = true; controller.abort(); throw cause }
      controller.signal.throwIfAborted()
    }
    // A caller cannot change the selected transport after admission.
    if (controls) {
      const selected = { ...input, args: input.args ? [...input.args] : undefined,
        headers: input.headers ? Object.freeze({ ...input.headers }) : undefined,
        environment: input.environment ? Object.freeze({ ...input.environment }) : undefined }
      if (selected.args) Object.freeze(selected.args)
      input = Object.freeze(selected)
    }
    const cancel = (): void => { controller.abort() }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) controller.abort()
    this.controllers.add(controller)
    let resolve!: (value: McpServerProbeResult) => void
    const result = new Promise<McpServerProbeResult>(done => { resolve = done })
    const aborted = (): void => resolve(failed(this.closing || signal?.aborted || authorityLost ? 'MCP probe cancelled' : 'MCP probe timed out'))
    controller.signal.addEventListener('abort', aborted, { once: true })
    if (controller.signal.aborted) aborted()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const raw = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return
      current()
      const answer = input.type === 'remote'
        ? await this.remote(input, controller.signal, current, !!controls)
        : await this.local(input, controller.signal, current, !!controls)
      current()
      if (!controller.signal.aborted) resolve(answer)
    }).catch(() => {
      // SDK, process and fetch errors can reflect env/header values or URLs.
      resolve(failed('MCP probe failed'))
    }).then(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      this.controllers.delete(controller)
      this.work.delete(raw)
    })
    this.work.add(raw)
    return { result, closed: raw }
  }

  /** Unauthenticated auth probe, retaining response cleanup even after cancellation. */
  probeForAuth(url: string, signal?: AbortSignal, controls?: McpProbeControls): Promise<{ requiresAuth: boolean }> {
    if (this.closing) return Promise.reject(new Error('MCP_PROBE_SERVICE_CLOSED'))
    if (this.work.size >= 16) return Promise.reject(new Error('MCP_PROBE_CAPACITY'))
    const controller = new AbortController()
    const cancel = (): void => { controller.abort() }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) controller.abort()
    this.controllers.add(controller)
    const timer = setTimeout(cancel, this.timeoutMs)
    const current = (): void => { controller.signal.throwIfAborted(); controls?.beforeEffect(); controller.signal.throwIfAborted() }
    const raw = Promise.resolve().then(async () => {
      const target = new URL(url)
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('MCP_AUTH_PROBE_FAILED')
      current()
      const response = await this.host.fetch(target.href, { method: 'GET', redirect: 'error', signal: controller.signal })
      try { current() } finally { await response.body?.cancel() }
      current()
      return { requiresAuth: response.status === 401 }
    }).finally(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      this.controllers.delete(controller); this.work.delete(retained)
    })
    const retained = raw.then(() => undefined, () => undefined)
    this.work.add(retained)
    return raw
  }

  shutdown(): void {
    this.closing = true
    for (const controller of this.controllers) controller.abort()
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid MCP probe shutdown deadline')
    this.shutdown()
    const drain = Promise.all([...this.work])
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP_PROBE_SHUTDOWN_INCOMPLETE')), timeoutMs) })
    try { await Promise.race([drain, expired]) }
    finally { if (timer) clearTimeout(timer) }
  }

  private local(input: McpServerProbeInput, signal: AbortSignal, current: () => void, portable: boolean): Promise<McpServerProbeResult> {
    if (!input.command) return Promise.resolve(failed('No command specified'))
    current()
    const needsShell = /^(npx|uvx|bunx)\b/.test(input.command) || (this.host.platform === 'win32' && /\.(cmd|bat)$/i.test(input.command))
    if (portable && this.host.platform === 'win32' && /\.(cmd|bat)$/i.test(input.command)) return Promise.resolve(failed('MCP shell-script probes are unavailable in this host'))
    const environment = { ...this.host.environment(), npm_config_yes: 'true', ...input.environment,
      ...(!portable && input.name === 'task-management' ? this.host.taskApiEnvironment() : {}) }
    current()
    const proc = this.host.spawn(input.command, input.args ?? [], {
      ...(needsShell && !portable ? { shell: true } : {}), env: environment
    })
    return new Promise(resolve => {
      let answer: McpServerProbeResult | undefined
      let buffer = '', bytes = 0, stderrBytes = 0
      let phase: 'init' | 'tools' = 'init'
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: McpServerProbeResult): void => {
        if (answer) return
        answer = value
        killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* raw close remains owned */ } }, 250)
        try { proc.kill('SIGTERM') } catch { /* retain until close; retry with force */ }
      }
      const abort = (): void => finish(failed('MCP probe cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      proc.on('error', () => finish(failed('MCP process failed to start or communicate')))
      for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
        stream.on('error', () => finish(failed('MCP process pipe failed')))
      }
      proc.on('close', code => {
        if (killTimer) clearTimeout(killTimer)
        signal.removeEventListener('abort', abort)
        resolve(answer ?? failed(`MCP process closed with code ${code ?? 'unknown'}`))
      })
      const send = (message: Record<string, unknown>): void => {
        if (answer || signal.aborted) return
        try { current(); proc.stdin.write(JSON.stringify(message) + '\n', error => { if (error) finish(failed('MCP process pipe failed')) }) }
        catch { finish(failed('MCP process pipe failed')) }
      }
      const handle = (message: McpRpcResponse): void => {
        if (answer || signal.aborted || !message || typeof message !== 'object') return
        try { current() } catch { finish(failed('MCP probe cancelled')); return }
        const expected = phase === 'init' ? MCP_INITIALIZE_ID : MCP_TOOLS_LIST_ID
        if (message.id !== expected) return
        if (message.error) { finish(failed('MCP server returned a protocol error')); return }
        if (!message.result) return
        if (phase === 'init') {
          phase = 'tools'; send(mcpInitializedNotification()); send(mcpToolsListRequest())
        } else {
          const tools = summarizeMcpTools(message.result)
          finish({ status: 'connected', toolCount: tools.length, tools })
        }
      }
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        if (answer || signal.aborted) return
        try { current() } catch { finish(failed('MCP probe cancelled')); return }
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_RESPONSE_BYTES) { finish(failed('MCP response exceeded its byte limit')); return }
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1)
          if (line) { try { handle(JSON.parse(line)) } catch { /* startup banners are tolerated within the byte limit */ } }
        }
        if (buffer.trim()) {
          try { const message = JSON.parse(buffer); buffer = ''; handle(message) } catch { /* partial frame */ }
        }
      })
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes > MAX_RESPONSE_BYTES) finish(failed('MCP diagnostic output exceeded its byte limit'))
      })
      // A host may synchronously request shutdown while spawning the child.
      if (signal.aborted) abort()
      else send(mcpInitializeRequest())
    })
  }

  private async remote(input: McpServerProbeInput, signal: AbortSignal, current: () => void, portable: boolean): Promise<McpServerProbeResult> {
    if (!input.url) return failed('No URL specified')
    const url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return failed('Invalid MCP HTTP URL')
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...input.headers }
    const post = async (message: Record<string, unknown>): Promise<Response> => {
      current()
      const response = await this.host.fetch(url.href, { method: 'POST', headers, body: JSON.stringify(message), signal,
        ...(portable ? { redirect: 'error' as const } : {}) })
      try { current() } catch (cause) { await response.body?.cancel(); throw cause }
      return response
    }
    const initialized = await post(mcpInitializeRequest())
    if (!initialized.ok) { await initialized.body?.cancel(); return failed(`MCP initialize HTTP ${initialized.status}`) }
    const initData = await this.readResponse(initialized, MCP_INITIALIZE_ID, signal, current)
    current()
    if (initData.id !== MCP_INITIALIZE_ID || initData.error || !initData.result) return failed('MCP initialize protocol error')
    const sessionId = initialized.headers.get('mcp-session-id')
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    const notified = await post(mcpInitializedNotification())
    await notified.body?.cancel()
    current()
    if (!notified.ok) return failed(`MCP initialized notification HTTP ${notified.status}`)
    const listed = await post(mcpToolsListRequest())
    if (!listed.ok) { await listed.body?.cancel(); return failed(`MCP tools HTTP ${listed.status}`) }
    const data = await this.readResponse(listed, MCP_TOOLS_LIST_ID, signal, current)
    current()
    if (data.id !== MCP_TOOLS_LIST_ID || data.error || !data.result) return failed('MCP tools protocol error')
    const tools = summarizeMcpTools(data.result)
    return { status: 'connected', toolCount: tools.length, tools }
  }

  private async readResponse(response: Response, id: number, signal: AbortSignal, current: () => void): Promise<McpRpcResponse> {
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    if (type === 'application/json') return this.readJson(response, current)
    if (type === 'text/event-stream') return this.readEventResponse(response, id, signal, current)
    await response.body?.cancel()
    throw new Error('Unsupported MCP response content type')
  }

  /** POST SSE replies can stay open after their matching RPC response. Stop at
   * that response, then join cancellation before advancing the handshake. No
   * reconnect, endpoint fallback or server-directed URL is followed by a probe. */
  private async readEventResponse(response: Response, id: number, signal: AbortSignal, current: () => void): Promise<McpRpcResponse> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let cancellation: Promise<void> | undefined
    const cancel = (): Promise<void> => cancellation ??= reader ? reader.cancel() : Promise.resolve()
    const abort = (): void => { void cancel().catch(() => {}) }
    try {
      current()
      reader = response.body?.getReader()
      if (!reader) throw new Error('Missing MCP event stream')
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let buffer = '', size = 0, data: string[] = [], event = ''
      const line = (value: string): McpRpcResponse | undefined => {
        if (value === '') {
          const payload = data.join('\n'), kind = event
          data = []; event = ''
          if (!payload || kind && kind !== 'message') return
          const message: unknown = JSON.parse(payload)
          const batch = Array.isArray(message) ? message : [message]
          for (const part of batch) {
            if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Invalid MCP event')
            if (part.id === id && !('method' in part) && ('result' in part || 'error' in part)) return part as McpRpcResponse
          }
          return
        }
        if (value.startsWith(':')) return
        const colon = value.indexOf(':')
        const field = colon === -1 ? value : value.slice(0, colon)
        let content = colon === -1 ? '' : value.slice(colon + 1)
        if (content.startsWith(' ')) content = content.slice(1)
        if (field === 'data') data.push(content)
        else if (field === 'event') event = content
        return undefined
      }
      while (true) {
        current()
        const { done, value } = await reader.read()
        current()
        if (!done) {
          size += value.length
          if (size > MAX_RESPONSE_BYTES) throw new Error('MCP event stream exceeded its byte limit')
          buffer += decoder.decode(value, { stream: true })
        } else buffer += decoder.decode()
        let match: RegExpExecArray | null
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          // Wait for the LF half of a CRLF that crosses a chunk boundary.
          if (!done && match[0] === '\r' && match.index === buffer.length - 1) break
          const answer = line(buffer.slice(0, match.index))
          buffer = buffer.slice(match.index + match[0].length)
          if (answer) return answer
        }
        // Incomplete events at EOF are not dispatched by the SSE protocol.
        if (done) throw new Error('MCP event stream ended without its response')
      }
    } finally {
      signal.removeEventListener('abort', abort)
      if (reader) { try { await cancel() } finally { reader.releaseLock() } }
      else await response.body?.cancel()
    }
  }

  private async readJson(response: Response, current: () => void): Promise<McpRpcResponse> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      current()
      reader = response.body?.getReader()
      if (!reader) throw new Error('Missing MCP response')
      while (true) {
        current()
        const { done, value } = await reader.read()
        current()
        if (done) break
        size += value.length
        if (size > MAX_RESPONSE_BYTES) throw new Error('MCP response exceeded its byte limit')
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as McpRpcResponse
    } finally {
      if (reader) { try { await reader.cancel() } finally { reader.releaseLock() } }
      else await response.body?.cancel()
    }
  }
}
