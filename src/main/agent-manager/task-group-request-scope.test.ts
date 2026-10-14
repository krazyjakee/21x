import { describe, expect, it, vi } from 'vitest'
import { TaskGroupRequestScope } from './task-group-request-scope'
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }

describe('TaskGroupRequestScope', () => {
  it('preserves legacy unscoped effects and rejects malformed or already-cancelled admission', async () => {
    const owner = new TaskGroupRequestScope(), effect = vi.fn(async () => 'accepted'), controller = new AbortController()
    owner.assertCurrent(); expect(owner.detached(() => 42)).toBe(42)
    controller.abort()
    await expect(owner.run(effect, vi.fn(), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(effect).not.toHaveBeenCalled()
    await expect(owner.run(effect, undefined as never, new AbortController().signal)).rejects.toThrow(TypeError)
  })
  it('rechecks caller authority after ignored cancellation and blocks later effects without dropping the raw child', async () => {
    const owner = new TaskGroupRequestScope(), raw = deferred<void>(), controller = new AbortController(), later = vi.fn()
    const request = owner.run(async () => { await owner.retainRaw(raw.promise); owner.assertCurrent(); later() }, () => {}, controller.signal)
    const rejected = expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort(); await Promise.resolve(); expect(owner.pendingCount).toBe(1); expect(later).not.toHaveBeenCalled()
    raw.resolve(); await rejected; expect(owner.pendingCount).toBe(0)
  })
  it('joins a raw child and its accepted cleanup even when the wrapper has already failed', async () => {
    const owner = new TaskGroupRequestScope(), raw = deferred<void>(), cleanup = deferred<void>(), controller = new AbortController()
    const cleaned = vi.fn(), failure = new Error('Request deadline')
    const request = owner.run(async () => {
      owner.retainRaw(raw.promise.finally(() => owner.detached(async () => { await cleanup.promise; cleaned() })))
      throw failure
    }, () => {}, controller.signal)
    const rejected = expect(request).rejects.toBe(failure)
    controller.abort(); raw.resolve(); await Promise.resolve(); expect(owner.pendingCount).toBe(1)
    cleanup.resolve(); await rejected; expect(cleaned).toHaveBeenCalledOnce(); expect(owner.pendingCount).toBe(0)
  })
  it('preserves authority errors at every nested boundary and isolates independent callers', async () => {
    const owner = new TaskGroupRequestScope(), waiting = deferred<void>(), first = new AbortController(), denied = new Error('Scope withdrawn')
    let allowed = true
    const a = owner.run(async () => { await waiting.promise; owner.assertCurrent() }, () => { if (!allowed) throw denied }, first.signal)
    const rejected = expect(a).rejects.toBe(denied)
    const b = owner.run(async () => { owner.assertCurrent(); return 'other caller' }, () => {}, new AbortController().signal)
    allowed = false; expect(await b).toBe('other caller'); waiting.resolve(); await rejected
    owner.assertCurrent()
  })
  it('fences inherited callbacks after completion while explicitly detached background work remains valid', async () => {
    const owner = new TaskGroupRequestScope(), later = deferred<void>(), background = deferred<void>(), controller = new AbortController()
    let inherited!: Promise<void>, detached!: Promise<void>
    await owner.run(async () => {
      inherited = later.promise.then(() => owner.assertCurrent())
      detached = owner.detached(() => background.promise.then(() => owner.assertCurrent()))
    }, () => {}, controller.signal)
    const rejected = expect(inherited).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort(); later.resolve(); background.resolve(); await rejected; await detached
  })
  it('retains children accepted after parent cancellation and composes nested guards', async () => {
    const owner = new TaskGroupRequestScope(), raw = deferred<void>(), first = new AbortController(), second = new AbortController(), nested = vi.fn()
    const request = owner.run(async () => {
      await owner.run(async () => { first.abort(); owner.retainRaw(raw.promise); owner.detached(nested) }, () => {}, second.signal)
    }, () => {}, first.signal)
    const rejected = expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    await Promise.resolve(); expect(owner.pendingCount).toBe(2); raw.resolve(); await rejected; expect(nested).toHaveBeenCalledOnce()
  })
  it('binds nested-owner callbacks to their original scope even when invoked detached or by another caller', async () => {
    const owner = new TaskGroupRequestScope(), controller = new AbortController()
    let captured!: () => void
    await owner.run(async () => { captured = owner.capture()! }, () => {}, controller.signal)
    expect(() => owner.detached(captured)).toThrow('no longer current')
    await owner.run(async () => { expect(captured).toThrow('no longer current'); owner.assertCurrent() }, () => {}, new AbortController().signal)
    expect(owner.capture()).toBeUndefined()
  })
  it('retains late accepted receipts even after their inherited scope is closed', async () => {
    const owner = new TaskGroupRequestScope(), arrive = deferred<void>(), raw = deferred<void>()
    let late!: Promise<void>
    await owner.run(async () => { late = arrive.promise.then(async () => { await owner.retainRaw(raw.promise) }) }, () => {}, new AbortController().signal)
    arrive.resolve(); await Promise.resolve()
    const finished = vi.fn(), drain = owner.drain().then(finished)
    await Promise.resolve(); expect(finished).not.toHaveBeenCalled()
    raw.resolve(); await late; await drain; expect(finished).toHaveBeenCalledOnce()
  })
  it('shutdown refuses new scopes and holds drain until accepted raw work settles', async () => {
    const owner = new TaskGroupRequestScope(), raw = deferred<void>()
    const active = owner.run(async () => { await owner.retainRaw(raw.promise) }, () => {}, new AbortController().signal)
    const rejected = expect(active).rejects.toMatchObject({ code: 'CANCELLED' })
    owner.shutdown(); const drained = vi.fn(), drain = owner.drain().then(drained)
    await expect(owner.run(async () => {}, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await Promise.resolve(); expect(drained).not.toHaveBeenCalled(); raw.resolve(); await rejected; await drain
    expect(drained).toHaveBeenCalledOnce()
  })
})
