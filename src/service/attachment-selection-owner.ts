import { isSelectionOffer, type AttachmentSelection, type AttachmentSelectionBridge } from '../shared/attachment-selection-callbacks'
import { ServiceProtocolError } from '../shared/service-protocol'
interface Entry {
  value: AttachmentSelection; leaseId: string; expires: number; claimed: boolean; cancelled: boolean
  raw: Set<Promise<unknown>>; retiring?: Promise<void>; timer: ReturnType<typeof setTimeout>
}
export interface AttachmentImportLease {
  readonly filename: string; readonly size: number
  read(offset: number, length: number): Promise<Buffer>
  finish(): Promise<void>
  close(): Promise<void>
}
const refused = (): never => { throw new ServiceProtocolError('INVALID_REQUEST') }
/** Native-only offers. Public path strings cannot create or extend authority. */
export class AttachmentSelectionOwner {
  private readonly entries = new Map<string, Entry>()
  private readonly used = new Set<string>()
  private stopped = false
  constructor(private readonly bridge: AttachmentSelectionBridge, private readonly assertCurrent: () => void, private readonly now = () => performance.now()) {}
  offer(value: unknown): { accepted: boolean } {
    if (this.stopped || !isSelectionOffer(value) || this.entries.size + value.selections.length > 16 || this.used.size + value.selections.length > 4096) return { accepted: false }
    this.assertCurrent()
    const replaced = [...this.entries.values()].filter(e => e.leaseId === value.leaseId && value.selections.some(v => v.path === e.value.path))
    if (value.selections.some(v => this.used.has(v.selectionId)) || replaced.some(e => e.claimed && !e.cancelled)) return { accepted: false }
    // A fresh actual chooser selection supersedes an unclaimed copy of the
    // same display path. Failed old cleanup remains retained by this owner.
    for (const entry of replaced) { entry.cancelled = true; void this.retire(entry).catch(() => {}) }
    for (const selection of value.selections) {
      const entry: Entry = { value: Object.freeze({ ...selection }), leaseId: value.leaseId, expires: this.now() + 300000, claimed: false, cancelled: false, raw: new Set(), timer: setTimeout(() => { entry.cancelled = true; void this.retire(entry).catch(() => {}) }, 300000) }
      this.used.add(selection.selectionId); this.entries.set(selection.selectionId, entry)
    }
    return { accepted: true }
  }
  /** Claim synchronously under the caller's exact captured task/project fence. */
  claim(path: string, leaseId: string, beforeEffect: () => void): AttachmentImportLease {
    this.assertCurrent(); beforeEffect()
    const entry = [...this.entries.values()].find(e => !e.cancelled && e.leaseId === leaseId && e.value.path === path)
    if (!entry) return refused()
    this.current(entry, beforeEffect)
    if (entry.claimed) return refused()
    entry.claimed = true
    let offset = 0, reading = false
    return Object.freeze({ filename: entry.value.filename, size: entry.value.size,
      read: async (position: number, length: number) => {
        this.current(entry, beforeEffect)
        if (reading || position !== offset || !Number.isSafeInteger(length) || length < 1 || length > 65536 || position + length > entry.value.size) return refused()
        reading = true
        const raw = Promise.resolve().then(async () => {
          this.current(entry, beforeEffect)
          const result = await this.bridge.read({ leaseId, selectionId: entry.value.selectionId, offset: position, length })
          this.current(entry, beforeEffect)
          if (typeof result.data !== 'string' || result.data.length > 87384) return refused()
          const bytes = Buffer.from(result.data, 'base64')
          if (bytes.length !== length || bytes.toString('base64') !== result.data) return refused()
          offset += length; return bytes
        }).finally(() => { reading = false })
        entry.raw.add(raw); void raw.then(() => entry.raw.delete(raw), () => { entry.cancelled = true; entry.raw.delete(raw) })
        return raw
      },
      finish: async () => {
        this.current(entry, beforeEffect)
        if (reading || offset !== entry.value.size) return refused()
        const raw = Promise.resolve().then(async () => { this.current(entry, beforeEffect); const result = await this.bridge.finish({ leaseId, selectionId: entry.value.selectionId }); this.current(entry, beforeEffect); if (result.verified !== true) refused() })
        entry.raw.add(raw); void raw.then(() => entry.raw.delete(raw), () => { entry.cancelled = true; entry.raw.delete(raw) }); return raw
      },
      close: () => { entry.cancelled = true; return this.retire(entry) }
    })
  }
  stop(): void { this.stopped = true; for (const e of this.entries.values()) { e.cancelled = true; clearTimeout(e.timer) } }
  async close(timeoutMs = 3000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid selection close deadline')
    this.stop(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([(async () => { let failure: unknown; for (const entry of this.entries.values()) { try { await this.retire(entry) } catch (error) { failure ??= error } } if (failure) throw failure })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private current(entry: Entry, beforeEffect: () => void): void { this.assertCurrent(); beforeEffect(); if (this.stopped || entry.cancelled || this.now() >= entry.expires || this.entries.get(entry.value.selectionId) !== entry) refused() }
  private retire(entry: Entry): Promise<void> {
    if (this.entries.get(entry.value.selectionId) !== entry) return Promise.resolve()
    if (entry.retiring) return entry.retiring
    clearTimeout(entry.timer)
    const raw = (async () => {
      await Promise.allSettled([...entry.raw])
      const result = await this.bridge.retire({ leaseId: entry.leaseId, selectionId: entry.value.selectionId })
      if (result.retired !== true) refused()
      this.entries.delete(entry.value.selectionId)
    })()
    entry.retiring = raw; void raw.then(() => {}, () => { if (entry.retiring === raw) entry.retiring = undefined }); return raw
  }
}
