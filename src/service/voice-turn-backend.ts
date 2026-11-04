import type { VoiceSessionManagerCore } from '../main/voice/voice-session-manager-core'
import type { CommanderVoice } from '../main/voice/commander-voice'
import type { VoiceTurnMode, VoiceUiContext } from '../shared/voice'
import { VOICE_TURN_CODECS, VOICE_TURN_EVENTS, VOICE_TURN_EVENT_CODECS, type VoiceTurnCodec, type VoiceTurnEvent, type VoiceTurnOperation } from '../shared/voice-turn-codecs'
import { isJsonValue, ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { DesktopOperationRegistry, type DesktopCallerContext } from './transport/desktop-registry'
import type { OperationSchema } from './transport/peer'

/**
 * The live voice operations the Tauri window calls: microphone turns,
 * confirmations, spoken answers and Commander voice mode.
 *
 * Every decision stays in VoiceSessionManagerCore, exactly as under Electron;
 * this backend only checks the caller and passes the call through. Audio is
 * never stored. Shortcut registration is not bound until the native host can
 * register a global shortcut.
 */
export const VOICE_TURN_BOUND_OPERATIONS = ['voice:startTurn', 'voice:pushAudio', 'voice:endTurn', 'voice:cancelTurn',
  'voice:confirm', 'voice:dismiss', 'voice:expectAnswer', 'voice:answerNotExpected', 'voice:tts:preview', 'voice:tts:speak', 'voice:tts:stop',
  'voice:commander:setActive', 'voice:commander:bargeIn', 'voice:commander:send'] as const satisfies readonly VoiceTurnOperation[]
type BoundOperation = typeof VOICE_TURN_BOUND_OPERATIONS[number]

export interface VoiceTurnBackendOptions {
  voice: VoiceSessionManagerCore
  commanderVoice(): CommanderVoice
  engineEpoch: string
  assertAvailable(): void
  isTrustedDesktop(caller: DesktopCallerContext): boolean
}

export class VoiceTurnBackend {
  readonly registry: DesktopOperationRegistry
  private closing = false
  private readonly flights = new Set<Promise<unknown>>()
  constructor(private readonly options: VoiceTurnBackendOptions) {
    this.registry = new DesktopOperationRegistry({ owner: 'service', engineEpoch: options.engineEpoch, isTrustedDesktop: options.isTrustedDesktop })
    for (const operation of VOICE_TURN_BOUND_OPERATIONS) this.bind(operation)
  }
  get inflightCount(): number { return this.flights.size }
  shutdown(): void { this.closing = true }
  async close(timeoutMs = 2000): Promise<void> {
    this.shutdown(); let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.flights]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  operationSchemas(caller: DesktopCallerContext): Record<string, OperationSchema> {
    return Object.fromEntries(VOICE_TURN_BOUND_OPERATIONS.map(operation => [operation, {
      validatePayload: (value: unknown) => { try { return isJsonValue(value) && VOICE_TURN_CODECS[operation].validateArguments(VOICE_TURN_CODECS[operation].decodeArguments(value)) } catch { return false } },
      validateResult: VOICE_TURN_CODECS[operation].validateWireResult,
      handle: (value: JsonValue, signal: AbortSignal) => this.registry.invoke(operation, value, caller, signal)
    }]))
  }
  hasEvent(operation: string): operation is VoiceTurnEvent { return (VOICE_TURN_EVENTS as readonly string[]).includes(operation) }
  /** Voice events go to the trusted desktop window only, never to mobile. */
  projectEvent(operation: string, value: JsonValue, caller: DesktopCallerContext): JsonValue | undefined {
    if (!this.hasEvent(operation) || !this.allowed(caller) || this.closing) return undefined
    return value
  }
  static encodeEvent(operation: VoiceTurnEvent, value: unknown): JsonValue { return VOICE_TURN_EVENT_CODECS[operation].encodePayload(value) }
  private allowed(caller: DesktopCallerContext): boolean {
    return caller.principal === 'trusted-desktop-main' && caller.engineEpoch === this.options.engineEpoch && !!caller.webviewId && !!caller.origin && this.options.isTrustedDesktop(caller)
  }
  private retain<T>(work: Promise<T>): Promise<T> { this.flights.add(work); void work.then(() => this.flights.delete(work), () => this.flights.delete(work)); return work }
  private bind<K extends BoundOperation>(operation: K): void {
    const codec = VOICE_TURN_CODECS[operation] as VoiceTurnCodec<K>
    this.registry.bindCommand(operation, {
      decodeRequest: value => codec.decodeArguments(structuredClone(value)),
      validateArguments: codec.validateArguments,
      authorize: (_args, caller) => { if (this.closing) return false; this.options.assertAvailable(); return this.allowed(caller) },
      invoke: (args, _caller, signal) => this.retain((async () => {
        if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
        if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
        const raw = await this.execute(operation, args as unknown[])
        const projected = codec.encodeResult(raw)
        return codec.decodeResult(projected.defined ? projected.value : undefined)
      })()),
      validateResult: codec.validateResult,
      encodeResult: codec.encodeResult
    })
  }
  private async execute(operation: BoundOperation, args: unknown[]): Promise<unknown> {
    const { voice } = this.options
    switch (operation) {
      case 'voice:startTurn': return voice.startTurn(args[0] as VoiceTurnMode, args[1] as VoiceUiContext)
      case 'voice:pushAudio': { const chunk = args[1] as Uint8Array; voice.pushAudio(args[0] as string, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)); return undefined }
      case 'voice:endTurn': voice.endTurn(args[0] as string); return undefined
      case 'voice:cancelTurn': voice.cancelTurn(args[0] as string | undefined, args[1] as string | undefined); return undefined
      case 'voice:confirm': await voice.confirm(args[0] as string, args[1] as { taskId?: string; agentName?: string } | undefined, args[2] as string | undefined); return { success: true }
      case 'voice:dismiss': voice.dismiss(args[0] as string, args[1] as string | undefined); return undefined
      case 'voice:expectAnswer': voice.expectSpokenAnswer(args[0] as string, args[1] as string | undefined); return undefined
      case 'voice:answerNotExpected': voice.forgetSpokenAnswer(args[0] as string | undefined); return undefined
      case 'voice:tts:preview': return { spoken: await voice.speakPreview(args[0] as string) }
      case 'voice:tts:speak': return { spoken: await voice.speakText(args[0] as string, args[1] as string | undefined) }
      case 'voice:tts:stop': voice.stopSpeaking(); return undefined
      case 'voice:commander:setActive': {
        const sessionId = args[0] as string | null
        this.options.commanderVoice().setActiveSession(sessionId)
        return { active: sessionId }
      }
      case 'voice:commander:bargeIn': return this.options.commanderVoice().bargeIn(args[0] as string)
      case 'voice:commander:send': return this.options.commanderVoice().send(args[0] as string, args[1] as string)
    }
  }
}
