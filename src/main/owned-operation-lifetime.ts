/** Holds raw work until settlement; abort requests never stand in for acknowledgement. */
export class OwnedOperationLifetime {
  private closing = false
  private readonly work = new Set<Promise<unknown>>()

  assertOpen(): void {
    if (this.closing) throw new Error('OWNER_CLOSING')
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const raw = Promise.resolve().then(() => { this.assertOpen(); return operation() })
    this.work.add(raw)
    void raw.then(() => this.work.delete(raw), () => this.work.delete(raw))
    return raw
  }

  stop(): void { this.closing = true }

  async close(timeoutMs = 3000): Promise<void> {
    this.stop()
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new Error('OWNER_DRAIN_TIMEOUT_INVALID')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => { while (this.work.size) await Promise.allSettled([...this.work]) })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OWNER_DRAIN_BLOCKED')), timeoutMs) })
      ])
    } finally { if (timer) clearTimeout(timer) }
  }
}
