import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { installDesktopHost } from '@/lib/desktop-api'
import { createNativeDesktopHost } from '@/lib/native-desktop-host'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import { useOverdueNotifications } from './use-overdue-notifications'
import { useSnoozeTick } from './use-snooze-tick'
import { TaskStatus, type Task } from '@/types'
import { useProjectStore } from '@/stores/project-store'

async function fixture() {
  let sequence = 0
  const receivers = new Set<(event: { payload: unknown }) => void>(), history: Array<(event: { payload: unknown }) => void> = []
  const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document-1' }
    return { engineEpoch: 'engine-1', result: { defined: false } }
  })
  const host = createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async (name: string, receive: (event: { payload: unknown }) => void) => {
    if (name === 'desktop:event') { receivers.add(receive); history.push(receive) }
    return () => { receivers.delete(receive) }
  }) } } as unknown as TauriDesktopApi)
  const release = installDesktopHost(host); host.setRehydrator(async () => {}); await host.reconnect()
  const envelope = (payload: unknown = {}, seq = ++sequence, engineEpoch = 'engine-1') => ({ payload: { protocolVersion: 1, kind: 'event', operation: 'overdue:check', payload, engineEpoch, sequence: seq } })
  const emit = (payload: unknown = {}, seq?: number, epoch?: string) => { for (const receive of [...receivers]) receive(envelope(payload, seq, epoch)) }
  return { host, release, invoke, emit, envelope, history }
}
const legacy = window.electronAPI
let f: Awaited<ReturnType<typeof fixture>>
const task = (id: string, fields: Partial<Task>) => ({ id, title: id, project_id: 'project_fixture', status: TaskStatus.NotStarted, due_date: null, snoozed_until: null, ...fields }) as Task
beforeEach(async () => {
  f = await fixture(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  useProjectStore.setState({ currentProjectId: 'project_fixture', projects: [] })
})
afterEach(() => { cleanup(); f.release(); vi.useRealTimers(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy }) })
function controls(tasks: Task[]) { useOverdueNotifications(tasks); return useSnoozeTick(tasks) }
const notifications = () => f.invoke.mock.calls.filter(([, args]) => (args as Record<string, unknown> | undefined)?.operation === 'notifications:show')

it('decodes empty retained advisory to the typed snooze/notification consumers without a task mutation', async () => {
  const tasks = [task('overdue', { due_date: '2020-01-01' }), task('snoozed', { snoozed_until: '2020-01-01' })]
  const { result } = renderHook(() => controls(tasks))
  await act(async () => { f.emit(); await Promise.resolve() })
  expect(result.current).toBe(1); expect(notifications()).toHaveLength(2)
  expect(notifications()[0][1]).toMatchObject({ operation: 'notifications:show', uiLease: 'document-1', payload: { title: 'Task Overdue', body: '"overdue" is past due' } })
  await act(async () => { f.emit(); await Promise.resolve() })
  expect(result.current).toBe(2); expect(notifications()).toHaveLength(2)
  expect(f.invoke.mock.calls.every(([command, args]) => command === 'engine_status' || (args as Record<string, unknown>)?.operation === 'notifications:show')).toBe(true)
})

it('rejects malformed empty-event payload without invoking a consumer or leaking extra data', async () => {
  const { result } = renderHook(() => controls([task('overdue', { due_date: '2020-01-01' })]))
  await act(async () => { f.emit({ taskId: 'forged' }); await Promise.resolve() })
  expect(result.current).toBe(0); expect(notifications()).toHaveLength(0)
  expect(f.host.connection).toMatchObject({ status: 'disconnected', reason: 'INVALID_RESULT' })
})

it('drops duplicate sequence and stale epoch, then accepts current advisory after reconnect', async () => {
  const { result } = renderHook(() => controls([]))
  act(() => { f.emit({}, 1); f.emit({}, 1); f.emit({}, 2, 'engine-old') })
  expect(result.current).toBe(1)
  await act(async () => { await f.host.reconnect(); f.emit({}, 1) })
  expect(result.current).toBe(2); expect(notifications()).toHaveLength(0)
})

it.each(['unmount', 'pagehide'] as const)('retires advisory consumers and pending timers on %s', async ending => {
  vi.useFakeTimers()
  const { result, unmount } = renderHook(() => controls([task('future', { snoozed_until: new Date(Date.now() + 60_000).toISOString() })]))
  if (ending === 'unmount') unmount()
  else act(() => { window.dispatchEvent(new Event('pagehide')) })
  act(() => { f.emit(); vi.advanceTimersByTime(120_000) })
  expect(result.current).toBe(0); expect(notifications()).toHaveLength(0)
})

it('owns notification refusal without replay or an unhandled native rejection', async () => {
  f.invoke.mockImplementation(async command => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document-1' }
    throw new Error('private-profile-canary')
  })
  renderHook(() => controls([task('overdue', { due_date: '2020-01-01' })]))
  await act(async () => { f.emit(); await new Promise(done => setTimeout(done, 0)) })
  await act(async () => { f.emit(); await Promise.resolve() })
  expect(notifications()).toHaveLength(1)
})


it('withdraws queued advisory notification work before a pagehide effect', async () => {
  renderHook(() => controls([task('overdue', { due_date: '2020-01-01' })]))
  await act(async () => { f.emit(); window.dispatchEvent(new Event('pagehide')); await Promise.resolve() })
  expect(notifications()).toHaveLength(0)
})

it('refuses an old native event listener after same-epoch reconnect', async () => {
  const { result } = renderHook(() => controls([]))
  const old = f.history[0]
  await act(async () => { await f.host.reconnect(); old(f.envelope()); await Promise.resolve() })
  expect(result.current).toBe(0)
  act(() => { f.emit() })
  expect(result.current).toBe(1)
})
