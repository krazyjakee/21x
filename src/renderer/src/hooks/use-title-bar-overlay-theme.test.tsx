import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'

const os = vi.hoisted(() => ({ platform: 'linux' }))
vi.mock('@/lib/platform', () => ({ get platform() { return os.platform } }))
function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
async function fixture(document = true) {
  const { installDesktopHost } = await import('@/lib/desktop-api')
  const { createNativeDesktopHost } = await import('@/lib/native-desktop-host')
  let lease: string | undefined = document ? 'document-1' : undefined
  let handle: (() => Promise<void>) | undefined
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', ...(lease ? { uiLeaseId: lease } : {}) }
    if (args?.operation !== 'app:setTitleBarOverlay') throw new Error('Only decoration may be invoked')
    await handle?.()
    return { engineEpoch: 'engine-1', result: { defined: false } }
  })
  const native = { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } } as unknown as TauriDesktopApi
  const host = createNativeDesktopHost(native), release = installDesktopHost(host)
  host.setRehydrator(async () => {})
  await host.reconnect()
  const callbacks: Array<() => void> = [], offs: Array<ReturnType<typeof vi.fn>> = []
  const subscribe = host.subscribeConnection
  vi.spyOn(host, 'subscribeConnection').mockImplementation(callback => {
    callbacks.push(callback)
    const off = vi.fn(subscribe(callback)); offs.push(off); return off
  })
  const { useTitleBarOverlayTheme } = await import('./use-title-bar-overlay-theme')
  const { useThemeStore } = await import('@/stores/theme-store')
  return { host, invoke, release, callbacks, offs, useTitleBarOverlayTheme, useThemeStore,
    setLease: (value: string | undefined) => { lease = value },
    setHandler: (value: (() => Promise<void>) | undefined) => { handle = value },
    calls: () => invoke.mock.calls.filter(([command]) => command === 'desktop_invoke') }
}
let f: Awaited<ReturnType<typeof fixture>> | undefined
const legacy = window.electronAPI
const releases: Array<() => void> = []
function colors(color = '#141414', symbolColor = '#8e8d91') {
  document.documentElement.style.setProperty('--background', color)
  document.documentElement.style.setProperty('--muted-foreground', symbolColor)
}
beforeEach(() => {
  vi.resetModules(); os.platform = 'linux'
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  colors()
})
afterEach(() => {
  cleanup(); f?.release(); f = undefined
  for (const release of releases.splice(0)) release()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('--background')
  document.documentElement.style.removeProperty('--muted-foreground')
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy })
})

it('paints exact current-document RGB colors through the typed native transport and follows theme changes', async () => {
  f = await fixture(); const current = f
  renderHook(current.useTitleBarOverlayTheme)
  await waitFor(() => expect(current.calls()).toHaveLength(1))
  expect(current.calls()[0][1]).toEqual({ operation: 'app:setTitleBarOverlay', payload: { colors: { color: '#141414', symbolColor: '#8e8d91' } }, engineEpoch: 'engine-1', uiLease: 'document-1' })
  colors('#f4f4f5', '#333333')
  act(() => current.useThemeStore.getState().setMode(current.useThemeStore.getState().resolved === 'dark' ? 'light' : 'dark'))
  await waitFor(() => expect(current.calls()).toHaveLength(2))
  expect(current.calls()[1][1]?.payload).toEqual({ colors: { color: '#f4f4f5', symbolColor: '#333333' } })
})

it('waits for successful recovery then repaints once with the replacement physical-document receipt', async () => {
  f = await fixture(); const current = f
  renderHook(current.useTitleBarOverlayTheme)
  const barrier = held<void>(); current.host.setRehydrator(() => barrier.promise); current.setLease('document-2')
  let reconnect!: Promise<void>
  act(() => { reconnect = current.host.reconnect() })
  await waitFor(() => expect(current.host.connection.status).toBe('ready'))
  expect(current.host.hydrationPending).toBe(true)
  expect(current.calls()).toHaveLength(1)
  await act(async () => { barrier.resolve(); await reconnect })
  expect(current.calls()).toHaveLength(2)
  expect(current.calls()[1][1]?.uiLease).toBe('document-2')
  current.callbacks.at(-1)!(); current.callbacks.at(-1)!()
  expect(current.calls()).toHaveLength(2)
})

it('keeps failed recovery fenced and repaints only after an explicit successful retry', async () => {
  f = await fixture(); const current = f
  renderHook(current.useTitleBarOverlayTheme)
  current.host.setRehydrator(async () => { throw new Error('controlled recovery refusal') })
  await act(async () => { await expect(current.host.reconnect()).rejects.toThrow('controlled recovery refusal') })
  expect(current.calls()).toHaveLength(1)
  current.host.setRehydrator(async () => {})
  await act(async () => { await current.host.rehydrate() })
  expect(current.calls()).toHaveLength(2)
})

it('catches an unavailable native service without a retry loop or preload fallback', async () => {
  f = await fixture(); const current = f
  current.setHandler(async () => { throw { code: 'UNKNOWN_OPERATION' } })
  renderHook(current.useTitleBarOverlayTheme)
  await waitFor(() => expect(current.calls()).toHaveLength(1))
  await act(async () => { await Promise.resolve() })
  for (const callback of current.callbacks) { callback(); callback() }
  expect(current.calls()).toHaveLength(1)
  expect(current.host.connection.status).toBe('ready')
})

it('refuses a missing document before invoke and can repaint after receipt-bearing reconnect', async () => {
  f = await fixture(false); const current = f
  renderHook(current.useTitleBarOverlayTheme)
  await act(async () => { await Promise.resolve() })
  expect(current.calls()).toHaveLength(0)
  current.setLease('document-2')
  await act(async () => { await current.host.reconnect() })
  expect(current.calls()).toHaveLength(1)
  expect(current.calls()[0][1]?.uiLease).toBe('document-2')
})

it.each(['#fff', 'rgb(1, 2, 3)', 'url(https://example.invalid)', 'var(--other)', '#123456; color:red'])('does not turn arbitrary CSS into native decoration authority: %s', async invalid => {
  f = await fixture()
  // Supply the computed token directly: the DOM style parser may sanitize a
  // semicolon before the hook can observe it. Native authority validates the
  // actual computed value, regardless of its stylesheet source.
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => name === '--background' ? invalid : '#8e8d91' }))
  renderHook(f.useTitleBarOverlayTheme)
  await act(async () => { await Promise.resolve() })
  expect(f.calls()).toHaveLength(0)
})

it('retires observers on pagehide and unmount so queued callbacks cannot repaint', async () => {
  f = await fixture(); const current = f
  const view = renderHook(current.useTitleBarOverlayTheme)
  const retired = current.callbacks[0]
  act(() => { window.dispatchEvent(new Event('pagehide')) })
  expect(current.offs[0]).toHaveBeenCalledTimes(1)
  colors('#f4f4f5')
  retired()
  await act(async () => { await current.host.reconnect() })
  expect(current.calls()).toHaveLength(1)
  view.unmount()
  expect(current.offs[0]).toHaveBeenCalledTimes(1)
})

it('catches a held old result after reconnect without retrying or repainting the retired document', async () => {
  f = await fixture(); const current = f
  const pending = held<void>(); current.setHandler(() => pending.promise)
  renderHook(current.useTitleBarOverlayTheme)
  await waitFor(() => expect(current.calls()).toHaveLength(1))
  current.setHandler(undefined); current.setLease('document-2')
  await act(async () => { await current.host.reconnect() })
  expect(current.calls()).toHaveLength(2)
  await act(async () => { pending.resolve(); await Promise.resolve() })
  expect(current.calls()).toHaveLength(2)
  expect(current.calls()[1][1]?.uiLease).toBe('document-2')
})

it('leaves macOS native chrome with its native owner', async () => {
  os.platform = 'darwin'; f = await fixture()
  renderHook(f.useTitleBarOverlayTheme)
  expect(f.calls()).toHaveLength(0)
  expect(f.callbacks).toHaveLength(0)
})

it.each(['sync', 'async'] as const)('preserves Electron decoration and catches %s bridge refusal without a native subscription', async kind => {
  const { createElectronHost, installDesktopHost } = await import('@/lib/desktop-api')
  const paint = vi.fn(() => { if (kind === 'sync') throw new Error('refused'); return Promise.reject(new Error('refused')) })
  const host = createElectronHost(() => ({ app: { setTitleBarOverlay: paint } }) as unknown as Window['electronAPI'])
  const subscribe = vi.spyOn(host, 'subscribeConnection')
  releases.push(installDesktopHost(host))
  const { useTitleBarOverlayTheme } = await import('./use-title-bar-overlay-theme')
  colors('rgb(1, 2, 3)')
  renderHook(useTitleBarOverlayTheme)
  await act(async () => { await Promise.resolve() })
  expect(paint).toHaveBeenCalledWith({ color: 'rgb(1, 2, 3)', symbolColor: '#8e8d91' })
  expect(subscribe).not.toHaveBeenCalled()
})

it('waits when mounted during the initial hydration barrier and paints once after it clears', async () => {
  f = await fixture(); const current = f, barrier = held<void>()
  current.host.setRehydrator(() => barrier.promise)
  const recovering = current.host.rehydrate()
  renderHook(current.useTitleBarOverlayTheme)
  expect(current.calls()).toHaveLength(0)
  await act(async () => { barrier.resolve(); await recovering })
  expect(current.calls()).toHaveLength(1)
})
