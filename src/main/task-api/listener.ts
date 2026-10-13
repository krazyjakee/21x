import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** Owns native listener close and raw handlers even after the caller disconnects. */
export class TaskApiListener {
  private readonly server
  private readonly requests = new Set<Promise<void>>()
  private closing = false
  private closeRequested = false
  private closeObserved = false
  private startup: Promise<number> | null = null
  private rejectStartup: ((error: Error) => void) | undefined
  private acknowledgeClose!: () => void
  private readonly closed = new Promise<void>(resolve => { this.acknowledgeClose = resolve })

  constructor(private readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    this.server = createServer((req, res) => {
      // An unauthorized or closing request may never install a body reader.
      // Its socket can still abort while the owned listener is shutting down.
      req.on('error', () => {})
      const work = Promise.resolve().then(async () => {
        if (this.closing) {
          if (!res.destroyed) { res.writeHead(503); res.end() }
          return
        }
        await this.handler(req, res)
      })
      this.requests.add(work)
      void work.then(() => this.requests.delete(work), () => {
        this.requests.delete(work)
        res.destroy()
      })
    })
    this.server.once('close', () => {
      this.closeObserved = true
      this.rejectStartup?.(new Error('TASK_API_CLOSED'))
      this.acknowledgeClose()
    })
  }

  get isClosing(): boolean { return this.closing }
  get isFullyClosed(): boolean { return this.closeObserved && this.requests.size === 0 }

  start(): Promise<number> {
    if (this.closing) return Promise.reject(new Error('TASK_API_CLOSED'))
    if (this.startup) return this.startup
    this.startup = new Promise<number>((resolve, reject) => {
      this.rejectStartup = reject
      this.server.once('error', () => {
        reject(new Error('TASK_API_STARTUP_FAILED'))
        this.stop()
      })
      this.server.listen(0, '127.0.0.1', () => {
        if (this.closing) { reject(new Error('TASK_API_CLOSED')); return }
        const address = this.server.address()
        if (!address || typeof address === 'string') { reject(new Error('TASK_API_STARTUP_FAILED')); this.stop(); return }
        this.rejectStartup = undefined
        resolve(address.port)
      })
    })
    // A stopped startup may have no awaiting caller yet.
    void this.startup.catch(() => {})
    return this.startup
  }

  stop(): void {
    this.closing = true
    if (this.closeRequested) return
    this.closeRequested = true
    this.server.close()
    // Disconnecting a socket does not release the raw route handler above.
    this.server.closeAllConnections()
  }

  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Task API shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('TASK_API_SHUTDOWN_INCOMPLETE')), timeoutMs)
    })
    try {
      do {
        await Promise.race([Promise.allSettled([this.closed, ...(this.startup ? [this.startup] : []), ...this.requests]), expired])
      } while (!this.isFullyClosed)
    } finally { if (timer) clearTimeout(timer) }
  }
}
