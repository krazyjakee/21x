import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCallChoice, readCallText, rememberCallChoice } from './call-preferences'

beforeEach(() => localStorage.clear())
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); localStorage.clear() })

describe('Commander call preferences', () => {
  it('reads back a remembered choice', () => {
    rememberCallChoice('caption-size', 'large')
    expect(readCallChoice('caption-size', ['small', 'large'], 'small')).toBe('large')
    rememberCallChoice('input-device', 'opaque-id')
    expect(readCallText('input-device')).toBe('opaque-id')
  })
  it('falls back from a value that is no longer valid', () => {
    localStorage.setItem('commander-call:pip-corner', 'middle')
    expect(readCallChoice('pip-corner', ['top-left'], 'top-left')).toBe('top-left')
  })
  it('keeps working when storage does not', () => {
    const denied = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied })
    expect(() => rememberCallChoice('captions', 'off')).not.toThrow()
    expect(readCallChoice('captions', ['on', 'off'], 'on')).toBe('on')
    expect(readCallText('input-device')).toBe('')
  })
  it('restores the choices when the app starts again', async () => {
    localStorage.setItem('commander-call:mic-mode', 'push-to-talk')
    localStorage.setItem('commander-call:input-device', 'opaque-id')
    localStorage.setItem('commander-call:captions', 'off')
    localStorage.setItem('commander-call:caption-size', 'large')
    localStorage.setItem('commander-call:pip-corner', 'top-left')
    vi.resetModules()
    const { useCommanderCallStore } = await import('@/stores/commander-call-store')
    const { useCommanderCallUiStore } = await import('@/stores/commander-call-ui-store')
    expect(useCommanderCallStore.getState()).toMatchObject({ micMode: 'push-to-talk', inputDeviceId: 'opaque-id' })
    expect(useCommanderCallUiStore.getState()).toMatchObject({ captions: false, captionSize: 'large', corner: 'top-left' })
  })
  it('remembers what the user chooses during a call', async () => {
    vi.resetModules()
    const { useCommanderCallStore } = await import('@/stores/commander-call-store')
    const { useCommanderCallUiStore } = await import('@/stores/commander-call-ui-store')
    await useCommanderCallStore.getState().setMicMode('push-to-talk')
    await useCommanderCallStore.getState().setInputDevice('opaque-id')
    useCommanderCallUiStore.getState().toggleCaptions()
    useCommanderCallUiStore.getState().setCaptionSize('small')
    useCommanderCallUiStore.getState().setCorner('top-right')
    expect(localStorage.getItem('commander-call:mic-mode')).toBe('push-to-talk')
    expect(localStorage.getItem('commander-call:input-device')).toBe('opaque-id')
    expect(localStorage.getItem('commander-call:captions')).toBe('off')
    expect(localStorage.getItem('commander-call:caption-size')).toBe('small')
    expect(localStorage.getItem('commander-call:pip-corner')).toBe('top-right')
  })
})
