import type { VoiceSessionManagerCore } from '../main/voice/voice-session-manager-core'
import type { VoiceSpeechService } from '../main/voice/voice-speech-service'
import { VOICE_MANAGEMENT_CODECS, VOICE_MANAGEMENT_OPERATIONS, VOICE_MANAGEMENT_EVENTS, VOICE_MANAGEMENT_EVENT_CODECS, VOICE_MANAGEMENT_LIMITS, type VoiceManagementCodec, type VoiceManagementOperation } from '../shared/voice-management-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

export interface VoiceManagementOwners { voice: VoiceSessionManagerCore; speech: VoiceSpeechService }
export interface VoiceManagementBackendOptions extends VoiceManagementOwners {
  engineEpoch: string
  assertAvailable(): void
  /** Actual core/speech/database/agent/model/runtime/worker/profile identities. */
  assertVoiceOwners(owners: VoiceManagementOwners): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
  canManageVoice(caller: DesktopCallerContext, access: 'read' | 'write'): boolean
}
const READS = new Set<VoiceManagementOperation>(['voice:getSnapshot', 'voice:getRuntime', 'voice:tts:getSnapshot'])
/** Finite management controls. Actual owners retain model/download/worker work;
 * this backend retains accepted requests and never replays them after disconnect. */
export class VoiceManagementBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private mutating = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: VoiceManagementBackendOptions) {
    this.available()
    if (options.voice.speech !== options.speech || typeof options.voice.runManagementMutation !== 'function' || typeof options.speech.runManagementMutation !== 'function') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of VOICE_MANAGEMENT_OPERATIONS) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid voice management shutdown deadline')
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(VOICE_MANAGEMENT_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && VOICE_MANAGEMENT_CODECS[operation].validateArguments(VOICE_MANAGEMENT_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: VOICE_MANAGEMENT_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  hasEvent(operation: string): operation is typeof VOICE_MANAGEMENT_EVENTS[number] { return (VOICE_MANAGEMENT_EVENTS as readonly string[]).includes(operation) }
  encodeEvent<K extends typeof VOICE_MANAGEMENT_EVENTS[number]>(operation: K, value: unknown): JsonValue {
    this.available(); return VOICE_MANAGEMENT_EVENT_CODECS[operation].encodePayload(value)
  }
  projectEvent(operation: string, value: JsonValue, caller: DesktopCallerContext): JsonValue | undefined {
    if (!this.hasEvent(operation) || !this.allowed(caller, 'read')) return undefined
    this.available()
    if (!VOICE_MANAGEMENT_EVENT_CODECS[operation].validatePayload(value)) throw new ServiceProtocolError('INVALID_RESULT')
    return value
  }
  private available(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable(); this.options.assertVoiceOwners({ voice: this.options.voice, speech: this.options.speech })
    if (this.options.voice.speech !== this.options.speech) throw new ServiceProtocolError('DISCONNECTED')
  }
  private allowed(caller: DesktopCallerContext, access: 'read' | 'write'): boolean {
    return caller.principal === 'trusted-desktop-main' && caller.engineEpoch === this.options.engineEpoch && !!caller.webviewId && !!caller.origin && this.options.isTrustedDesktop(caller) && this.options.canManageVoice(caller, 'read') && this.options.canManageVoice(caller, access)
  }
  private retain<T>(work: Promise<T>): Promise<T> { this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work }
  private bind<K extends VoiceManagementOperation>(operation: K): void {
    const codec = VOICE_MANAGEMENT_CODECS[operation] as VoiceManagementCodec<K>, access = READS.has(operation) ? 'read' : 'write'
    this.registry.bindCommand(operation, { decodeRequest: value => codec.decodeArguments(structuredClone(value)), validateArguments: codec.validateArguments,
      authorize: (_args, caller) => { this.available(); return this.allowed(caller, access) },
      invoke: (args, caller, signal) => this.retain((async () => {
        if (this.flights.size >= VOICE_MANAGEMENT_LIMITS.requests) throw new ServiceProtocolError('BACKPRESSURE')
        const beforeWrite = (): void => { this.available(signal); if (!this.allowed(caller, access)) throw new ServiceProtocolError('INVALID_REQUEST') }
        beforeWrite()
        // The installer lacks a verified fixed runtime package manifest. This
        // explicit refusal must precede leases, npm, downloads or setting writes.
        if (operation === 'voice:installRuntime') throw new ServiceProtocolError('UNKNOWN_OPERATION')
        const effect = (): Promise<unknown> => this.execute(operation, args as unknown[])
        let raw: unknown
        if (READS.has(operation)) raw = await effect()
        else {
          if (this.mutating) throw new ServiceProtocolError('BACKPRESSURE')
          this.mutating = true
          try { raw = await this.options.voice.runManagementMutation(effect, beforeWrite) }
          finally { this.mutating = false }
        }
        beforeWrite()
        const projected = codec.encodeResult(raw)
        return codec.decodeResult(projected.defined ? projected.value : undefined)
      })()), validateResult: codec.validateResult, encodeResult: codec.encodeResult })
  }
  private async execute(operation: VoiceManagementOperation, args: unknown[]): Promise<unknown> {
    const { voice, speech } = this.options
    switch (operation) {
      case 'voice:getSnapshot': return voice.snapshot()
      case 'voice:setEnabled': return voice.setEnabled(args[0] as boolean)
      case 'voice:getRuntime': return voice.refreshRuntime()
      case 'voice:removeRuntime': return voice.removeRuntime()
      case 'voice:installModel': return voice.installModel(args[0] as string)
      case 'voice:removeModel': return voice.removeModel(args[0] as string)
      case 'voice:selectModel': return voice.selectModel(args[0] as string)
      case 'voice:removeAllModels': await voice.removeAllModels(); return { success: true }
      case 'voice:setEndpointSilence': await voice.setEndpointSilence(args[0] as number); return { success: true }
      case 'voice:tts:getSnapshot': return speech.snapshot()
      case 'voice:tts:setEnabled': return speech.setEnabled(args[0] as boolean)
      case 'voice:tts:setEngine': return speech.setEngine(args[0] as 'system' | 'local')
      case 'voice:tts:setVoice': {
        const snapshot = await speech.snapshot()
        if (args[0] !== '' && !snapshot.voices.some(item => item.id === args[0])) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        return speech.setVoice(args[0] as string)
      }
      case 'voice:tts:setSpeed': return speech.setSpeed(args[0] as number)
      case 'voice:tts:setMaxChars': return speech.setMaxChars(args[0] as number)
      case 'voice:tts:setSpeakActionResults': return speech.setSpeakActionResults(args[0] as boolean)
      case 'voice:tts:setOnlyVoiceTurns': return speech.setOnlyVoiceTurns(args[0] as boolean)
      case 'voice:tts:installModel': return speech.installModel(args[0] as string)
      case 'voice:tts:selectModel': return speech.selectModel(args[0] as string)
      case 'voice:tts:removeModel': return speech.removeModel(args[0] as string)
      default: throw new ServiceProtocolError('UNKNOWN_OPERATION')
    }
  }
}
