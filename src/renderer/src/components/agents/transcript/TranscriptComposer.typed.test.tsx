import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TranscriptComposer } from './TranscriptComposer'
import { insertAndSubmit, setActiveComposer, clearActiveComposer } from '@/lib/voice-dictation-target'

/**
 * #137: only text the user typed and sent with Enter or the Send button is
 * reported as typed (it may back a merge grant). Dictated or programmatic
 * sends go out as usual but are never reported.
 */
describe('TranscriptComposer typed-message reporting', () => {
  afterEach(() => {
    cleanup()
    clearActiveComposer()
    vi.clearAllMocks()
  })

  it('reports Enter and the Send button as typed', () => {
    const onSend = vi.fn()
    const onTypedMessage = vi.fn()
    render(<TranscriptComposer onSend={onSend} onTypedMessage={onTypedMessage} taskId="captain-1" isStarting={false} />)
    const field = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.change(field, { target: { value: 'merge the ready PRs' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onTypedMessage).toHaveBeenCalledWith('merge the ready PRs')
    expect(onSend).toHaveBeenCalledWith('merge the ready PRs', undefined)

    fireEvent.change(field, { target: { value: 'and #12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(onTypedMessage).toHaveBeenLastCalledWith('and #12')
  })

  it('does not report a dictated sentence submitted by voice', () => {
    const onSend = vi.fn()
    const onTypedMessage = vi.fn()
    render(<TranscriptComposer onSend={onSend} onTypedMessage={onTypedMessage} taskId="captain-1" isStarting={false} />)
    setActiveComposer('captain-1')
    expect(insertAndSubmit('merge everything')).toBe(true)
    expect(onSend).toHaveBeenCalledWith('merge everything', undefined)
    expect(onTypedMessage).not.toHaveBeenCalled()
  })
})
