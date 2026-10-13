import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@shared/desktop-api'
import { createElectronHost, electronBrowserApi, desktopApi, desktopSupports, getDesktopHost, installDesktopHost } from './desktop-api'
const releases: Array<() => void> = []
afterEach(() => { for (const release of releases.splice(0)) release(); vi.restoreAllMocks() })
it('preserves Electron binary/file values and subscription ownership without serialization', async () => {
  const off = vi.fn(), callback = vi.fn(), file = new File(['image'], 'sample.png'), bytes = new Uint8Array([0, 255, 42])
  const bridge = { voice: { pushAudio: vi.fn().mockResolvedValue(undefined) }, webUtils: { getPathForFile: vi.fn().mockReturnValue('/tmp/sample.png') }, onTaskUpdated: vi.fn().mockReturnValue(off) } as unknown as DesktopApi
  releases.push(installDesktopHost(createElectronHost(() => bridge)))
  await desktopApi.voice.pushAudio('turn', bytes)
  expect(bridge.voice.pushAudio).toHaveBeenCalledWith('turn', bytes)
  expect(vi.mocked(bridge.voice.pushAudio).mock.calls[0]?.[1]).toBe(bytes)
  expect(desktopApi.webUtils.getPathForFile(file)).toBe('/tmp/sample.png')
  expect(bridge.webUtils.getPathForFile).toHaveBeenCalledWith(file)
  const release = desktopApi.onTaskUpdated(callback); release()
  expect(bridge.onTaskUpdated).toHaveBeenCalledWith(callback); expect(off).toHaveBeenCalledOnce()
})
it('reads the current Electron bridge at call time and restores the previous host once', async () => {
  let bridge = { settings: { get: vi.fn().mockResolvedValue('first') } } as unknown as DesktopApi
  const previous = getDesktopHost(), host = createElectronHost(() => bridge)
  const release = installDesktopHost(host); releases.push(release)
  expect(desktopSupports('settings.get')).toBe(true); expect(desktopSupports('terminal.write')).toBe(false)
  expect(await desktopApi.settings.get('theme')).toBe('first')
  bridge = { settings: { get: vi.fn().mockResolvedValue('second') } } as unknown as DesktopApi
  expect(await desktopApi.settings.get('theme')).toBe('second')
  release(); release(); expect(getDesktopHost()).toBe(previous)
})

it('keeps legacy browser access confined to Electron even with a stale preload', () => {
  const browser = { registerBrokerPanel: vi.fn() }
  const electron = createElectronHost(() => ({ browser }) as unknown as DesktopApi)
  releases.push(installDesktopHost(electron))
  expect(electronBrowserApi()).toBe(browser)
  releases.push(installDesktopHost({ ...electron, kind: 'tauri' }))
  expect(electronBrowserApi()).toBeUndefined()
})
