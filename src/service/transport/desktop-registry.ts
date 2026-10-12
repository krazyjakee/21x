import { DESKTOP_OPERATION_MANIFEST, type DesktopCommandMap, type DesktopEventMap } from '../../shared/desktop-operations'
import { ServiceProtocolError, isJsonValue, type JsonValue } from '../../shared/service-protocol'
import { isOptionalResult, type OptionalResult } from '../../shared/host-services'

export interface DesktopCallerContext {
  /** Obtained from the native host/private pipe; never taken from request arguments. */
  principal: 'trusted-desktop-main' | 'service' | 'native-host'
  engineEpoch: string
  webviewId?: string
  origin?: string
}
export interface DesktopCommandBinding<K extends keyof DesktopCommandMap> {
  /** Preserve the legacy preload transformation and explicit missing/null/byte semantics. */
  decodeRequest: (payload: JsonValue) => unknown
  validateArguments: (args: unknown) => boolean
  authorize: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext) => boolean | Promise<boolean>
  invoke: (args: DesktopCommandMap[K]['apiArguments'], caller: DesktopCallerContext, signal: AbortSignal) =>
    DesktopCommandMap[K]['result'] | Promise<DesktopCommandMap[K]['result']>
  validateResult: (result: unknown) => boolean
  encodeResult: (result: DesktopCommandMap[K]['result']) => OptionalResult<JsonValue>
}
export interface DesktopEventBinding<K extends keyof DesktopEventMap> {
  validatePayload: (payload: unknown) => boolean
  encodePayload: (payload: DesktopEventMap[K]) => JsonValue
}
interface ErasedCommandBinding {
  run: (payload: JsonValue, caller: DesktopCallerContext, signal: AbortSignal) => Promise<JsonValue>
}

/** Exact names plus mandatory schemas and authority. A manifest is never itself a grant. */
export class DesktopOperationRegistry {
  private readonly commands = new Map<string, ErasedCommandBinding>()
  private readonly events = new Map<string, (payload: unknown) => JsonValue>()

  constructor(private readonly config: {
    owner: 'service' | 'native-host'
    engineEpoch: string
    /** Must check the actual WebView label/origin/frame using host-established identity. */
    isTrustedDesktop: (caller: DesktopCallerContext) => boolean
  }) {}

  bindCommand<K extends keyof DesktopCommandMap>(operation: K, binding: DesktopCommandBinding<K>): void {
    this.descriptor('command', operation)
    if (this.commands.has(operation) || !binding ||
      !['decodeRequest', 'validateArguments', 'authorize', 'invoke', 'validateResult', 'encodeResult']
        .every(key => typeof binding[key as keyof DesktopCommandBinding<K>] === 'function')) {
      throw new ServiceProtocolError('INVALID_ARGUMENTS')
    }
    this.commands.set(operation, { run: async (payload, caller, signal) => {
      let args: unknown
      try { args = binding.decodeRequest(payload); if (!binding.validateArguments(args)) throw new Error() }
      catch { throw new ServiceProtocolError('INVALID_ARGUMENTS') }
      let authorized = false
      try { authorized = await binding.authorize(args as DesktopCommandMap[K]['apiArguments'], caller) }
      catch { throw new ServiceProtocolError('INVALID_REQUEST') }
      if (!authorized) throw new ServiceProtocolError('INVALID_REQUEST')
      if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
      let result: DesktopCommandMap[K]['result']
      try { result = await binding.invoke(args as DesktopCommandMap[K]['apiArguments'], caller, signal) }
      catch (error) { throw error instanceof ServiceProtocolError ? error : new ServiceProtocolError('INTERNAL_ERROR') }
      if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
      try {
        if (!binding.validateResult(result)) throw new Error()
        const encoded = binding.encodeResult(result)
        if (!isOptionalResult(encoded) || !isJsonValue(encoded) || (result === undefined) !== (encoded.defined === false)) throw new Error()
        return encoded
      } catch { throw new ServiceProtocolError('INVALID_RESULT') }
    } })
  }

  async invoke(operation: string, payload: JsonValue, caller: DesktopCallerContext, signal: AbortSignal): Promise<JsonValue> {
    this.descriptor('command', operation)
    if (caller.engineEpoch !== this.config.engineEpoch) throw new ServiceProtocolError('STALE_EPOCH')
    let trusted = false
    try { trusted = caller.principal === 'trusted-desktop-main' && this.config.isTrustedDesktop(caller) }
    catch { /* Fail closed without reflecting native identity diagnostics. */ }
    if (!trusted) throw new ServiceProtocolError('INVALID_REQUEST')
    try { if (!isJsonValue(payload)) throw new Error() }
    catch { throw new ServiceProtocolError('INVALID_ARGUMENTS') }
    if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
    const binding = this.commands.get(operation)
    if (!binding) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    return binding.run(payload, caller, signal)
  }

  bindEvent<K extends keyof DesktopEventMap>(operation: K, binding: DesktopEventBinding<K>): void {
    this.descriptor('event', operation)
    if (this.events.has(operation) || typeof binding?.validatePayload !== 'function' || typeof binding?.encodePayload !== 'function') {
      throw new ServiceProtocolError('INVALID_ARGUMENTS')
    }
    this.events.set(operation, payload => {
      try {
        if (!binding.validatePayload(payload)) throw new Error()
        const encoded = binding.encodePayload(payload as DesktopEventMap[K])
        if (!isJsonValue(encoded)) throw new Error()
        return encoded
      } catch { throw new ServiceProtocolError('INVALID_ARGUMENTS') }
    })
  }

  /** Returns only payload bytes/data for a separately authorized, targeted desktop sink. */
  encodeEvent(operation: string, payload: unknown, producer: DesktopCallerContext): JsonValue {
    this.descriptor('event', operation)
    if (producer.engineEpoch !== this.config.engineEpoch) throw new ServiceProtocolError('STALE_EPOCH')
    if (producer.principal !== this.config.owner) throw new ServiceProtocolError('INVALID_REQUEST')
    const encode = this.events.get(operation)
    if (!encode) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    return encode(payload)
  }

  missingBindings(): string[] {
    return Object.entries(DESKTOP_OPERATION_MANIFEST).filter(([, item]) => item.owner === this.config.owner && item.disposition === 'retained')
      .filter(([, item]) => !(item.kind === 'command' ? this.commands : this.events).has(item.name)).map(([key]) => key)
  }

  private descriptor(kind: 'command' | 'event', operation: string): void {
    const key = `${kind}/${operation}`
    if (!Object.hasOwn(DESKTOP_OPERATION_MANIFEST, key)) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    const item = DESKTOP_OPERATION_MANIFEST[key as keyof typeof DESKTOP_OPERATION_MANIFEST]
    if (item.disposition !== 'retained' || item.owner !== this.config.owner) throw new ServiceProtocolError('UNKNOWN_OPERATION')
  }
}
