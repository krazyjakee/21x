import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { useUIStore } from '@/stores/ui-store'
import { useVoiceStore } from '@/stores/voice-store'
import { useCommanderCallShortcuts } from './use-call-shortcuts'

function Harness() {
  useCommanderCallShortcuts()
  return <>
    <textarea aria-label="Task notes" />
    <div className="xterm"><textarea aria-label="Terminal input" /></div>
    <div data-testid="commander-composer"><textarea aria-label="Message the Commander" /></div>
  </>
}
const captionsChord = { key: 'c', ctrlKey: true, shiftKey: true }
const endChord = { key: 'e', ctrlKey: true, shiftKey: true }

beforeEach(() => {
  __resetCommanderCall()
  useCommanderCallUiStore.setState({ captions: true })
  useCommanderCallStore.setState({ status: 'live', sessionId: 's1', turnId: 'mic' })
  useUIStore.setState({ sidebarView: 'tasks', activeModal: null })
  useVoiceStore.setState({ turnId: 'mic' })
  render(<Harness />)
})
afterEach(() => { cleanup(); __resetCommanderCall(); useVoiceStore.setState({ turnId: null }); vi.restoreAllMocks() })

describe('Commander call shortcuts', () => {
  it.each(['Task notes', 'Terminal input'])('leaves every chord to %s', (name) => {
    const field = screen.getByLabelText(name)
    expect(fireEvent.keyDown(field, captionsChord)).toBe(true)
    expect(fireEvent.keyDown(field, endChord)).toBe(true)
    expect(fireEvent.keyDown(field, { key: '\\', ctrlKey: true })).toBe(true)
    expect(useCommanderCallUiStore.getState().captions).toBe(true)
    expect(useCommanderCallStore.getState().status).toBe('live')
  })
  it('keeps the call chords in the Commander composer, without taking text Undo or Mod+D', () => {
    const field = screen.getByLabelText('Message the Commander')
    const toggleMicrophone = vi.fn(async () => {})
    useCommanderCallStore.setState({ toggleMicrophone })
    expect(fireEvent.keyDown(field, captionsChord)).toBe(false)
    expect(useCommanderCallUiStore.getState().captions).toBe(false)
    expect(fireEvent.keyDown(field, { key: 'z', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(field, { key: 'd', ctrlKey: true })).toBe(true)
    expect(toggleMicrophone).not.toHaveBeenCalled()
  })
  it('stays out of an IME composition', () => {
    expect(fireEvent.keyDown(screen.getByLabelText('Message the Commander'), { ...endChord, isComposing: true })).toBe(true)
    expect(useCommanderCallStore.getState().status).toBe('live')
  })
  it('leaves a microphone another surface opened alone', () => {
    const toggleMicrophone = vi.fn(async () => {})
    useCommanderCallStore.setState({ toggleMicrophone, turnId: null, muted: true })
    useVoiceStore.setState({ turnId: 'captain' })
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    expect(toggleMicrophone).not.toHaveBeenCalled()
  })
  it('still toggles the call microphone while its own turn is opening', () => {
    const toggleMicrophone = vi.fn(async () => {})
    useCommanderCallStore.setState({ toggleMicrophone, turnId: null, micOpening: true })
    useVoiceStore.setState({ turnId: 'opening' })
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    expect(toggleMicrophone).toHaveBeenCalledOnce()
  })
  it('claims every repeat of a held Space, so nothing scrolls or presses underneath', () => {
    const beginTalk = vi.fn(async () => {})
    useCommanderCallStore.setState({ micMode: 'push-to-talk', beginTalk })
    expect(fireEvent.keyDown(window, { key: ' ', code: 'Space' })).toBe(false)
    expect(fireEvent.keyDown(window, { key: ' ', code: 'Space', repeat: true })).toBe(false)
    expect(beginTalk).toHaveBeenCalledOnce()
  })
  it('leaves a repeated Space alone when it was never a talk key', () => {
    expect(fireEvent.keyDown(window, { key: ' ', code: 'Space', repeat: true })).toBe(true)
  })
})
