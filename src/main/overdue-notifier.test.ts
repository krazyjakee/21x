import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OverdueNotifier } from './overdue-notifier'

describe('application overdue notifier', () => {
  const owners: OverdueNotifier[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const owner of owners.splice(0)) owner.shutdown()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  function fixture(notify = vi.fn()) {
    const owner = new OverdueNotifier(notify)
    owners.push(owner)
    return { owner, notify }
  }

  it('keeps one minute cadence across repeated starts instead of adding or postponing ticks', async () => {
    const { owner, notify } = fixture()
    owner.start()
    await vi.advanceTimersByTimeAsync(30_000)
    owner.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(notify).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(notify).toHaveBeenCalledTimes(3)
  })

  it('continues without a window and resolves a recreated or hidden renderer at dispatch time', async () => {
    const first = { send: vi.fn(), hidden: false }
    const replacement = { send: vi.fn(), hidden: true }
    let current: typeof first | null = first
    const { owner } = fixture(vi.fn(() => current?.send()))
    owner.start()
    await vi.advanceTimersByTimeAsync(60_000)
    current = null
    await vi.advanceTimersByTimeAsync(60_000)
    current = replacement
    owner.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(first.send).toHaveBeenCalledOnce()
    expect(replacement.send).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('cancels its timer and fences an already queued callback during final shutdown', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const { owner, notify } = fixture()
    owner.start()
    const callback = interval.mock.calls[0][0] as () => void
    owner.shutdown()
    callback()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(notify).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => owner.start()).toThrow('OVERDUE_NOTIFIER_CLOSED')
  })

  it('keeps later ticks after a delivery failure and rejects startup after an early shutdown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { owner, notify } = fixture(vi.fn().mockImplementationOnce(() => { throw new Error('fixture window unavailable') }))
    owner.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(notify).toHaveBeenCalledTimes(2)
    const early = fixture().owner
    early.shutdown()
    expect(() => early.start()).toThrow('OVERDUE_NOTIFIER_CLOSED')
  })
})
