import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DesktopApi } from '@shared/desktop-api'
import type { NativeDesktopHost } from '@/lib/native-desktop-host'
import { createElectronHost, installDesktopHost } from '@/lib/desktop-api'
import { DesktopHostStatus } from './DesktopHostStatus'
const releases: Array<() => void> = []
afterEach(() => { cleanup(); for (const release of releases.splice(0)) release() })
it('keeps existing Electron chrome unchanged', () => {
  releases.push(installDesktopHost(createElectronHost()))
  render(<DesktopHostStatus />)
  expect(screen.queryByLabelText('Desktop connection')).toBeNull()
})
it('makes failed native recovery visible and leaves the user a keyboard-accessible retry', async () => {
  const reconnect = vi.fn().mockRejectedValue(new Error('private native detail'))
  const host: NativeDesktopHost = { kind: 'tauri', api: {} as DesktopApi, connection: { status: 'disconnected', engineEpoch: null }, hydrationPending: true, recoveryFailed: true, unavailableCapability: null, supports: () => false, subscribeConnection: () => () => {}, reconnect, rehydrate: async () => {}, setRehydrator: () => {}, dispose: () => {} }
  releases.push(installDesktopHost(host))
  render(<DesktopHostStatus />)
  expect(screen.getByLabelText('Desktop connection')).toHaveTextContent('Changes are paused.')
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not restore the desktop connection. Try again.')
  expect(screen.getByRole('button', { name: 'Reconnect' })).not.toBeDisabled()
  expect(screen.queryByText('private native detail')).toBeNull()
})

it('shows known provisioning failure guidance without presenting reconnect as a bootstrap retry', () => {
  const reconnect = vi.fn()
  const host: NativeDesktopHost = { kind: 'tauri', api: {} as DesktopApi, connection: { status: 'disconnected', engineEpoch: null }, hydrationPending: true, recoveryFailed: false,
    bootstrapFailure: 'Desktop process supervision is unavailable. Provision the native environment and relaunch the app. Changes are paused.', unavailableCapability: null,
    supports: () => false, subscribeConnection: () => () => {}, reconnect, rehydrate: async () => {}, setRehydrator: () => {}, dispose: () => {} }
  releases.push(installDesktopHost(host)); render(<DesktopHostStatus />)
  expect(screen.getByLabelText('Desktop connection')).toHaveTextContent('Provision the native environment and relaunch')
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  expect(reconnect).not.toHaveBeenCalled()
})
