import { afterEach, expect, it, vi } from 'vitest'
import { ServicePeer } from './peer'
import { isRecord, serviceOperationTimeoutMs } from '../../shared/service-protocol'
const peers: ServicePeer[] = []
afterEach(async () => { for (const peer of peers.splice(0)) peer.disconnect(); vi.useRealTimers() })
it('retains exact installer work beyond ordinary deadlines and aborts it at its finite cap', async () => {
  vi.useFakeTimers()
  const handlers = new Map<string, { signal: AbortSignal; finish(value: { ok: boolean }): void }>()
  const operations = Object.fromEntries(['engine.agent.install', 'agent-installer:install', 'agent-installer:install.extra'].map(operation => [operation, { validatePayload: isRecord, validateResult: isRecord, handle: (_value: unknown, signal: AbortSignal) => new Promise<{ ok: boolean }>(finish => { handlers.set(operation, { signal, finish }) }) }]))
  const host = new ServicePeer({ role: 'host', engineEpoch: 'deadline-epoch', operations, write: async bytes => service.receive(bytes) })
  const service = new ServicePeer({ role: 'service', engineEpoch: 'deadline-epoch', operations, write: async bytes => host.receive(bytes) }); peers.push(host, service)
  const exact = host.request('engine.agent.install', {}), expired = host.request('agent-installer:install.extra', {})
  const ordinaryFailure = expect(expired).rejects.toMatchObject({ code: 'TIMEOUT' })
  await vi.advanceTimersByTimeAsync(31000); await ordinaryFailure
  expect(handlers.get('engine.agent.install')!.signal.aborted).toBe(false)
  expect(handlers.get('agent-installer:install.extra')!.signal.aborted).toBe(true)
  handlers.get('engine.agent.install')!.finish({ ok: true }); expect(await exact).toEqual({ ok: true })
  const bounded = host.request('agent-installer:install', {}), failure = expect(bounded).rejects.toMatchObject({ code: 'TIMEOUT' })
  await vi.advanceTimersByTimeAsync(180001); await failure
  expect(handlers.get('agent-installer:install')!.signal.aborted).toBe(true)
  handlers.get('agent-installer:install')!.finish({ ok: true }); handlers.get('agent-installer:install.extra')!.finish({ ok: true })
  await vi.advanceTimersByTimeAsync(0)
  await expect(host.request('agent-installer:install.extra', {}, { timeoutMs: 180000 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(serviceOperationTimeoutMs('engine.agent.install.extra')).toBe(30000)
})

it.each(['attachments:download', 'engine.attachment.download', 'host.attachment.download'])('retains %s through a bounded save-dialog wait without extending related operations', async operation => {
  vi.useFakeTimers()
  const handlers = new Map<string, { signal: AbortSignal; finish(value: { ok: boolean }): void }>()
  const extra = `${operation}.extra`
  const operations = Object.fromEntries([operation, extra].map(name => [name, { validatePayload: isRecord, validateResult: isRecord,
    handle: (_value: unknown, signal: AbortSignal) => new Promise<{ ok: boolean }>(finish => { handlers.set(name, { signal, finish }) }) }]))
  const host = new ServicePeer({ role: 'host', engineEpoch: 'deadline-epoch', operations, write: async bytes => service.receive(bytes) })
  const service = new ServicePeer({ role: 'service', engineEpoch: 'deadline-epoch', operations, write: async bytes => host.receive(bytes) }); peers.push(host, service)
  const origin = operation.startsWith('host.') ? service : host
  const exact = origin.request(operation, {}), ordinary = origin.request(extra, {}), ordinaryFailure = expect(ordinary).rejects.toMatchObject({ code: 'TIMEOUT' })
  await vi.advanceTimersByTimeAsync(31000); await ordinaryFailure
  expect(handlers.get(operation)!.signal.aborted).toBe(false); expect(handlers.get(extra)!.signal.aborted).toBe(true)
  handlers.get(operation)!.finish({ ok: true }); expect(await exact).toEqual({ ok: true })
  const bounded = origin.request(operation, {}), failure = expect(bounded).rejects.toMatchObject({ code: 'TIMEOUT' })
  await vi.advanceTimersByTimeAsync(180001); await failure
  expect(handlers.get(operation)!.signal.aborted).toBe(true)
  handlers.get(operation)!.finish({ ok: true }); handlers.get(extra)!.finish({ ok: true }); await vi.advanceTimersByTimeAsync(0)
  await expect(origin.request(extra, {}, { timeoutMs: 180000 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(serviceOperationTimeoutMs(extra)).toBe(30000)
})
