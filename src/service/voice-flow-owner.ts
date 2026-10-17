import { randomUUID } from 'node:crypto'
import {
  NATIVE_VOICE_HOST_SCHEMAS,
  NATIVE_VOICE_LIMITS,
  isNativeVoiceAudio,
  isNativeVoiceBinding,
  isNativeVoiceEvent,
  isNativeVoiceLeaseRequest,
  isNativeVoiceRegistration,
  isVoiceAccelerator,
  voicePcmByteLength,
  type NativeVoiceAudio,
  type NativeVoiceBinding,
  type NativeVoiceBridge,
  type NativeVoiceEvent,
  type NativeVoiceRegistration
} from '../shared/voice-native-callbacks'

export interface VoiceFlowLease {
  readonly voiceLeaseId: string
  permission(): Promise<'granted' | 'denied' | 'unavailable'>
  bind(
    binding:
      | Omit<Extract<NativeVoiceBinding, { turnId: string }>, 'voiceLeaseId'>
      | Omit<Extract<NativeVoiceBinding, { speechId: string }>, 'voiceLeaseId'>
  ): Promise<void>
  shortcut(accelerator: string): Promise<void>
  publish(event: NativeVoiceEvent): Promise<boolean>
  /** Joins raw registration, native work and consumer cleanup, including retry. */
  close(): Promise<void>
}
export interface VoiceFlowConsumer {
  /** Captured source/project/task/intent fence; never callback-selected IDs. */
  beforeEffect(): void
  onAudio?(pcm: Buffer): void
  onHotkey?(): void
  /** Synchronous admission fence only; do not await native retirement here. */
  onRevoked?(): void
  /** Joins only this consumer's raw work; never closes a borrowed global owner. */
  join?(): Promise<void>
}
interface Entry {
  request: NativeVoiceRegistration
  consumer: VoiceFlowConsumer
  ready: boolean
  cancelled: boolean
  permissionRequested: boolean
  bindRequested: boolean
  shortcutRequested: boolean
  shortcutReady: boolean
  binding?: NativeVoiceBinding
  sequence: number
  inputBytes: number
  outputBytes: number
  nextChunk: number
  speechStarted: boolean
  speechEnded: boolean
  pending: number
  pendingBytes: number
  expires: number
  timer: ReturnType<typeof setTimeout>
  registration: Promise<void>
  operations: Set<Promise<unknown>>
  tail: Promise<unknown>
  retirement?: Promise<void>
}
const unavailable = (): Error => new Error('VOICE_FLOW_UNAVAILABLE')

/** Optional private Source consumer. A bridge/receipt is not proof of native
 * microphone or playback availability; only the sealed host can supply that. */
export class VoiceFlowOwner {
  private closing = false
  private admitted = 0
  private readonly ids = new Set<string>()
  private readonly entries = new Map<string, Entry>()
  private readonly native: NativeVoiceBridge
  constructor(
    native: NativeVoiceBridge,
    private readonly assertCurrent: () => void,
    private readonly now = () => performance.now()
  ) {
    if (
      ['acquire', 'permission', 'bind', 'shortcut', 'publish', 'retire'].some(
        (key) => typeof native[key as keyof NativeVoiceBridge] !== 'function'
      )
    )
      throw unavailable()
    this.native = Object.freeze({
      acquire: native.acquire.bind(native),
      permission: native.permission.bind(native),
      bind: native.bind.bind(native),
      shortcut: native.shortcut.bind(native),
      publish: native.publish.bind(native),
      retire: native.retire.bind(native)
    })
  }
  get inflightCount(): number {
    return this.entries.size
  }
  async acquire(
    input: Omit<NativeVoiceRegistration, 'voiceLeaseId'>,
    consumer: VoiceFlowConsumer,
    onOwnedLease?: (lease: VoiceFlowLease) => void
  ): Promise<VoiceFlowLease> {
    this.requireOpen()
    this.assertCurrent()
    consumer.beforeEffect()
    if (this.entries.size >= NATIVE_VOICE_LIMITS.active || this.admitted >= NATIVE_VOICE_LIMITS.epochIds)
      throw new Error('VOICE_FLOW_CAPACITY')
    const request = { ...input, voiceLeaseId: randomUUID() }
    if (!isNativeVoiceRegistration(request) || this.ids.has(request.voiceLeaseId)) throw unavailable()
    this.ids.add(request.voiceLeaseId)
    this.admitted++
    const entry: Entry = {
      request,
      consumer: Object.freeze({
        beforeEffect: consumer.beforeEffect.bind(consumer),
        onAudio: consumer.onAudio?.bind(consumer),
        onHotkey: consumer.onHotkey?.bind(consumer),
        onRevoked: consumer.onRevoked?.bind(consumer),
        join: consumer.join?.bind(consumer)
      }),
      ready: false,
      cancelled: false,
      permissionRequested: false,
      bindRequested: false,
      shortcutRequested: false,
      shortcutReady: false,
      sequence: 0,
      inputBytes: 0,
      outputBytes: 0,
      nextChunk: 0,
      speechStarted: false,
      speechEnded: false,
      pending: 0,
      pendingBytes: 0,
      expires: this.now() + request.ttlMs,
      timer: setTimeout(() => {
        this.cancel(entry)
        this.scheduleRetirement(entry)
      }, request.ttlMs),
      registration: Promise.resolve(),
      operations: new Set(),
      tail: Promise.resolve()
    }
    this.entries.set(request.voiceLeaseId, entry)
    entry.registration = Promise.resolve().then(async () => {
      this.current(entry)
      const result = await this.native.acquire(structuredClone(request))
      this.receipt('acquire', result, entry)
      this.current(entry)
      entry.ready = true
    })
    const lease: VoiceFlowLease = Object.freeze({
      voiceLeaseId: request.voiceLeaseId,
      permission: () => this.permission(entry),
      bind: (binding) => this.bind(entry, binding),
      shortcut: (key) => this.shortcut(entry, key),
      publish: (event) => this.publish(entry, event),
      close: () => {
        this.cancel(entry)
        return this.retire(entry)
      }
    })
    // The observer records cleanup ownership only. Every effect stays refused
    // until registration and the post-ack captured authority check succeed.
    try {
      onOwnedLease?.(lease)
      await entry.registration
    } catch (error) {
      this.cancel(entry)
      await this.retire(entry)
      throw error
    }
    return lease
  }
  deliverAudio(value: unknown): { accepted: boolean } {
    if (!isNativeVoiceAudio(value)) return { accepted: false }
    const entry = this.entries.get(value.voiceLeaseId)
    if (
      !entry ||
      entry.request.purpose !== 'capture' ||
      !entry.binding ||
      !('turnId' in entry.binding) ||
      entry.binding.turnId !== value.turnId ||
      entry.binding.turnEpoch !== value.turnEpoch ||
      !entry.consumer.onAudio
    )
      return { accepted: false }
    try {
      this.current(entry, true)
      const bytes = voicePcmByteLength(value.pcmBase64)!
      if (value.seq !== entry.sequence + 1 || entry.inputBytes + bytes > NATIVE_VOICE_LIMITS.turnBytes)
        return { accepted: false }
      // Claim before the synchronous worker enqueue. No delivery replay, even
      // if the consumer reports a failure after accepting some of the bytes.
      entry.sequence = value.seq
      entry.inputBytes += bytes
      entry.consumer.onAudio(Buffer.from(value.pcmBase64, 'base64'))
      return { accepted: true }
    } catch {
      this.cancel(entry)
      this.scheduleRetirement(entry)
      return { accepted: false }
    }
  }
  deliverHotkey(value: unknown): { accepted: boolean } {
    const entry = isNativeVoiceLeaseRequest(value) ? this.entries.get(value.voiceLeaseId) : undefined
    if (!entry || entry.request.purpose !== 'shortcut' || !entry.shortcutReady || !entry.consumer.onHotkey)
      return { accepted: false }
    try {
      this.current(entry, true)
      entry.consumer.onHotkey()
      return { accepted: true }
    } catch {
      this.cancel(entry)
      this.scheduleRetirement(entry)
      return { accepted: false }
    }
  }
  deliverRevoked(value: unknown): { accepted: boolean } {
    const entry = isNativeVoiceLeaseRequest(value) ? this.entries.get(value.voiceLeaseId) : undefined
    if (!entry || entry.cancelled) return { accepted: false }
    this.cancel(entry)
    this.scheduleRetirement(entry)
    return { accepted: true }
  }
  stop(): void {
    this.closing = true
    for (const entry of this.entries.values()) {
      this.cancel(entry)
      this.scheduleRetirement(entry)
    }
  }
  async close(timeoutMs = 3000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000)
      throw new Error('VOICE_FLOW_DEADLINE_INVALID')
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([...this.entries.values()].map((entry) => this.retire(entry))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('VOICE_FLOW_DRAIN_BLOCKED')), timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  private requireOpen(): void {
    if (this.closing) throw unavailable()
  }
  private current(entry: Entry, ready = false): void {
    this.requireOpen()
    this.assertCurrent()
    entry.consumer.beforeEffect()
    if (
      entry.cancelled ||
      this.entries.get(entry.request.voiceLeaseId) !== entry ||
      this.now() >= entry.expires ||
      (ready && !entry.ready)
    )
      throw unavailable()
  }
  private receipt(operation: keyof NativeVoiceBridge, value: unknown, entry: Entry): void {
    if (
      !NATIVE_VOICE_HOST_SCHEMAS['host.voice.' + operation].validateResult(value) ||
      (value as { voiceLeaseId: string }).voiceLeaseId !== entry.request.voiceLeaseId
    )
      throw unavailable()
  }
  private ready(entry: Entry): void {
    // Early ownership observers may record cleanup without cancelling a pending
    // acquire. Once ready, withdrawal must synchronously stop its consumer.
    if (!entry.ready) throw unavailable()
    try {
      this.current(entry, true)
    } catch (error) {
      this.cancel(entry)
      this.scheduleRetirement(entry)
      throw error
    }
  }
  private own<T>(entry: Entry, effect: () => Promise<T>): Promise<T> {
    const raw = Promise.resolve()
      .then(effect)
      .catch((error) => {
        this.cancel(entry)
        this.scheduleRetirement(entry)
        throw error
      })
    entry.operations.add(raw)
    void raw.then(
      () => entry.operations.delete(raw),
      () => entry.operations.delete(raw)
    )
    return raw
  }
  private permission(entry: Entry): Promise<'granted' | 'denied' | 'unavailable'> {
    try {
      this.ready(entry)
      if (entry.request.purpose !== 'permission' || entry.permissionRequested) throw unavailable()
      entry.permissionRequested = true
    } catch (error) {
      return Promise.reject(error)
    }
    return this.own(entry, async () => {
      this.current(entry, true)
      const result = await this.native.permission({ voiceLeaseId: entry.request.voiceLeaseId })
      this.receipt('permission', result, entry)
      this.current(entry, true)
      return result.status
    })
  }
  private bind(entry: Entry, binding: Parameters<VoiceFlowLease['bind']>[0]): Promise<void> {
    const request = { ...binding, voiceLeaseId: entry.request.voiceLeaseId }
    try {
      this.ready(entry)
      if (
        !isNativeVoiceBinding(request) ||
        entry.bindRequested ||
        !(
          (entry.request.purpose === 'capture' && 'turnId' in request) ||
          (entry.request.purpose === 'playback' && 'speechId' in request)
        )
      )
        throw unavailable()
      entry.bindRequested = true
    } catch (error) {
      return Promise.reject(error)
    }
    return this.own(entry, async () => {
      this.current(entry, true)
      const result = await this.native.bind(request)
      this.receipt('bind', result, entry)
      this.current(entry, true)
      entry.binding = Object.freeze({ ...request })
    })
  }
  private shortcut(entry: Entry, accelerator: string): Promise<void> {
    try {
      this.ready(entry)
      if (entry.request.purpose !== 'shortcut' || entry.shortcutRequested || !isVoiceAccelerator(accelerator))
        throw unavailable()
      entry.shortcutRequested = true
    } catch (error) {
      return Promise.reject(error)
    }
    return this.own(entry, async () => {
      this.current(entry, true)
      const result = await this.native.shortcut({ voiceLeaseId: entry.request.voiceLeaseId, accelerator })
      this.receipt('shortcut', result, entry)
      this.current(entry, true)
      entry.shortcutReady = true
    })
  }
  private publish(entry: Entry, value: NativeVoiceEvent): Promise<boolean> {
    let bytes: number
    try {
      this.current(entry, true)
      if (!isNativeVoiceEvent(value)) throw unavailable()
      const binding = entry.binding
      if (entry.request.purpose === 'shortcut') {
        if (!entry.shortcutReady || value.type !== 'hotkey') throw unavailable()
      } else if (
        !binding ||
        ('turnId' in binding
          ? !('turnId' in value) || value.turnId !== binding.turnId || value.turnEpoch !== binding.turnEpoch
          : !('speechId' in value) ||
            value.speechId !== binding.speechId ||
            value.speechGeneration !== binding.speechGeneration)
      )
        throw unavailable()
      bytes = Buffer.byteLength(JSON.stringify({ voiceLeaseId: entry.request.voiceLeaseId, event: value }))
      if (
        bytes > NATIVE_VOICE_LIMITS.eventBytes ||
        entry.pending >= NATIVE_VOICE_LIMITS.pending ||
        entry.pendingBytes + bytes > NATIVE_VOICE_LIMITS.pendingBytes
      )
        throw unavailable()
      if ('speechId' in value) {
        if (
          entry.speechEnded ||
          (value.type === 'speech-start' && entry.speechStarted) ||
          (value.type !== 'speech-start' && !entry.speechStarted)
        )
          throw unavailable()
        if (value.type === 'speech-start') entry.speechStarted = true
        if (value.type === 'speech-chunk') {
          const pcmBytes = voicePcmByteLength(value.pcmBase64, 128 * 1024)!
          if (value.index !== entry.nextChunk || entry.outputBytes + pcmBytes > 57600000) throw unavailable()
          entry.nextChunk++
          entry.outputBytes += pcmBytes
        }
        if (value.type === 'speech-end') entry.speechEnded = true
      }
    } catch (error) {
      this.cancel(entry)
      this.scheduleRetirement(entry)
      return Promise.reject(error)
    }
    const event = structuredClone(value),
      previous = entry.tail
    entry.pending++
    entry.pendingBytes += bytes
    const raw = this.own(entry, async () => {
      await previous
      this.current(entry, true)
      const result = await this.native.publish({ voiceLeaseId: entry.request.voiceLeaseId, event })
      this.receipt('publish', result, entry)
      this.current(entry, true)
      if (!result.delivered) {
        this.cancel(entry)
        this.scheduleRetirement(entry)
      }
      return result.delivered
    }).finally(() => {
      entry.pending--
      entry.pendingBytes -= bytes
    })
    entry.tail = raw
    // Rejecting output can arrive before the producer has attached its waiter.
    void raw.catch(() => {})
    return raw
  }
  private cancel(entry: Entry): void {
    if (entry.cancelled) return
    entry.cancelled = true
    clearTimeout(entry.timer)
    try {
      entry.consumer.onRevoked?.()
    } catch {
      /* A failed consumer fence cannot release ownership. */
    }
  }
  private scheduleRetirement(entry: Entry): void {
    void this.retire(entry).catch(() => {})
  }
  private retire(entry: Entry): Promise<void> {
    if (this.entries.get(entry.request.voiceLeaseId) !== entry) return Promise.resolve()
    if (entry.retirement) return entry.retirement
    const raw = Promise.resolve().then(async () => {
      // Start native revocation before joining a held permission/open call; its
      // raw completion may require revocation. Native tombstones fence a late
      // acquire. No delivery handler awaits this path.
      const native = Promise.resolve()
        .then(() => this.native.retire({ voiceLeaseId: entry.request.voiceLeaseId }))
        .then((result) => this.receipt('retire', result, entry))
      const source = Promise.resolve().then(() => entry.consumer.join?.())
      const settled = await Promise.allSettled([native, source, entry.registration, ...entry.operations])
      // Register/method failure does not prevent acknowledged cleanup. Failed
      // native/consumer cleanup does retain this exact entry for explicit retry.
      for (const result of settled.slice(0, 2)) if (result.status === 'rejected') throw result.reason
      this.entries.delete(entry.request.voiceLeaseId)
    })
    entry.retirement = raw
    void raw.catch(() => {
      if (entry.retirement === raw) entry.retirement = undefined
    })
    return raw
  }
}
export type { NativeVoiceAudio }
