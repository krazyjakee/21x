import { describe, expect, it, vi } from 'vitest'
import { createNativeAttachmentDrops } from './native-attachment-drop-owner'
import { getTauriEngineEpoch, type TauriDesktopApi } from './tauri-desktop-transport'
import { NATIVE_ATTACHMENT_DROP as OP, type NativeAttachmentDropReceipt } from '@shared/native-attachment-drop'
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
const DROP = '33333333-3333-4333-8333-333333333333'
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const reply = () => ({ engineEpoch: 'engine-1', result: { defined: false } })
async function fixture(supported = true) {
  const held = new Map<string, ReturnType<typeof deferred<unknown>>>()
  let generation = 1, ready = true, lease = 'document-exact'
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: lease, nativeDropSupported: supported }
    const raw = held.get(String(args?.operation)); held.delete(String(args?.operation))
    return raw ? raw.promise : reply()
  })
  const native = { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } } as unknown as TauriDesktopApi
  await getTauriEngineEpoch(native)
  const owner = createNativeAttachmentDrops(native, () => ({ generation, ready }))
  const emit = (contextId = A, dropId = DROP, patch: Record<string, unknown> = {}) => owner.receive({ engineEpoch: 'engine-1', leaseId: lease,
    drop: { contextId, dropId, paths: ['/tmp/selected.txt'] }, ...patch })
  return { owner, invoke, native, emit,
    calls: (operation: string) => invoke.mock.calls.filter(([,args]) => args?.operation === operation),
    hold: (operation: string) => { const raw = deferred<unknown>(); held.set(operation, raw); return raw },
    replace: () => { generation++; lease = 'document-replacement' },
    pause: () => { ready = false } }
}
describe('native Drop facade-local ownership', () => {
  it('requires explicit native availability and exact UUID/null arguments before effects', async () => {
    const f = await fixture(false)
    expect(f.owner.supported()).toBe(false)
    await expect(f.owner.setContext(A)).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    const before = f.invoke.mock.calls.length
    for (const args of [[], [undefined], ['/tmp/raw'], [A, 'task-id']]) await expect(f.owner.setContext(...args)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(f.invoke.mock.calls.length).toBe(before)
  })
  it('records accept synchronously and only acknowledges after the exact raw receipt', async () => {
    const f = await fixture(); await f.owner.setContext(A)
    const raw = f.hold(OP.accept)
    let receipt!: NativeAttachmentDropReceipt, accepted!: Promise<void>
    f.owner.subscribe(value => { receipt = value; accepted = value.accept() })
    f.emit()
    await vi.waitFor(() => expect(f.calls(OP.accept)).toHaveLength(1))
    expect(f.calls(OP.close)).toHaveLength(0)
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.paths)).toBe(true)
    expect(f.calls(OP.accept)[0][1]).toMatchObject({ engineEpoch: 'engine-1', uiLease: 'document-exact', payload: { contextId: A, dropId: DROP } })
    raw.resolve(reply()); await accepted; await receipt.close(); await receipt.close()
    expect(f.calls(OP.close)).toHaveLength(1)
  })
  it.each(['absent', 'ignored', 'throwing', 'ambiguous'] as const)('closes %s delivery without native accept or import authority', async mode => {
    const f = await fixture(); await f.owner.setContext(A)
    if (mode !== 'absent') f.owner.subscribe(() => { if (mode === 'throwing') throw Error('consumer') })
    if (mode === 'ambiguous') f.owner.subscribe(() => {})
    f.emit(); await vi.waitFor(() => expect(f.calls(OP.close)).toHaveLength(1))
    expect(f.calls(OP.accept)).toHaveLength(0)
  })
  it('joins held raw accept before close and cannot be accepted again after retirement', async () => {
    const f = await fixture(); await f.owner.setContext(A)
    const raw = f.hold(OP.accept)
    let receipt!: NativeAttachmentDropReceipt, accepting!: Promise<void>
    f.owner.subscribe(value => { receipt = value; accepting = value.accept(); void accepting.catch(() => {}) })
    f.emit(); await vi.waitFor(() => expect(f.calls(OP.accept)).toHaveLength(1))
    const closing = receipt.close()
    await Promise.resolve(); expect(f.calls(OP.close)).toHaveLength(0)
    raw.resolve(reply()); await expect(accepting).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await closing; await expect(receipt.accept()).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    expect(f.calls(OP.accept)).toHaveLength(1); expect(f.calls(OP.close)).toHaveLength(1)
  })
  it('owns an async observer failure after accepted delivery and refuses any late accept after closure', async () => {
    const f = await fixture(); await f.owner.setContext(A)
    let receipt!: NativeAttachmentDropReceipt
    f.owner.subscribe(async value => { receipt = value; await value.accept(); throw Error('consumer after acknowledgement') })
    f.emit(); await vi.waitFor(() => expect(f.calls(OP.close)).toHaveLength(1))
    await expect(receipt.accept()).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    expect(f.calls(OP.accept)).toHaveLength(1)
  })
  it('keeps failed retirement retryable and never replays native accept', async () => {
    const f = await fixture(); await f.owner.setContext(A)
    let receipt!: NativeAttachmentDropReceipt, accepting!: Promise<void>
    f.owner.subscribe(value => { receipt = value; accepting = value.accept() })
    f.emit(); await accepting
    const raw = f.hold(OP.close); const closing = receipt.close()
    await vi.waitFor(() => expect(f.calls(OP.close)).toHaveLength(1))
    raw.reject({ code: 'DISCONNECTED' }); await expect(closing).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await receipt.close(); expect(f.calls(OP.close)).toHaveLength(2); expect(f.calls(OP.accept)).toHaveLength(1)
  })
  it('rejects stale context, duplicate delivery and forged stamped arguments without replay', async () => {
    const f = await fixture(); await f.owner.setContext(A)
    const receive = vi.fn(); f.owner.subscribe(receive)
    f.emit(A, DROP, { leaseId: 'foreign-document' })
    f.emit(A, DROP, { engineEpoch: 'foreign-epoch' })
    f.emit(A, DROP, { extra: true })
    expect(receive).not.toHaveBeenCalled(); expect(f.calls(OP.close)).toHaveLength(0)
    await f.owner.setContext(B); f.emit(A)
    await vi.waitFor(() => expect(f.calls(OP.close)).toHaveLength(1))
    f.emit(A); expect(f.calls(OP.close)).toHaveLength(1); expect(receive).not.toHaveBeenCalled()
  })
  it('does not acknowledge a late context response over its newer replacement', async () => {
    const f = await fixture(); const firstRaw = f.hold(OP.context)
    const first = f.owner.setContext(A); void first.catch(() => {})
    await f.owner.setContext(B)
    const observed: string[] = []; f.owner.subscribe(value => { observed.push(value.contextId); void value.accept() })
    firstRaw.resolve(reply()); await expect(first).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    f.emit(B); await vi.waitFor(() => expect(f.calls(OP.accept)).toHaveLength(1))
    expect(observed).toEqual([B])
    const requests = f.calls(OP.context).map(([,args]) => args!.payload as { contextRevision: number })
    expect(requests.map(v => v.contextRevision)).toEqual([1,2])
  })
  it('fences replacement/hydration before and after native accept but retains captured cleanup stamp', async () => {
    const f = await fixture(); await f.owner.setContext(A)
    const raw = f.hold(OP.accept)
    let accepting!: Promise<void>
    f.owner.subscribe(value => { accepting = value.accept(); void accepting.catch(() => {}) })
    f.emit(); await vi.waitFor(() => expect(f.calls(OP.accept)).toHaveLength(1))
    f.replace(); await getTauriEngineEpoch(f.native); raw.resolve(reply())
    await expect(accepting).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await vi.waitFor(() => expect(f.calls(OP.close)).toHaveLength(1))
    expect(f.calls(OP.close)[0][1]?.uiLease).toBe('document-exact')
    f.pause(); await expect(f.owner.setContext(B)).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  })
  it('unsubscription and disposal synchronously retire context and join owned receipt cleanup', async () => {
    const f = await fixture(); await f.owner.setContext(A)
    let accepting!: Promise<void>
    const off = f.owner.subscribe(value => { accepting = value.accept() })
    f.emit(); await accepting; off(); f.owner.dispose()
    await vi.waitFor(() => expect(f.calls(OP.close)).toHaveLength(1))
    const request = f.calls(OP.context).at(-1)![1]!.payload
    expect(request).toMatchObject({ contextId: null, contextRevision: 2 })
    f.emit(B, '55555555-5555-4555-8555-555555555555')
    await vi.waitFor(() => expect(f.calls(OP.close)).toHaveLength(2))
  })
})
