import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@/types'
import { isRecord, type ServiceEvent } from '@shared/service-protocol'
import { DesktopClient, type DesktopClientState, type DesktopTransport } from './desktop-client'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  let receive: (event: unknown) => void = () => {}
  const unlisten = vi.fn()
  const transport: DesktopTransport = {
    invoke: vi.fn(async (_operation, _payload, options) => ({ engineEpoch: options.engineEpoch, result: { defined: true, value: null } })),
    listen: vi.fn(async callback => { receive = callback; return unlisten })
  }
  const states: DesktopClientState[] = []
  const client = new DesktopClient({ transport, onState: state => states.push(state), commands: {
    'settings:get': { encodeArguments: args => args, decodeResult: value => value as string | null,
      validateResult: value => value === null || typeof value === 'string' },
    'settings:set': { encodeArguments: args => args, decodeResult: () => undefined,
      validateResult: value => value === undefined },
    'db:getTask': { encodeArguments: args => args, decodeResult: value => value as Task | undefined,
      validateResult: value => value === undefined }
  }, events: {
    'task:deleted': { decodePayload: value => value as { taskId: string }, validatePayload: value => isRecord(value) && typeof value.taskId === 'string' }
  } })
  return { client, transport, states, unlisten, emit: (event: unknown) => receive(event) }
}
const event = (sequence: number, payload = 'task-1', engineEpoch = 'first'): ServiceEvent => ({
  protocolVersion: 1, kind: 'event', operation: 'task:deleted', engineEpoch, sequence, payload: { taskId: payload }
})

afterEach(() => vi.useRealTimers())

describe('desktop connection lifecycle', () => {
  it('preserves explicit undefined and null results and rejects missing codecs or retired operations', async () => {
    const { client, transport } = fixture()
    await client.connect('first')
    expect(await client.invoke('settings:get', ['missing'])).toBeNull()
    vi.mocked(transport.invoke).mockResolvedValueOnce({ engineEpoch: 'first', result: { defined: false } })
    expect(await client.invoke('db:getTask', ['missing'])).toBeUndefined()
    await expect(client.invoke('settings:getAll', [])).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    await expect(client.invoke('browser:new' as 'settings:get', ['x'])).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(transport.invoke).toHaveBeenCalledTimes(2)
    client.dispose()
  })

  it('rejects in-flight mutations on reconnect and never replays them', async () => {
    const { client, transport, unlisten } = fixture()
    await client.connect('first')
    const old = deferred<unknown>()
    vi.mocked(transport.invoke).mockReturnValueOnce(old.promise)
    const request = client.invoke('settings:set', ['key', 'value'])
    const rejection = expect(request).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await client.connect('second')
    await rejection
    old.resolve({ engineEpoch: 'first', result: { defined: false } })
    await Promise.resolve()
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(client.connection).toEqual({ status: 'ready', engineEpoch: 'second' })
    client.dispose()
  })

  it('keeps registrations independent and detects event gaps so owners can rehydrate', async () => {
    const { client, emit, states, unlisten } = fixture()
    const callback = vi.fn()
    const first = client.subscribe('task:deleted', callback)
    const second = client.subscribe('task:deleted', callback)
    await client.connect('first')
    emit(event(10))
    first(); first()
    emit(event(10)) // duplicate delivery
    emit(event(11, 'task-2'))
    expect(callback.mock.calls).toEqual([[{ taskId: 'task-1' }], [{ taskId: 'task-1' }], [{ taskId: 'task-2' }]])
    emit(event(13)) // lost delivery: discard connection instead of advancing past missing state
    expect(client.connection).toMatchObject({ status: 'disconnected', reason: 'STALE_EPOCH' })
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(states.at(-1)?.reason).toBe('STALE_EPOCH')
    second(); client.dispose()
  })

  it('releases a native listener that finishes registering after disposal', async () => {
    const { client, transport, unlisten } = fixture()
    const registration = deferred<() => void>()
    vi.mocked(transport.listen).mockReturnValueOnce(registration.promise)
    const connecting = client.connect('first')
    const rejection = expect(connecting).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await Promise.resolve()
    client.dispose()
    await rejection
    registration.resolve(unlisten)
    await Promise.resolve(); await Promise.resolve()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('does not let an old unsubscriber remove a replacement registration', async () => {
    const { client, emit } = fixture()
    const callback = vi.fn()
    const old = client.subscribe('task:deleted', callback)
    old()
    client.subscribe('task:deleted', callback)
    old()
    await client.connect('first')
    emit(event(1))
    expect(callback).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('bounds requests and settles timeout/abort even if the native adapter never resolves', async () => {
    vi.useFakeTimers()
    const { client, transport } = fixture()
    await client.connect('first')
    vi.mocked(transport.invoke).mockImplementation(() => new Promise(() => {}))
    const requests = Array.from({ length: 128 }, () => client.invoke('settings:get', ['key'], { timeoutMs: 100 }))
    const rejected = Promise.all(requests.map(request => expect(request).rejects.toMatchObject({ code: 'TIMEOUT' })))
    await expect(client.invoke('settings:get', ['overflow'])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    const controller = new AbortController()
    const request = client.invoke('settings:get', ['cancelled'], { signal: controller.signal })
    const cancelled = expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort()
    await cancelled
    expect(vi.mocked(transport.invoke).mock.calls.at(-1)?.[2].signal.aborted).toBe(true)
    client.dispose()
  })

  it('rejects malformed results and invalidates mismatched engine responses', async () => {
    const { client, transport } = fixture()
    await client.connect('first')
    vi.mocked(transport.invoke).mockResolvedValueOnce({ engineEpoch: 'first', result: null })
    await expect(client.invoke('settings:get', ['key'])).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    vi.mocked(transport.invoke).mockResolvedValueOnce({ engineEpoch: 'second', result: { defined: true, value: 'x' } })
    await expect(client.invoke('settings:get', ['key'])).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    expect(client.connection.status).toBe('disconnected')
    client.dispose()
  })

  it('buffers events during native registration and rejects foreign epochs and malformed payloads', async () => {
    const { client, transport, emit } = fixture()
    const callback = vi.fn()
    client.subscribe('task:deleted', callback)
    const original = transport.listen
    vi.mocked(transport.listen).mockImplementationOnce(async receive => {
      const stop = await original(receive)
      receive(event(1))
      return stop
    })
    await client.connect('first')
    expect(callback).toHaveBeenCalledWith({ taskId: 'task-1' })
    emit(event(2, 'foreign', 'second'))
    expect(callback).toHaveBeenCalledTimes(1)
    expect(client.connection.reason).toBe('STALE_EPOCH')
    await client.connect('second')
    emit({ ...event(1, 'x', 'second'), payload: { canary: 'secret' } })
    expect(client.connection.reason).toBe('INVALID_ARGUMENTS')
    client.dispose()
  })
})
