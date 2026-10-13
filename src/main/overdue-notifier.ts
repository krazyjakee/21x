/** Application-owned reminder tick; the host resolves the current renderer. */
export class OverdueNotifier {
  private timer: ReturnType<typeof setInterval> | null = null
  private closing = false

  constructor(private readonly notify: () => void) {}

  start(): void {
    if (this.closing) throw new Error('OVERDUE_NOTIFIER_CLOSED')
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.closing) return
      try { this.notify() }
      catch (error) { console.warn('[OverdueNotifier] Could not deliver reminder tick:', error) }
    }, 60_000)
  }

  shutdown(): void {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
