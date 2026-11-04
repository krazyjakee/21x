import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clipboard, imageFile } from '@/components/chat/paste-fixtures'
import { clearComposerDrafts } from '@/lib/composer-drafts'
import { SessionStatus } from '@/stores/agent-store'
import { AgentTranscriptPanel } from '../AgentTranscriptPanel'
import type { SaveImagesHandler, SendHandler } from './TranscriptComposer'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 120,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 120, size: 120 })),
    scrollToIndex: vi.fn(),
    measureElement: vi.fn()
  })
}))

const field = (): HTMLTextAreaElement => screen.getByLabelText('Message the agent') as HTMLTextAreaElement

/**
 * The Captain column is one composer over many Captains: it renders the panel
 * keyed by the Captain's task, so flipping projects replaces it. Nothing typed
 * for one Captain may be on screen for the next, or be lost on the way back.
 */
function captain(draftKey: string, { onSend = vi.fn(), onSaveImages = vi.fn(async () => []) }: { onSend?: SendHandler; onSaveImages?: SaveImagesHandler } = {}) {
  return (
    <AgentTranscriptPanel
      key={draftKey}
      draftKey={draftKey}
      messages={[]}
      status={SessionStatus.IDLE}
      onStop={() => undefined}
      onSend={onSend}
      onSaveImages={onSaveImages}
    />
  )
}

afterEach(() => {
  cleanup()
  clearComposerDrafts()
  vi.clearAllMocks()
})

describe('Captain composer: a draft stays with its Captain', () => {
  it('hides a draft from the next Captain and sends it only to its own', async () => {
    const onSendA = vi.fn()
    const onSendB = vi.fn()
    const view = render(captain('captain-a', { onSend: onSendA }))
    field().value = 'half a thought'

    view.rerender(captain('captain-b', { onSend: onSendB }))
    expect(field().value).toBe('')
    fireEvent.click(screen.getByLabelText('Send message'))
    expect(onSendB).not.toHaveBeenCalled()

    view.rerender(captain('captain-a', { onSend: onSendA }))
    expect(field().value).toBe('half a thought')
    fireEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(onSendA).toHaveBeenCalledWith('half a thought', undefined))
    expect(onSendB).not.toHaveBeenCalled()
  })

  it('does not hand a sent message back as a draft', async () => {
    const onSend = vi.fn()
    const view = render(captain('captain-a', { onSend }))
    field().value = 'sent already'
    fireEvent.click(screen.getByLabelText('Send message'))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))

    view.rerender(captain('captain-b'))
    view.rerender(captain('captain-a', { onSend }))

    expect(field().value).toBe('')
  })

  it('keeps pasted images with their Captain', async () => {
    const view = render(captain('captain-a'))
    fireEvent.paste(field(), { clipboardData: clipboard({ files: [imageFile('diagram.png')] }) })
    await screen.findByRole('img', { name: 'diagram.png' })

    view.rerender(captain('captain-b'))
    expect(screen.queryByRole('img', { name: 'diagram.png' })).toBeNull()

    view.rerender(captain('captain-a'))
    expect(await screen.findByRole('img', { name: 'diagram.png' })).toBeInTheDocument()
  })

  it('returns a message whose send failed after the user flipped away', async () => {
    let refuse!: (reason: Error) => void
    const onSend = vi.fn()
    const onSaveImages: SaveImagesHandler = () => new Promise((_, reject) => { refuse = reject })
    const view = render(captain('captain-a', { onSend, onSaveImages }))
    fireEvent.paste(field(), { clipboardData: clipboard({ files: [imageFile('diagram.png')] }) })
    await screen.findByRole('img', { name: 'diagram.png' })
    field().value = 'with a picture'
    fireEvent.click(screen.getByLabelText('Send message'))

    view.rerender(captain('captain-b'))
    await act(async () => { refuse(new Error('Disk full')); await new Promise((resolve) => setTimeout(resolve, 0)) })

    view.rerender(captain('captain-a', { onSend, onSaveImages }))
    expect(field().value).toBe('with a picture')
    expect(await screen.findByRole('img', { name: 'diagram.png' })).toBeInTheDocument()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps no draft for a composer without a key', () => {
    const view = render(
      <AgentTranscriptPanel messages={[]} status={SessionStatus.IDLE} onStop={() => undefined} onSend={vi.fn()} taskId="task-a" />
    )
    field().value = 'typed in a task'
    view.unmount()

    render(<AgentTranscriptPanel messages={[]} status={SessionStatus.IDLE} onStop={() => undefined} onSend={vi.fn()} taskId="task-a" />)
    expect(field().value).toBe('')
  })
})
