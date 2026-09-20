import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TranscriptComposer } from './TranscriptComposer'
import { insertAndSubmit, insertDictation, setActiveComposer, clearActiveComposer } from '@/lib/voice-dictation-target'

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

  it('reports Enter and the Send button as typed', async () => {
    const onSend = vi.fn()
    const onTypedMessage = vi.fn()
    render(<TranscriptComposer onSend={onSend} onTypedMessage={onTypedMessage} taskId="captain-1" isStarting={false} />)
    const field = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.change(field, { target: { value: 'merge the ready PRs' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onTypedMessage).toHaveBeenCalledWith('merge the ready PRs')
    expect(onSend).toHaveBeenCalledWith('merge the ready PRs', undefined)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled())
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
  it('keeps a restored dictated draft untyped after a failed send', async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const onTypedMessage = vi.fn()
    render(<TranscriptComposer onSend={onSend} onTypedMessage={onTypedMessage} taskId="captain-1" isStarting={false} />)
    setActiveComposer('captain-1')
    expect(insertDictation('merge PRs')).toBe(true)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled())
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('merge PRs')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onTypedMessage).not.toHaveBeenCalled()
  })

  it.each(['Enter', 'Send'])('does not relabel a dictated draft when manually submitted with %s', async (method) => {
    const onSend = vi.fn()
    const onTypedMessage = vi.fn()
    render(<TranscriptComposer onSend={onSend} onTypedMessage={onTypedMessage} taskId="captain-1" isStarting={false} />)
    setActiveComposer('captain-1')
    expect(insertDictation('merge PRs')).toBe(true)
    if (method === 'Enter') fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    else fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(onSend).toHaveBeenCalledWith('merge PRs', undefined)
    expect(onTypedMessage).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'merge PR #12' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onTypedMessage).toHaveBeenCalledWith('merge PR #12')
  })

})
