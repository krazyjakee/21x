import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import {
  SERVICE_LIMITS, SERVICE_ERROR_MESSAGES, ServiceProtocolError, validateServiceFrame,
  isBootstrapResult, isInitializePayload, isJsonValue, isRecord, hasExactKeys,
  type JsonValue, type ServiceFrame, type ServiceRequest, type ServiceResponse
} from './service-protocol'
import { ServiceFrameDecoder, encodeServiceFrame } from '../service/transport/framing'
import { ServicePeer, type OperationSchema } from '../service/transport/peer'

const epoch = 'engine-test'
const encoder = new TextEncoder()
const bootstrapResult = { protocolVersion: 1 as const, engineEpoch: epoch, nodeVersion: 'v22.0.0' }
const request = (id = 'host:1', payload: JsonValue = null): ServiceRequest => ({
  kind: 'request', protocolVersion: 1, engineEpoch: epoch,
  requestId: id as ServiceRequest['requestId'], operation: 'test.echo', payload
})
const response = (id = 'host:1', result: JsonValue = null, engineEpoch = epoch): ServiceResponse => ({
  kind: 'response', protocolVersion: 1, engineEpoch, requestId: id as ServiceResponse['requestId'], result
})
const peers: ServicePeer[] = []
const schema: OperationSchema = { validatePayload: isJsonValue, validateResult: isJsonValue }
const emptyPayload = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, [])
const operations = { 'test.echo': schema, 'engine.ping': { validatePayload: emptyPayload, validateResult: isBootstrapResult } }
function peer(options: Partial<ConstructorParameters<typeof ServicePeer>[0]> = {}): ServicePeer {
  const instance = new ServicePeer({ role: 'host', engineEpoch: epoch,
    write: async () => {}, operations, ...options })
  peers.push(instance)
  return instance
}
async function drain(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve() }
function code(error: unknown): string | undefined { return error instanceof ServiceProtocolError ? error.code : undefined }

afterEach(() => {
  for (const instance of peers.splice(0)) instance.disconnect()
  vi.useRealTimers()
})

describe('graceful peer drain', () => {
  it('waits for active handlers and the final queued response to drain', async () => {
    let releaseWrite: (() => void) | undefined
    const service = peer({ role: 'service', operations: { 'test.echo': { ...schema, handle: payload => payload } }, write: () => new Promise(resolve => { releaseWrite = resolve }) })
    service.receive(encodeServiceFrame(request('host:1', { stopped: true })))
    let finished = false
    const drained = service.drain().then(() => { finished = true })
    await drain()
    expect(finished).toBe(false)
    expect(releaseWrite).toBeTypeOf('function')
    releaseWrite!()
    await drained
    expect(finished).toBe(true)
  })

  it('rejects waiting drains when the peer disconnects', async () => {
    const service = peer({ role: 'service', operations: { 'test.echo': { ...schema, handle: () => new Promise(() => {}) } } })
    service.receive(encodeServiceFrame(request()))
    const drained = service.drain()
    service.disconnect()
    await expect(drained).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })
})

describe('private service envelope', () => {
  it('recognizes the fixed optimistic skill conflict code without diagnostic values', () => {
    const error = new ServiceProtocolError('SKILL_VERSION_CONFLICT')
    expect(error.message).toBe('The skill changed. Reload it before writing.')
    const frame = { kind: 'response', protocolVersion: 1, engineEpoch: epoch, requestId: 'host:1',
      error: { code: error.code, message: error.message } }
    expect(validateServiceFrame(frame)).toEqual(frame)
  })

  it('validates request, response and event envelopes and bootstrap contracts', () => {
    expect(validateServiceFrame(request())).toEqual(request())
    expect(validateServiceFrame(response())).toEqual(response())
    expect(validateServiceFrame({ kind: 'event', protocolVersion: 1, engineEpoch: epoch,
      operation: 'task:updated', payload: { bytes: 'AA==' }, sequence: 0 })).toMatchObject({ sequence: 0 })
    expect(isBootstrapResult(bootstrapResult)).toBe(true)
    expect(isInitializePayload({ protocolVersion: 1, profileRoot: '/isolated', resourceRoot: '/resources' })).toBe(true)
    expect(isInitializePayload({ protocolVersion: 1, profileRoot: '', resourceRoot: '/resources' })).toBe(false)
  })

  it.each([
    { ...request(), unexpected: 'secret' },
    { ...request(), requestId: 'host:0' },
    { ...request(), requestId: 'host:01' },
    { ...request(), requestId: 'service:secret' },
    { ...request(), engineEpoch: 'bad epoch' },
    { ...request(), operation: 'arbitrary operation' },
    { ...response(), error: { code: 'INTERNAL_ERROR', message: 'secret' } },
    { kind: 'response', protocolVersion: 1, engineEpoch: epoch, requestId: 'host:1' },
    { ...response(), result: undefined },
    { ...response(), result: Number.NaN },
    { ...response(), result: new Date() },
    { kind: 'response', protocolVersion: 1, engineEpoch: epoch, requestId: 'host:1',
      error: { code: 'ARBITRARY_SECRET', message: 'secret' } },
    { kind: 'event', protocolVersion: 1, engineEpoch: epoch, operation: 'test', payload: null, sequence: -1 }
  ])('rejects invalid fields without reflecting payloads', value => {
    try { validateServiceFrame(value); expect.fail('Expected rejection') }
    catch (error) { expect(code(error)).toBe('INVALID_FRAME'); expect(String(error)).not.toContain('secret') }
  })

  it('rejects incompatible versions and excessively nested JSON', () => {
    expect(() => validateServiceFrame({ ...request(), protocolVersion: 2 })).toThrow(SERVICE_ERROR_MESSAGES.UNSUPPORTED_VERSION)
    let nested: JsonValue = null
    for (let i = 0; i < 66; i++) nested = [nested]
    expect(() => validateServiceFrame(request('host:1', nested))).toThrow(SERVICE_ERROR_MESSAGES.INVALID_FRAME)
  })
})

describe('NDJSON byte framing', () => {
  it('preserves UTF-8 split inside a multibyte codepoint and coalesced frames', () => {
    const first = encodeServiceFrame(request('host:1', '🌍雪'))
    const second = encodeServiceFrame(request('host:2', { next: true }))
    const joined = new Uint8Array(first.length + second.length)
    joined.set(first); joined.set(second, first.length)
    const decoder = new ServiceFrameDecoder()
    const frames: ServiceFrame[] = []
    for (const byte of joined) decoder.push(Uint8Array.of(byte), frame => frames.push(frame))
    decoder.finish()
    expect(frames).toEqual([request('host:1', '🌍雪'), request('host:2', { next: true })])
    const together: ServiceFrame[] = []
    new ServiceFrameDecoder().push(joined, frame => together.push(frame))
    expect(together).toEqual(frames)
  })

  it.each([encoder.encode('\n'), encoder.encode('{ secret}\n'), Uint8Array.of(0xff, 10),
    encoder.encode('\ufeff{}\n')])('rejects malformed/empty/invalid UTF-8 frames and poisons the decoder', bytes => {
    const decoder = new ServiceFrameDecoder()
    expect(() => decoder.push(bytes, () => {})).toThrow(SERVICE_ERROR_MESSAGES.INVALID_FRAME)
    expect(() => decoder.push(encodeServiceFrame(request()), () => {})).toThrow(SERVICE_ERROR_MESSAGES.DISCONNECTED)
  })

  it('rejects oversized terminated and unterminated input by byte count', () => {
    const bytes = new Uint8Array(SERVICE_LIMITS.frameBytes + 1).fill(32)
    const decoder = new ServiceFrameDecoder()
    decoder.push(bytes.subarray(0, 500), () => {})
    expect(() => decoder.push(bytes.subarray(500), () => {})).toThrow(SERVICE_ERROR_MESSAGES.FRAME_TOO_LARGE)
    const terminated = new Uint8Array(bytes.length + 1)
    terminated.set(bytes); terminated[bytes.length] = 10
    expect(() => new ServiceFrameDecoder().push(terminated, () => {})).toThrow(SERVICE_ERROR_MESSAGES.FRAME_TOO_LARGE)
    expect(() => encodeServiceFrame(request('host:1', '雪'.repeat(SERVICE_LIMITS.frameBytes / 2)))).toThrow(SERVICE_ERROR_MESSAGES.FRAME_TOO_LARGE)
  })

  it('permits exactly the frame limit and rejects a truncated final line', () => {
    const overhead = encodeServiceFrame(request('host:1', '')).length - 1
    const bytes = encodeServiceFrame(request('host:1', 'a'.repeat(SERVICE_LIMITS.frameBytes - overhead)))
    expect(bytes.length).toBe(SERVICE_LIMITS.frameBytes + 1)
    const frames: ServiceFrame[] = []
    new ServiceFrameDecoder().push(bytes, frame => frames.push(frame))
    expect(frames).toHaveLength(1)
    const truncated = new ServiceFrameDecoder()
    truncated.push(bytes.subarray(0, 20), () => {})
    expect(() => truncated.finish()).toThrow(SERVICE_ERROR_MESSAGES.INVALID_FRAME)
  })
})

describe('bidirectional bounded service peer', () => {
  it('bootstraps a host epoch only from the correlated successful response', async () => {
    const host = peer({ engineEpoch: null })
    await expect(host.request('test.echo', null)).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    const pending = host.request('engine.ping', {})
    host.receive(encodeServiceFrame(response('host:99', bootstrapResult)))
    expect(host.engineEpoch).toBeNull()
    host.receive(encodeServiceFrame(response('host:1', bootstrapResult)))
    await expect(pending).resolves.toEqual(bootstrapResult)
    expect(host.engineEpoch).toBe(epoch)
  })

  it('rejects mismatched bootstrap epochs and result schemas', async () => {
    const host = peer({ engineEpoch: null })
    const pending = host.request('engine.ping', {})
    host.receive(encodeServiceFrame(response('host:1', { ...bootstrapResult, engineEpoch: 'other' })))
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(host.engineEpoch).toBeNull()
    const validated = peer({ operations: { 'test.echo': { ...schema, validateResult: value => typeof value === 'number' } } })
    const badResult = validated.request('test.echo', null)
    validated.receive(encodeServiceFrame(response('host:1', 'wrong')))
    await expect(badResult).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  })

  it('processes native callbacks while a service operation is awaiting them', async () => {
    const host = peer({ write: async bytes => service.receive(bytes), operations: {
      'test.echo': schema,
      'native.value': { ...schema, handle: () => 'native result' }
    } })
    const service = peer({ role: 'service', write: async bytes => host.receive(bytes), operations: {
      'test.echo': { ...schema, handle: async () => service.request('native.value', null) },
      'native.value': schema
    } })
    await expect(host.request('test.echo', null)).resolves.toBe('native result')
    expect(host.pendingCount).toBe(0)
    expect(service.pendingCount).toBe(0)
  })

  it('correlates out-of-order responses and ignores stale, duplicate and late responses', async () => {
    const host = peer()
    const first = host.request('test.echo', 1)
    const second = host.request('test.echo', 2)
    host.receive(encodeServiceFrame(response('host:1', 'stale', 'old-engine')))
    expect(host.pendingCount).toBe(2)
    host.receive(encodeServiceFrame(response('host:2', 'second')))
    host.receive(encodeServiceFrame(response('host:1', 'first')))
    host.receive(encodeServiceFrame(response('host:1', 'duplicate')))
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(host.pendingCount).toBe(0)
  })

  it('redacts arbitrary remote and handler error messages', async () => {
    const host = peer()
    const pending = host.request('test.echo', null)
    host.receive(encodeServiceFrame({ kind: 'response', protocolVersion: 1, engineEpoch: epoch,
      requestId: 'host:1', error: { code: 'INTERNAL_ERROR', message: 'credential:super-secret' } }))
    await expect(pending).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: SERVICE_ERROR_MESSAGES.INTERNAL_ERROR })
    const sent: ServiceFrame[] = []
    const decoder = new ServiceFrameDecoder()
    const service = peer({ role: 'service', write: async bytes => decoder.push(bytes, frame => sent.push(frame)),
      operations: { 'test.echo': { ...schema, handle: () => { throw new Error('credential:super-secret') } } } })
    service.receive(encodeServiceFrame(request()))
    await drain()
    expect(sent).toEqual([{ kind: 'response', protocolVersion: 1, engineEpoch: epoch, requestId: 'host:1',
      error: { code: 'INTERNAL_ERROR', message: SERVICE_ERROR_MESSAGES.INTERNAL_ERROR } }])
  })

  it('times out, sends advisory cancellation and never revives a late response', async () => {
    vi.useFakeTimers()
    const sent: ServiceFrame[] = []
    const decoder = new ServiceFrameDecoder()
    const host = peer({ write: async bytes => decoder.push(bytes, frame => sent.push(frame)) })
    const pending = host.request('test.echo', null).catch(error => error)
    await drain()
    await vi.advanceTimersByTimeAsync(SERVICE_LIMITS.requestTimeoutMs)
    expect(code(await pending)).toBe('TIMEOUT')
    expect(host.pendingCount).toBe(0)
    expect(sent.at(-1)).toMatchObject({ kind: 'event', operation: 'engine.cancel', payload: { requestId: 'host:1' } })
    host.receive(encodeServiceFrame(response('host:1', 'late')))
    expect(host.pendingCount).toBe(0)
  })

  it('cancels outbound calls and aborts inbound handlers without releasing uncooperative slots', async () => {
    let signal: AbortSignal | undefined
    const host = peer({ write: async bytes => service.receive(bytes) })
    const service = peer({ role: 'service', write: async bytes => host.receive(bytes),
      operations: { 'test.echo': { ...schema, handle: (_payload, inputSignal) => {
        signal = inputSignal
        return new Promise(() => {})
      } } } })
    const controller = new AbortController()
    const pending = host.request('test.echo', null, { signal: controller.signal }).catch(error => error)
    await drain()
    controller.abort()
    await drain()
    expect(code(await pending)).toBe('CANCELLED')
    expect(signal?.aborted).toBe(true)
    expect(host.pendingCount).toBe(0)
    expect(service.activeCount).toBe(1)
  })

  it('rejects replay, invalid arguments and unknown operations without calling handlers', async () => {
    const handle = vi.fn(() => null)
    const sent: ServiceFrame[] = []
    const decoder = new ServiceFrameDecoder()
    const service = peer({ role: 'service', write: async bytes => decoder.push(bytes, frame => sent.push(frame)),
      operations: { 'test.echo': { ...schema, validatePayload: value => value === null, handle } } })
    service.receive(encodeServiceFrame(request('host:1')))
    await drain()
    service.receive(encodeServiceFrame(request('host:1')))
    service.receive(encodeServiceFrame(request('host:2', 'invalid')))
    service.receive(encodeServiceFrame({ ...request('host:3'), operation: 'unknown' }))
    await drain()
    expect(handle).toHaveBeenCalledTimes(1)
    expect(sent.slice(1).map(frame => frame.kind === 'response' ? frame.error?.code : null))
      .toEqual(['INVALID_REQUEST', 'INVALID_ARGUMENTS', 'UNKNOWN_OPERATION'])
  })

  it('rejects all pending calls on disconnect and never replays them', async () => {
    const write = vi.fn(async () => {})
    const disconnected = vi.fn()
    const host = peer({ write, onDisconnect: disconnected })
    const first = host.request('test.echo', 'mutation').catch(error => error)
    const second = host.request('test.echo', null).catch(error => error)
    host.disconnect(); host.disconnect()
    expect(code(await first)).toBe('DISCONNECTED')
    expect(code(await second)).toBe('DISCONNECTED')
    await expect(host.request('test.echo', null)).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await drain()
    expect(write).toHaveBeenCalledTimes(1)
    expect(disconnected).toHaveBeenCalledTimes(1)
  })

  it('bounds pending calls and queued bytes and disconnects a stalled writer', async () => {
    vi.useFakeTimers()
    const host = peer({ write: () => new Promise(() => {}) })
    const calls = Array.from({ length: SERVICE_LIMITS.pendingRequests }, () => host.request('test.echo', null).catch(error => error))
    await expect(host.request('test.echo', null)).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    expect(host.pendingCount).toBe(SERVICE_LIMITS.pendingRequests)
    await vi.advanceTimersByTimeAsync(SERVICE_LIMITS.requestTimeoutMs)
    expect((await Promise.all(calls)).every(error => ['TIMEOUT', 'BACKPRESSURE'].includes(code(error)!))).toBe(true)
    await expect(host.request('test.echo', null)).rejects.toBeInstanceOf(ServiceProtocolError)
    const byteLimited = peer({ write: () => new Promise(() => {}) })
    const largeCalls = Array.from({ length: 5 }, () => byteLimited.request('test.echo', 'a'.repeat(900_000)).catch(error => error))
    expect(code(await largeCalls[4])).toBe('BACKPRESSURE')
    expect(byteLimited.pendingCount).toBe(4)
    byteLimited.disconnect()
    await Promise.all(largeCalls)
  })

  it('drops an unsent expired mutation rather than sending it when the pipe drains', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const writes: ServiceFrame[] = []
    const decoder = new ServiceFrameDecoder()
    const host = peer({ write: async bytes => {
      decoder.push(bytes, frame => writes.push(frame))
      if (writes.length === 1) await new Promise<void>(resolve => { release = resolve })
    } })
    const first = host.request('test.echo', 'blocking').catch(error => error)
    const mutation = host.request('test.echo', 'must not replay', { timeoutMs: 10 }).catch(error => error)
    await vi.advanceTimersByTimeAsync(10)
    expect(code(await mutation)).toBe('TIMEOUT')
    release()
    await drain()
    expect(writes.some(frame => frame.kind === 'request' && frame.payload === 'must not replay')).toBe(false)
    host.disconnect()
    await first
  })

  it('rejects malformed input and pipe failures with fixed disconnect errors', async () => {
    const disconnected = vi.fn()
    const host = peer({ onDisconnect: disconnected })
    const pending = host.request('test.echo', null).catch(error => error)
    host.receive(encoder.encode('secret malformed frame\n'))
    expect(code(await pending)).toBe('INVALID_FRAME')
    expect(disconnected.mock.calls[0][0].message).not.toContain('secret')
    const broken = peer({ write: async () => { throw new Error('secret pipe error') } })
    await expect(broken.request('test.echo', null)).rejects.toMatchObject({ code: 'DISCONNECTED', message: SERVICE_ERROR_MESSAGES.DISCONNECTED })
  })

  it('bounds queued event frames and validates events before delivering them', () => {
    const onEvent = vi.fn()
    const host = peer({ write: () => new Promise(() => {}), eventSchemas: { 'test.event': value => value === null }, onEvent })
    for (let i = 0; i < SERVICE_LIMITS.queuedFrames; i++) host.emit('test.event', null)
    expect(() => host.emit('test.event', null)).toThrow(SERVICE_ERROR_MESSAGES.BACKPRESSURE)
    expect(() => host.emit('test.event', 'bad')).toThrow(SERVICE_ERROR_MESSAGES.INVALID_ARGUMENTS)
    host.receive(encodeServiceFrame({ kind: 'event', protocolVersion: 1, engineEpoch: 'old-engine', operation: 'test.event', payload: null }))
    expect(onEvent).not.toHaveBeenCalled()
    host.receive(encodeServiceFrame({ kind: 'event', protocolVersion: 1, engineEpoch: epoch, operation: 'test.event', payload: null, sequence: 1 }))
    expect(onEvent).toHaveBeenCalledTimes(1)
    host.receive(encodeServiceFrame({ kind: 'event', protocolVersion: 1, engineEpoch: epoch, operation: 'test.event', payload: 'bad' }))
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('caps uncooperative handlers and rejects a stale request without invoking it', async () => {
    const handle = vi.fn(() => new Promise<JsonValue>(() => {}))
    const sent: ServiceFrame[] = []
    const decoder = new ServiceFrameDecoder()
    const service = peer({ role: 'service', write: async bytes => decoder.push(bytes, frame => sent.push(frame)),
      operations: { 'test.echo': { ...schema, handle } } })
    for (let i = 1; i <= SERVICE_LIMITS.activeRequests + 1; i++) service.receive(encodeServiceFrame(request(`host:${i}`)))
    service.receive(encodeServiceFrame({ ...request('host:130'), engineEpoch: 'old-engine' }))
    await drain()
    expect(service.activeCount).toBe(SERVICE_LIMITS.activeRequests)
    expect(handle).toHaveBeenCalledTimes(SERVICE_LIMITS.activeRequests)
    expect(sent.map(frame => frame.kind === 'response' ? frame.error?.code : null)).toEqual(['BACKPRESSURE', 'STALE_EPOCH'])
  })
})

describe('actual feasibility service wire fixtures', () => {
  function fixture() {
    const profileRoot = '/isolated-protocol-fixture/profile'
    const resourceRoot = '/isolated-protocol-fixture/resources'
    // The legacy suite runs inside Electron-as-Node. Its executable needs an
    // Electron-specific environment flag and cannot serve as this standalone
    // Node fixture. Use the developer/CI Node runtime on PATH explicitly.
    const child = spawn('node', [fileURLToPath(new URL('../service/feasibility.mjs', import.meta.url))], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        TWENTYONEX_PROFILE_ROOT: profileRoot, TWENTYONEX_RESOURCE_ROOT: resourceRoot },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const closed = once(child, 'close')
    let diagnostics = ''
    child.stderr.on('data', (chunk: Uint8Array) => {
      diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(-2048)
    })
    const host = peer({ engineEpoch: null,
      operations: {
        'engine.initialize': { validatePayload: isInitializePayload, validateResult: isBootstrapResult },
        'engine.ping': { validatePayload: emptyPayload, validateResult: isBootstrapResult },
        'engine.shutdown': { validatePayload: emptyPayload,
          validateResult: value => isRecord(value) && hasExactKeys(value, ['stopped']) && value.stopped === true },
        // Locally known but deliberately absent from the fixture service.
        'engine.unknown': schema
      },
      write: bytes => new Promise((resolve, reject) => {
        child.stdin.write(bytes, error => error ? reject(error) : resolve())
      }),
      onDisconnect: () => { child.stdin.destroy() }
    })
    child.stdin.on('error', () => host.disconnect())
    child.on('error', () => host.disconnect())
    child.stdout.on('data', (bytes: Uint8Array) => host.receive(bytes))
    child.stdout.on('end', () => host.end())
    async function initialize(): Promise<JsonValue> {
      return host.request('engine.initialize', { protocolVersion: 1, profileRoot, resourceRoot })
    }
    return { child, closed, host, initialize, diagnostics: () => diagnostics }
  }

  it('uses the shared decoder and peer for real initialization, ping, redacted errors and shutdown', async () => {
    const f = fixture()
    try {
      const ready = await f.initialize()
      expect(isBootstrapResult(ready)).toBe(true)
      expect(f.host.engineEpoch).not.toBeNull()
      const ping = await f.host.request('engine.ping', {})
      expect(ping).toEqual(ready)
      await expect(f.host.request('engine.unknown', { password: 'fixture-must-not-echo' }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENTS', message: SERVICE_ERROR_MESSAGES.INVALID_ARGUMENTS })
      await expect(f.host.request('engine.unknown', {})).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
      await expect(f.host.request('engine.shutdown', {})).resolves.toEqual({ stopped: true })
      expect((await f.closed)[0]).toBe(0)
      expect(f.diagnostics()).not.toContain('fixture-must-not-echo')
    } finally { f.host.disconnect(); f.child.kill(); await f.closed }
  }, 5000)

  it('rejects BOM input in the actual service consistently with shared framing', async () => {
    const f = fixture()
    try {
      const frame = { ...request('host:1', {}), operation: 'engine.ping', engineEpoch: '' }
      f.child.stdin.end(encoder.encode('\ufeff' + JSON.stringify(frame) + '\n'))
      const [exitCode] = await f.closed
      expect(exitCode).toBe(1)
      expect(f.diagnostics()).not.toContain('host:1')
    } finally { f.host.disconnect(); f.child.kill(); await f.closed }
  }, 5000)

  it('rejects invalid cancellation identifiers rather than accepting an unvalidated callback', async () => {
    const f = fixture()
    try {
      await f.initialize()
      const invalidCancel = { kind: 'event', protocolVersion: 1, engineEpoch: f.host.engineEpoch,
        operation: 'engine.cancel', payload: { requestId: 'service:secret-invalid-id' } }
      f.child.stdin.end(JSON.stringify(invalidCancel) + '\n')
      const [exitCode] = await f.closed
      expect(exitCode).toBe(1)
      expect(f.diagnostics()).not.toContain('secret-invalid-id')
    } finally { f.host.disconnect(); f.child.kill(); await f.closed }
  }, 5000)
})
