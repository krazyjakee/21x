import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installDesktopHost } from '@/lib/desktop-api'
import { createNativeDesktopHost } from '@/lib/native-desktop-host'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import { AppPreferencesSection } from './tabs/general/AppPreferencesSection'
import { UpdatesSection } from './tabs/general/UpdatesSection'
import { UpdateDialog } from '../update/UpdateDialog'

function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }
function fixture() {
  const values = new Map<string, unknown>([
    ['app:getVersion', '0.0.161'], ['app:getNotificationPermission', 'granted'],
    ['app:getMinimizeToTray', true], ['app:setMinimizeToTray', false], ['settings:get', 'false']
  ])
  const handlers = new Map<string, () => Promise<unknown>>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document-1' }
    const operation = String(args?.operation)
    const value = handlers.has(operation) ? await handlers.get(operation)!() : values.get(operation)
    return { engineEpoch: 'engine-1', result: value === undefined ? { defined: false } : { defined: true, value } }
  })
  const native = { core: { invoke }, event: { listen: vi.fn(async () => vi.fn()) } } as unknown as TauriDesktopApi
  const host = createNativeDesktopHost(native)
  host.setRehydrator(async () => {})
  return { host, values, handlers, invoke,
    calls: (operation: string) => invoke.mock.calls.filter(([, args]) => args?.operation === operation) }
}

let f: ReturnType<typeof fixture>, release: () => void
const legacyBridge = window.electronAPI
beforeEach(async () => {
  f = fixture(); release = installDesktopHost(f.host); await f.host.reconnect()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
})
afterEach(() => {
  cleanup(); release()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacyBridge })
})

it('loads supported notification/tray preferences independently of unavailable login and preserves its exact native receipt', async () => {
  render(<AppPreferencesSection />)
  const tray = screen.getByRole('switch', { name: 'Minimize to tray' })
  await waitFor(() => expect(tray).toBeEnabled())
  expect(tray).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('switch', { name: 'Enable notifications' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('switch', { name: 'Launch at startup' })).toBeDisabled()
  expect(screen.getByRole('switch', { name: 'Start Captain at launch' })).toBeDisabled()
  expect(f.calls('app:getLoginItemSettings')).toHaveLength(0)
  expect(screen.queryByText('These application preferences are unavailable in this preview.')).toBeNull()
  fireEvent.click(tray)
  await waitFor(() => expect(tray).toHaveAttribute('aria-checked', 'false'))
  expect(f.calls('app:setMinimizeToTray')).toHaveLength(1)
  expect(f.calls('app:setMinimizeToTray')[0][1]).toMatchObject({ payload: { enabled: false }, uiLease: 'document-1' })
})

it('retains useful tray state when another native preference fails and never displays raw diagnostics', async () => {
  f.handlers.set('app:getNotificationPermission', async () => { throw { code: 'DISCONNECTED', detail: 'private-credential-canary' } })
  render(<AppPreferencesSection />)
  const tray = screen.getByRole('switch', { name: 'Minimize to tray' })
  await waitFor(() => expect(tray).toBeEnabled())
  expect(tray).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('alert')).toHaveTextContent('Some preferences could not be loaded.')
  expect(document.body.textContent).not.toContain('private-credential-canary')
})

it('keeps a refused preference unchanged and reports an explicit retry boundary', async () => {
  f.handlers.set('app:setMinimizeToTray', async () => { throw { code: 'DISCONNECTED' } })
  render(<AppPreferencesSection />)
  const tray = screen.getByRole('switch', { name: 'Minimize to tray' })
  await waitFor(() => expect(tray).toBeEnabled())
  fireEvent.click(tray)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Check its current value before trying again.'))
  expect(tray).toHaveAttribute('aria-checked', 'true')
  expect(f.calls('app:setMinimizeToTray')).toHaveLength(1)
})

it('discards an old preference read during same-epoch reconnect and reads the current native owner once', async () => {
  const old = held<unknown>(); f.handlers.set('app:getMinimizeToTray', () => old.promise)
  render(<AppPreferencesSection />)
  await waitFor(() => expect(f.calls('app:getMinimizeToTray')).toHaveLength(1))
  f.handlers.delete('app:getMinimizeToTray'); f.values.set('app:getMinimizeToTray', false)
  await act(async () => { await f.host.reconnect(); old.resolve(true) })
  const tray = screen.getByRole('switch', { name: 'Minimize to tray' })
  await waitFor(() => expect(tray).toBeEnabled())
  expect(tray).toHaveAttribute('aria-checked', 'false')
  expect(f.calls('app:getMinimizeToTray')).toHaveLength(2)
  expect(f.calls('app:setMinimizeToTray')).toHaveLength(0)
})

it('retires preference callbacks on unmount without replaying reads or a mutation on reconnect', async () => {
  const old = held<unknown>(); f.handlers.set('app:getMinimizeToTray', () => old.promise)
  const view = render(<AppPreferencesSection />)
  await waitFor(() => expect(f.calls('app:getMinimizeToTray')).toHaveLength(1))
  view.unmount()
  await f.host.reconnect(); old.resolve(true)
  expect(f.calls('app:getMinimizeToTray')).toHaveLength(1)
  expect(f.calls('app:setMinimizeToTray')).toHaveLength(0)
})

it('mounts the closed production update dialog without an unsupported updater call, then shows version and unavailable controls', async () => {
  const close = vi.fn(), view = render(<UpdateDialog open={false} onClose={close} />)
  await waitFor(() => expect(f.calls('app:getVersion')).toHaveLength(1))
  view.rerender(<UpdateDialog open onClose={close} />)
  await waitFor(() => expect(screen.getByText('v0.0.161')).toBeInTheDocument())
  expect(screen.getByText('Updates are unavailable in this preview.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /check for updates|download|install/i })).toBeNull()
  expect(f.invoke.mock.calls.some(([, args]) => String(args?.operation).startsWith('updater:'))).toBe(false)
  expect(f.host.unavailableCapability).toBeNull()
  fireEvent.click(screen.getByText('Close', { selector: 'button' })); expect(close).toHaveBeenCalledOnce()
})

it('uses the existing native version in general settings and exposes no unavailable update action', async () => {
  render(<UpdatesSection />)
  await waitFor(() => expect(screen.getByText('Current version: v0.0.161')).toBeInTheDocument())
  expect(screen.getByText('Updates are unavailable in this preview.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /check for updates/i })).toBeNull()
  expect(f.invoke.mock.calls.some(([, args]) => String(args?.operation).startsWith('updater:'))).toBe(false)
})

it('catches a failed native version read without invoking or retrying an updater operation', async () => {
  f.handlers.set('app:getVersion', async () => { throw { code: 'DISCONNECTED' } })
  render(<UpdateDialog open onClose={vi.fn()} />)
  await waitFor(() => expect(screen.getByText('The app version could not be loaded.')).toBeInTheDocument())
  expect(f.calls('app:getVersion')).toHaveLength(1)
  expect(f.invoke.mock.calls.some(([, args]) => String(args?.operation).startsWith('updater:'))).toBe(false)
})
