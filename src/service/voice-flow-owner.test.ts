import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceFlowOwner, type VoiceFlowLease } from './voice-flow-owner'
import {
  NATIVE_VOICE_HOST_SCHEMAS,
  NATIVE_VOICE_DELIVERY_SCHEMAS,
  type NativeVoiceBridge,
  type NativeVoiceEvent,
  type NativeVoicePurpose
} from '../shared/voice-native-callbacks'
import { ServicePeer, type OperationSchema } from './transport/peer'
import type { JsonValue } from '../shared/service-protocol'
const owners: VoiceFlowOwner[] = [],
  release: Array<() => void> = []
afterEach(async () => {
  for (const done of release.splice(0)) done()
  for (const owner of owners.splice(0)) await owner.close()
  vi.restoreAllMocks()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function setup() {
  const native: NativeVoiceBridge = {
    acquire: vi.fn(async ({ voiceLeaseId }) => ({ voiceLeaseId, acquired: true as const })),
    permission: vi.fn(async ({ voiceLeaseId }) => ({ voiceLeaseId, status: 'unavailable' as const })),
    bind: vi.fn(async ({ voiceLeaseId }) => ({ voiceLeaseId, bound: true as const })),
    shortcut: vi.fn(async ({ voiceLeaseId }) => ({ voiceLeaseId, registered: true as const })),
    publish: vi.fn(async ({ voiceLeaseId }) => ({ voiceLeaseId, delivered: true })),
    retire: vi.fn(async ({ voiceLeaseId }) => ({ voiceLeaseId, retired: true as const }))
  }
  let time = 0
  const beforeEffect = vi.fn(),
    onAudio = vi.fn(),
    onRevoked = vi.fn(),
    onHotkey = vi.fn(),
    join = vi.fn(async () => {})
  const owner = new VoiceFlowOwner(
    native,
    () => {},
    () => time
  )
  owners.push(owner)
  const acquire = (purpose: NativeVoicePurpose = 'capture', observe?: (lease: VoiceFlowLease) => void) =>
    owner.acquire(
      { purpose, uiLeaseId: 'document_fixture_1', ttlMs: purpose === 'permission' ? 120000 : 600000 },
      { beforeEffect, onAudio, onRevoked, onHotkey, join },
      observe
    )
  const audio = (lease: VoiceFlowLease, seq = 1) => ({
    voiceLeaseId: lease.voiceLeaseId,
    turnId: 'turn_1',
    turnEpoch: 'epoch_1',
    seq,
    pcmBase64: 'AAA='
  })
  return {
    owner,
    native,
    beforeEffect,
    onAudio,
    onRevoked,
    onHotkey,
    join,
    acquire,
    audio,
    time: (value: number) => {
      time = value
    }
  }
}
const binding = { turnId: 'turn_1', turnEpoch: 'epoch_1' }
const start: NativeVoiceEvent = {
  type: 'speech-start',
  speechId: 'speech_1',
  speechGeneration: 1,
  source: 'manual',
  text: 'Synthetic silence.',
  sampleRate: 24000,
  truncated: false
}
const chunk = (index: number): NativeVoiceEvent => ({
  type: 'speech-chunk',
  speechId: 'speech_1',
  speechGeneration: 1,
  index,
  text: '',
  sampleRate: 24000,
  pcmBase64: 'AAA='
})
describe('private per-document voice ownership', () => {
  it('records cleanup ownership early but refuses effects before registration and post-ack scope validation', async () => {
    const s = setup(),
      held = deferred<{ voiceLeaseId: string; acquired: true }>()
    vi.mocked(s.native.acquire).mockReturnValue(held.promise)
    let lease!: VoiceFlowLease
    const pending = s.acquire('capture', (owned) => {
      lease = owned
    })
    expect(Object.isFrozen(lease)).toBe(true)
    await expect(lease.bind(binding)).rejects.toThrow('UNAVAILABLE')
    expect(s.native.bind).not.toHaveBeenCalled()
    held.resolve({ voiceLeaseId: lease.voiceLeaseId, acquired: true })
    expect(await pending).toBe(lease)
    await lease.bind(binding)
    expect(s.native.bind).toHaveBeenCalledOnce()
    await lease.close()
    expect(s.owner.inflightCount).toBe(0)
  })
  it('claims exact sequence and turn before PCM enqueue; rejects duplicates, foreign IDs, epochs and fields', async () => {
    const s = setup(),
      lease = await s.acquire()
    expect(s.owner.deliverAudio(s.audio(lease))).toEqual({ accepted: false })
    await lease.bind(binding)
    for (const extra of [{ seq: 2 }, { turnEpoch: 'foreign_epoch' }, { turnId: 'foreign_turn' }, { callback: '*' }])
      expect(s.owner.deliverAudio({ ...s.audio(lease), ...extra })).toEqual({ accepted: false })
    expect(s.owner.deliverAudio(s.audio(lease))).toEqual({ accepted: true })
    expect(s.owner.deliverAudio(s.audio(lease))).toEqual({ accepted: false })
    expect(s.onAudio).toHaveBeenCalledExactlyOnceWith(Buffer.alloc(2))
    s.time(600000)
    expect(s.owner.deliverAudio(s.audio(lease, 2))).toEqual({ accepted: false })
    expect(s.onRevoked).toHaveBeenCalledOnce()
    await lease.close()
  })
  it('does not consume valid audio until native bind and the post-ack guard both succeed', async () => {
    const s = setup(),
      lease = await s.acquire(),
      held = deferred<{ voiceLeaseId: string; bound: true }>()
    vi.mocked(s.native.bind).mockReturnValue(held.promise)
    const raw = lease.bind(binding),
      rejected = expect(raw).rejects.toThrow('withdrawn')
    expect(s.owner.deliverAudio(s.audio(lease))).toEqual({ accepted: false })
    s.beforeEffect.mockImplementation(() => {
      throw new Error('withdrawn')
    })
    held.resolve({ voiceLeaseId: lease.voiceLeaseId, bound: true })
    await rejected
    expect(s.onAudio).not.toHaveBeenCalled()
    await lease.close()
  })
  it('preserves denied/unavailable permission and refuses a second native prompt', async () => {
    const s = setup(),
      lease = await s.acquire('permission')
    expect(await lease.permission()).toBe('unavailable')
    await expect(lease.permission()).rejects.toThrow('UNAVAILABLE')
    expect(s.native.permission).toHaveBeenCalledOnce()
    expect(s.onAudio).not.toHaveBeenCalled()
    await lease.close()
  })
  it('synchronously revokes while held permission retires outside the delivery RPC and joins its raw receipt', async () => {
    const s = setup(),
      lease = await s.acquire('permission'),
      held = deferred<{ voiceLeaseId: string; status: 'denied' }>()
    vi.mocked(s.native.permission).mockReturnValue(held.promise)
    const prompting = lease.permission(),
      rejected = expect(prompting).rejects.toThrow('UNAVAILABLE')
    await vi.waitFor(() => expect(s.native.permission).toHaveBeenCalledOnce())
    expect(s.owner.deliverRevoked({ voiceLeaseId: lease.voiceLeaseId })).toEqual({ accepted: true })
    expect(s.onRevoked).toHaveBeenCalledOnce()
    expect(s.native.retire).not.toHaveBeenCalled()
    await expect(s.owner.close(5)).rejects.toThrow('DRAIN_BLOCKED')
    expect(s.native.retire).toHaveBeenCalledOnce()
    expect(s.owner.inflightCount).toBe(1)
    held.resolve({ voiceLeaseId: lease.voiceLeaseId, status: 'denied' })
    await rejected
    await s.owner.close()
    expect(s.owner.inflightCount).toBe(0)
  })
  it('retains admission after failed cleanup, including post-ack registration scope withdrawal, without touching another flow', async () => {
    const s = setup(),
      unrelated = await s.acquire('shortcut')
    await unrelated.shortcut('Control+Shift+Space')
    const held = deferred<{ voiceLeaseId: string; acquired: true }>()
    vi.mocked(s.native.acquire).mockReturnValueOnce(held.promise)
    let lease!: VoiceFlowLease,
      refuse = true
    vi.mocked(s.native.retire).mockImplementation(async ({ voiceLeaseId }) => {
      if (voiceLeaseId === lease?.voiceLeaseId && refuse) throw new Error('cleanup refused')
      return { voiceLeaseId, retired: true }
    })
    const pending = s.acquire('capture', (owned) => {
        lease = owned
      }),
      failed = expect(pending).rejects.toThrow('cleanup refused')
    await Promise.resolve()
    s.beforeEffect.mockImplementation(() => {
      throw new Error('withdrawn')
    })
    held.resolve({ voiceLeaseId: lease.voiceLeaseId, acquired: true })
    await failed
    expect(s.owner.inflightCount).toBe(2)
    s.beforeEffect.mockImplementation(() => {})
    refuse = false
    await lease.close()
    expect(s.native.retire).not.toHaveBeenCalledWith({ voiceLeaseId: unrelated.voiceLeaseId })
    expect(s.owner.deliverHotkey({ voiceLeaseId: unrelated.voiceLeaseId })).toEqual({ accepted: true })
    expect(s.owner.deliverHotkey({ voiceLeaseId: unrelated.voiceLeaseId, global: true })).toEqual({ accepted: false })
    await unrelated.close()
  })
  it('joins held registration even when native early retirement already acknowledged, fencing delayed admission', async () => {
    const s = setup(),
      held = deferred<{ voiceLeaseId: string; acquired: true }>()
    vi.mocked(s.native.acquire).mockReturnValue(held.promise)
    let lease!: VoiceFlowLease
    const pending = s.acquire('capture', (owned) => {
        lease = owned
      }),
      failed = expect(pending).rejects.toThrow('UNAVAILABLE')
    await vi.waitFor(() => expect(s.native.acquire).toHaveBeenCalledOnce())
    const close = lease.close()
    await expect(s.owner.close(5)).rejects.toThrow('DRAIN_BLOCKED')
    expect(s.native.retire).toHaveBeenCalledOnce()
    expect(s.owner.inflightCount).toBe(1)
    held.resolve({ voiceLeaseId: lease.voiceLeaseId, acquired: true })
    await failed
    await close
    expect(s.owner.inflightCount).toBe(0)
  })
  it('joins observer failure and consumer cleanup refusal before releasing its entry', async () => {
    const s = setup(),
      held = deferred<void>()
    s.join.mockReturnValue(held.promise)
    let lease!: VoiceFlowLease
    const pending = s.acquire('capture', (owned) => {
        lease = owned
        throw new Error('observer failed')
      }),
      failed = expect(pending).rejects.toThrow('observer failed')
    await expect(s.owner.close(5)).rejects.toThrow('DRAIN_BLOCKED')
    expect(s.native.acquire).not.toHaveBeenCalled()
    expect(s.owner.inflightCount).toBe(1)
    held.resolve()
    await failed
    await lease.close()
  })
  it('synchronously fences a ready consumer when captured authority is withdrawn before a method', async () => {
    const s = setup(),
      lease = await s.acquire('permission')
    s.beforeEffect.mockImplementation(() => {
      throw new Error('withdrawn')
    })
    await expect(lease.permission()).rejects.toThrow('withdrawn')
    expect(s.onRevoked).toHaveBeenCalledOnce()
    expect(s.native.permission).not.toHaveBeenCalled()
    await lease.close()
  })
  it('bounds total accepted capture bytes and serialized pending publication bytes independently of count', async () => {
    const s = setup(),
      capture = await s.acquire()
    await capture.bind(binding)
    const pcmBase64 = Buffer.alloc(6400).toString('base64')
    for (let seq = 1; seq <= 3000; seq++)
      expect(s.owner.deliverAudio({ ...s.audio(capture, seq), pcmBase64 })).toEqual({ accepted: true })
    expect(s.owner.deliverAudio({ ...s.audio(capture, 3001), pcmBase64 })).toEqual({ accepted: false })
    expect(s.onAudio).toHaveBeenCalledTimes(3000)
    await capture.close()
    const playback = await s.acquire('playback')
    await playback.bind({ speechId: 'speech_1', speechGeneration: 1 })
    await playback.publish(start)
    const held = deferred<{ voiceLeaseId: string; delivered: true }>()
    vi.mocked(s.native.publish).mockReturnValueOnce(held.promise)
    const raw = playback.publish({
      ...chunk(0),
      pcmBase64: Buffer.alloc(128 * 1024).toString('base64')
    } as NativeVoiceEvent)
    const pending = Promise.allSettled([raw])
    await vi.waitFor(() => expect(s.native.publish).toHaveBeenCalledTimes(2))
    await expect(
      playback.publish({ ...chunk(1), pcmBase64: Buffer.alloc(128 * 1024).toString('base64') } as NativeVoiceEvent)
    ).rejects.toThrow('UNAVAILABLE')
    held.resolve({ voiceLeaseId: playback.voiceLeaseId, delivered: true })
    await pending
    await playback.close()
    expect(s.native.publish).toHaveBeenCalledTimes(2)
  })
  it('retains a refused consumer join for retry after native retirement without closing an unrelated lease', async () => {
    const s = setup(),
      unrelated = await s.acquire('shortcut')
    await unrelated.shortcut('Control+Shift+Space')
    const lease = await s.acquire('capture')
    s.join.mockRejectedValueOnce(new Error('consumer still owns raw work'))
    await expect(lease.close()).rejects.toThrow('consumer still owns raw work')
    expect(s.owner.inflightCount).toBe(2)
    expect(s.native.retire).not.toHaveBeenCalledWith({ voiceLeaseId: unrelated.voiceLeaseId })
    expect(s.owner.deliverHotkey({ voiceLeaseId: unrelated.voiceLeaseId })).toEqual({ accepted: true })
    await lease.close()
    expect(s.owner.inflightCount).toBe(1)
    await unrelated.close()
  })
  it('bounds active admission and retains closed UUID history for the sealed epoch', async () => {
    const s = setup(),
      leases: VoiceFlowLease[] = []
    for (let i = 0; i < 16; i++) leases.push(await s.acquire())
    await expect(s.acquire()).rejects.toThrow('CAPACITY')
    await leases[0].close()
    const next = await s.acquire()
    expect(next.voiceLeaseId).not.toBe(leases[0].voiceLeaseId)
    for (const lease of leases) await lease.close()
    await next.close()
    for (let i = 17; i < 4096; i++) await (await s.acquire()).close()
    await expect(s.acquire()).rejects.toThrow('CAPACITY')
    expect(s.owner.inflightCount).toBe(0)
  })
  it('orders exact speech fragments and rejects duplicate generations or odd audio before native effects', async () => {
    const s = setup(),
      lease = await s.acquire('playback')
    await lease.bind({ speechId: 'speech_1', speechGeneration: 1 })
    await lease.publish(start)
    await lease.publish(chunk(0))
    await lease.publish(chunk(1))
    await expect(lease.publish(chunk(1))).rejects.toThrow('UNAVAILABLE')
    expect(s.native.publish).toHaveBeenCalledTimes(3)
    await lease.close()
    const next = await s.acquire('playback')
    await next.bind({ speechId: 'speech_1', speechGeneration: 2 })
    await expect(next.publish({ ...start, speechGeneration: 1 })).rejects.toThrow('UNAVAILABLE')
    expect(s.native.publish).toHaveBeenCalledTimes(3)
    await next.close()
  })
  it('bounds pending output count/bytes and joins raw publish despite withdrawal', async () => {
    const s = setup(),
      lease = await s.acquire('playback')
    await lease.bind({ speechId: 'speech_1', speechGeneration: 1 })
    const held = deferred<{ voiceLeaseId: string; delivered: true }>()
    vi.mocked(s.native.publish).mockReturnValue(held.promise)
    const pending = [lease.publish(start), ...Array.from({ length: 7 }, (_, index) => lease.publish(chunk(index)))]
    const joined = Promise.allSettled(pending)
    await vi.waitFor(() => expect(s.native.publish).toHaveBeenCalledOnce())
    await expect(lease.publish(chunk(7))).rejects.toThrow('UNAVAILABLE')
    await expect(s.owner.close(5)).rejects.toThrow('DRAIN_BLOCKED')
    held.resolve({ voiceLeaseId: lease.voiceLeaseId, delivered: true })
    await joined
    await lease.close()
    expect(s.native.publish).toHaveBeenCalledOnce()
    expect(s.owner.inflightCount).toBe(0)
  })
})

it('joins held raw permission and revocation through the real fragmented private peer without delivery deadlock', async () => {
  let current = true
  const permission = deferred<JsonValue>(),
    permissionEntered = deferred<void>()
  const publications: JsonValue[] = [],
    audio: Buffer[] = []
  const deliver = (peer: ServicePeer, bytes: Uint8Array) => {
    for (let offset = 0; offset < bytes.length; offset += 37) peer.receive(bytes.subarray(offset, offset + 37))
  }
  const handlers: Record<string, OperationSchema> = Object.fromEntries(
    Object.entries(NATIVE_VOICE_HOST_SCHEMAS).map(([operation, schema]) => [
      operation,
      {
        ...schema,
        handle: async (payload) => {
          const { voiceLeaseId } = payload as { voiceLeaseId: string }
          if (operation === 'host.voice.permission') {
            permissionEntered.resolve()
            return permission.promise
          }
          if (operation === 'host.voice.retire') {
            permission.resolve({ voiceLeaseId, status: 'unavailable' })
            return { voiceLeaseId, retired: true }
          }
          if (operation === 'host.voice.publish') {
            publications.push(payload)
            return { voiceLeaseId, delivered: true }
          }
          return {
            voiceLeaseId,
            [operation === 'host.voice.acquire'
              ? 'acquired'
              : operation === 'host.voice.bind'
                ? 'bound'
                : 'registered']: true
          }
        }
      }
    ])
  )
  const delivery: Record<string, OperationSchema> = Object.fromEntries(
    Object.entries(NATIVE_VOICE_DELIVERY_SCHEMAS).map(([operation, schema]) => [
      operation,
      {
        ...schema,
        handle: (payload) => {
          const result =
            operation === 'engine.voice.audio'
              ? owner.deliverAudio(payload)
              : operation === 'engine.voice.hotkey'
                ? owner.deliverHotkey(payload)
                : owner.deliverRevoked(payload)
          return result
        }
      }
    ])
  )
  const host = new ServicePeer({
    role: 'host',
    engineEpoch: 'voice-proof-epoch',
    operations: { ...handlers, ...NATIVE_VOICE_DELIVERY_SCHEMAS },
    write: async (bytes) => deliver(source, bytes)
  })
  const source = new ServicePeer({
    role: 'service',
    engineEpoch: 'voice-proof-epoch',
    operations: { ...NATIVE_VOICE_HOST_SCHEMAS, ...delivery },
    write: async (bytes) => deliver(host, bytes)
  })
  const request = async <T>(operation: string, value: unknown): Promise<T> =>
    (await source.request(operation, JSON.parse(JSON.stringify(value)) as JsonValue)) as T
  const owner = new VoiceFlowOwner(
    {
      acquire: (value) => request('host.voice.acquire', value),
      permission: (value) => request('host.voice.permission', value),
      bind: (value) => request('host.voice.bind', value),
      shortcut: (value) => request('host.voice.shortcut', value),
      publish: (value) => request('host.voice.publish', value),
      retire: (value) => request('host.voice.retire', value)
    },
    () => {
      if (!current) throw new Error('Withdrawn owner')
    }
  )
  try {
    const capture = await owner.acquire(
      { uiLeaseId: 'ui_' + 'a'.repeat(32), purpose: 'capture', ttlMs: 10000 },
      {
        beforeEffect() {},
        onAudio: (pcm) => {
          audio.push(pcm)
        }
      }
    )
    await capture.bind({ turnId: 'turn-private', turnEpoch: 'epoch-private' })
    const packet = {
      voiceLeaseId: capture.voiceLeaseId,
      turnId: 'turn-private',
      turnEpoch: 'epoch-private',
      seq: 1,
      pcmBase64: 'AAA='
    }
    expect(await host.request('engine.voice.audio', packet)).toEqual({ accepted: true })
    expect(await host.request('engine.voice.audio', packet)).toEqual({ accepted: false })
    expect(audio).toEqual([Buffer.alloc(2)])
    await capture.publish({ type: 'state', turnId: 'turn-private', turnEpoch: 'epoch-private', state: 'listening' })
    const prompt = await owner.acquire(
      { uiLeaseId: 'ui_' + 'a'.repeat(32), purpose: 'permission', ttlMs: 10000 },
      { beforeEffect() {} }
    )
    const raw = prompt.permission(),
      refused = expect(raw).rejects.toThrow('VOICE_FLOW_UNAVAILABLE')
    await permissionEntered.promise
    expect(await host.request('engine.voice.revoked', { voiceLeaseId: prompt.voiceLeaseId })).toEqual({
      accepted: true
    })
    await refused
    await prompt.close()
    expect(owner.inflightCount).toBe(1)
    expect(publications).toHaveLength(1)
    current = false
    expect(await host.request('engine.voice.audio', { ...packet, seq: 2 })).toEqual({ accepted: false })
    await capture.close()
    await owner.close()
    expect(owner.inflightCount).toBe(0)
    expect(source.pendingCount + host.pendingCount).toBe(0)
  } finally {
    permission.resolve({ voiceLeaseId: '00000000-0000-4000-8000-000000000000', status: 'unavailable' })
    await owner.close()
    source.disconnect()
    host.disconnect()
    await Promise.all([source.waitForHandlers(), host.waitForHandlers()])
  }
})
