import { createServer, type RequestListener, type Server } from 'node:http'
import type { DatabaseManager } from './database'

export type SecretBrokerSource = Pick<DatabaseManager, 'getSecretsWithValues'>
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Loopback credentials belong to one listener generation and one source. */
export class SecretBroker {
  private source: SecretBrokerSource | null
  private server: Server | null = null
  private starting: Promise<number> | null = null
  private nativeClose: Promise<void> | null = null
  private closing = false
  private listeningPort: number | null = null
  private readonly sessions = new Map<string, { agentId: string; secretIds: string[] }>()

  constructor(source: SecretBrokerSource, private readonly serverFactory: (listener: RequestListener) => Server = createServer) {
    this.source = source
  }

  get port(): number | null { return this.closing ? null : this.listeningPort }

  register(token: string, agentId: string, secretIds: string[]): void {
    if (this.closing) throw new Error('SECRET_BROKER_CLOSED')
    if (!token) throw new Error('Secret session token is required')
    this.sessions.set(token, { agentId, secretIds: [...secretIds] })
  }

  unregister(token: string): void { this.sessions.delete(token) }

  start(): Promise<number> {
    if (this.closing) return Promise.reject(new Error('SECRET_BROKER_CLOSED'))
    if (this.starting) return this.starting
    const listener: RequestListener = (req, res) => {
      const reply = (status: number, body = ''): void => {
        res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
        res.end(body)
      }
      if (this.closing || !this.source) { reply(503); return }
      if (req.method !== 'GET') { reply(405); return }
      let url: URL
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1') }
      catch { reply(400); return }
      if (url.pathname !== '/secrets/export') { reply(404); return }
      const session = this.sessions.get(url.searchParams.get('token') ?? '')
      if (!session) { reply(403); return }
      try {
        const secrets = this.source.getSecretsWithValues(session.secretIds)
          .filter(secret => SHELL_IDENTIFIER.test(secret.env_var_name))
        const body = url.searchParams.get('format') === 'base64'
          ? secrets.map(secret => `${secret.env_var_name}=${Buffer.from(secret.value, 'utf8').toString('base64')}`).join('\n')
          : secrets.map(secret => `export ${secret.env_var_name}='${secret.value.replace(/'/g, "'\\''")}'`).join('\n')
        reply(200, body)
      } catch {
        // Decryption errors can carry values or paths; do not log their contents.
        reply(500)
      }
    }
    let server: Server
    try { server = this.serverFactory(listener) }
    catch { return Promise.reject(new Error('SECRET_BROKER_START_FAILED')) }
    this.server = server
    this.starting = new Promise<number>((resolve, reject) => {
      let settled = false
      const failed = (): void => {
        if (settled) return
        settled = true
        reject(new Error('SECRET_BROKER_START_FAILED'))
      }
      // Keep the error handler for the listener's entire lifetime.
      server.on('error', failed)
      try {
        server.listen(0, '127.0.0.1', () => {
          if (settled) return
          settled = true
          const address = server.address()
          if (this.closing) { reject(new Error('SECRET_BROKER_CLOSED')); return }
          if (!address || typeof address !== 'object') { reject(new Error('SECRET_BROKER_START_FAILED')); return }
          this.listeningPort = address.port
          resolve(address.port)
        })
      } catch { failed() }
    })
    void this.starting.catch(() => {})
    return this.starting
  }

  shutdown(): void {
    this.closing = true
    this.listeningPort = null
    this.sessions.clear()
    void this.beginNativeClose().catch(() => {})
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Secret broker shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SECRET_BROKER_SHUTDOWN_INCOMPLETE')), timeoutMs)
    })
    try { await Promise.race([this.beginNativeClose(), expired]) }
    finally { if (timer) clearTimeout(timer) }
  }

  private beginNativeClose(): Promise<void> {
    if (this.nativeClose) return this.nativeClose
    const server = this.server
    // Wait for the actual bind callback/error before closing. A close made
    // before listen completes can otherwise leave a later listener unowned.
    const work = Promise.resolve(this.starting).catch(() => {}).then(async () => {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close(error => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
            else resolve()
          })
          server.closeAllConnections()
        })
      }
      this.source = null
      this.server = null
    })
    this.nativeClose = work
    // A native close failure retains the listener/source and permits retry.
    void work.catch(() => { if (this.nativeClose === work) this.nativeClose = null })
    return work
  }
}
