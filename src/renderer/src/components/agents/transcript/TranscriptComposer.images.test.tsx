import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describeChatImagePaste } from '@/components/chat/paste-suite'
import { clipboard, imageBytes, imageFile, toBase64 } from '@/components/chat/paste-fixtures'
import { AgentTranscriptPanel } from '../AgentTranscriptPanel'
import { SessionStatus } from '@/stores/agent-store'
import { IMAGES_UNSUPPORTED_HERE, imageOnlyMessage, type SaveImagesHandler, type SendHandler } from './TranscriptComposer'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 120,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 120, size: 120 })),
    scrollToIndex: vi.fn(),
    measureElement: vi.fn()
  })
}))

/** The task, canvas and Captain chats all render this composer through AgentTranscriptPanel. */
function mountTranscript({ onSend = vi.fn(), onSaveImages }: { onSend?: SendHandler; onSaveImages?: SaveImagesHandler } = {}) {
  render(
    <AgentTranscriptPanel
      messages={[]}
      status={SessionStatus.IDLE}
      onStop={() => undefined}
      onSend={onSend}
      onSaveImages={onSaveImages}
    />
  )
  return screen.getByLabelText('Message the agent') as HTMLTextAreaElement
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describeChatImagePaste('Task / Captain composer', async () => mountTranscript({ onSaveImages: vi.fn(async () => []) }))

describe('Task / Captain composer: sending images', () => {
  const saved = { id: 'att-1', filename: 'diagram.png', size: 64, mime_type: 'image/png' }

  it('stores pasted images as task attachments and sends them with the message', async () => {
    const onSend = vi.fn()
    const onSaveImages = vi.fn(async () => [saved])
    const field = mountTranscript({ onSend, onSaveImages })
    fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('diagram.png')] }) })
    await screen.findByRole('img', { name: 'diagram.png' })
    field.value = 'Fix this layout'
    fireEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Fix this layout', { attachments: [saved] }))
    expect(onSaveImages).toHaveBeenCalledWith([{ name: 'diagram.png', mimeType: 'image/png', data: toBase64(imageBytes()) }])
    expect(screen.queryByTestId('chat-attachment-chip')).toBeNull()
  })

  it('gives an image-only message words the agent can act on', async () => {
    const onSend = vi.fn()
    const field = mountTranscript({ onSend, onSaveImages: vi.fn(async () => [saved]) })
    fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('diagram.png')] }) })
    await screen.findByRole('img', { name: 'diagram.png' })
    fireEvent.click(screen.getByLabelText('Send message'))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(imageOnlyMessage(1), { attachments: [saved] }))
  })

  it('puts the text and images back when storing them fails', async () => {
    const onSend = vi.fn()
    const field = mountTranscript({ onSend, onSaveImages: vi.fn(async () => { throw new Error('disk full') }) })
    fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('diagram.png')] }) })
    await screen.findByRole('img', { name: 'diagram.png' })
    field.value = 'Fix this'
    fireEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() => expect(field.value).toBe('Fix this'))
    expect(await screen.findByRole('img', { name: 'diagram.png' })).toBeTruthy()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('refuses images where there is no task to store them, and text still pastes', () => {
    const field = mountTranscript()
    fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('diagram.png')] }) })
    expect(screen.getByText(IMAGES_UNSUPPORTED_HERE)).toBeTruthy()
    expect(fireEvent.paste(field, { clipboardData: clipboard({ text: 'words' }) })).toBe(true)
  })
})
