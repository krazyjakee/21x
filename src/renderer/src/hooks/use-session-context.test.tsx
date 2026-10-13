import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { CommanderEvent } from '@shared/commander'
import { DEFAULT_ROLLOVER_POLICY, type SessionContextScope, type SessionContextSnapshot } from '@shared/session-context'
const mocks = vi.hoisted(() => ({ getSnapshot: vi.fn(), setPolicy: vi.fn(), events: null as ((event: CommanderEvent) => void) | null, unsubscribe: vi.fn() }))
vi.mock('@/lib/ipc-client', () => ({ sessionContextApi: mocks, commanderApi: { onEvent: (listener: (event: CommanderEvent) => void) => { mocks.events = listener; return mocks.unsubscribe } }, onAgentStatus: () => () => {}, onTranscriptChanged: () => () => {} }))
import { useSessionContext } from './use-session-context'

function snapshot(scope: SessionContextScope, tokens: number): SessionContextSnapshot {
  return { scope, generation: null, usage: { tokens, source: 'reported', contextWindow: 10000, model: 'model', observedAt: 1 }, counters: { compactions: 0, wakeups: 0, turns: 0, ageMs: 0 }, policy: { ...DEFAULT_ROLLOVER_POLICY }, reasons: [], warnings: [], summaries: [] }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { resolve, promise } }
function Harness({ ownerId = 's1', name = 'reading' }: { ownerId?: string; name?: string }) {
  const state = useSessionContext({ kind: 'commander', ownerId })
  return <output aria-label={name}>{state.error ? 'Unavailable' : state.snapshot?.usage.tokens ?? 'Unknown'}</output>
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.events = null; vi.spyOn(document, 'hidden', 'get').mockReturnValue(false) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('scoped context snapshot reads', () => {
  it('shares one read and polling cadence for the same owner and coalesces terminal events', async () => {
    mocks.getSnapshot.mockImplementation(async scope => snapshot(scope, 1000))
    await act(async () => { render(<><Harness name="first" /><Harness name="second" /></>) })
    expect(mocks.getSnapshot).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('first')).toHaveTextContent('1000'); expect(screen.getByLabelText('second')).toHaveTextContent('1000')
    await act(async () => { mocks.events?.({ type: 'turn_started', sessionId: 's1', turnId: 't' }); mocks.events?.({ type: 'turn_event', sessionId: 's1', turnId: 't', event: { type: 'done', stopReason: 'end_turn' } }); await vi.advanceTimersByTimeAsync(100) })
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(4900) })
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(3)
  })
  it('pauses hidden polling and refreshes on visibility without leaving a timer after unmount', async () => {
    mocks.getSnapshot.mockImplementation(async scope => snapshot(scope, 2000))
    const view = render(<Harness />); await act(async () => {})
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(mocks.getSnapshot).toHaveBeenCalledOnce()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(2)
    view.unmount(); expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(2)
  })
  it('fences late responses across owner changes and rejects foreign snapshots', async () => {
    const old = deferred<SessionContextSnapshot>()
    mocks.getSnapshot.mockImplementation(scope => scope.ownerId === 's1' ? old.promise : Promise.resolve(snapshot(scope, 3000)))
    const view = render(<Harness />)
    await act(async () => { view.rerender(<Harness ownerId="s2" />) })
    expect(screen.getByLabelText('reading')).toHaveTextContent('3000')
    await act(async () => old.resolve(snapshot({ kind: 'commander', ownerId: 's1' }, 9999)))
    expect(screen.getByLabelText('reading')).toHaveTextContent('3000')
    mocks.getSnapshot.mockResolvedValue(snapshot({ kind: 'captain', ownerId: 'foreign' }, 9999))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByLabelText('reading')).toHaveTextContent('Unavailable')
  })
  it('clears cached values after a failed refresh rather than claiming stale usage', async () => {
    mocks.getSnapshot.mockImplementation(async scope => snapshot(scope, 4000))
    await act(async () => { render(<Harness />) })
    expect(screen.getByLabelText('reading')).toHaveTextContent('4000')
    mocks.getSnapshot.mockRejectedValue(new Error('Database unavailable'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByLabelText('reading')).toHaveTextContent('Unavailable')
  })
})
