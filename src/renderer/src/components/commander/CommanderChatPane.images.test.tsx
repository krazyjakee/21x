import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CommanderMessage, CommanderSession } from '@shared/commander'
import { describeChatImagePaste } from '@/components/chat/paste-suite'
import { clipboard, imageBytes, imageFile, toBase64 } from '@/components/chat/paste-fixtures'

const mocks = vi.hoisted(() => ({
  commanderApi: {
    listSessions: vi.fn(),
    createSession: vi.fn(),
    renameSession: vi.fn(),
    archiveSession: vi.fn(),
    listMessages: vi.fn(),
    markRead: vi.fn(),
    setActiveSession: vi.fn(async () => undefined),
    send: vi.fn(),
    getImage: vi.fn(),
    cancel: vi.fn(),
    onEvent: vi.fn(() => () => {})
  },
  chatImageApi: { readClipboard: vi.fn(async () => ({ images: [], errors: [] })), saveToTask: vi.fn() },
  settingsApi: { getAll: vi.fn(), set: vi.fn() },
  agentApi: { getAll: vi.fn() },
  agentSessionApi: {},
  onAgentStatus: vi.fn(),
  onTranscriptChanged: vi.fn()
}))
vi.mock('@/lib/ipc-client', () => mocks)

const api = mocks.commanderApi

import { useAgentStore } from '@/stores/agent-store'
import { useCommanderStore } from '@/stores/commander-store'
import { clearCommanderImageCache } from '@/lib/commander-images'
import { CommanderWorkspace } from './CommanderWorkspace'

function session(): CommanderSession {
  return { id: 's1', title: 'Launch', created_at: 1, updated_at: 1, archived: false, last_read_at: 1, unread_count: 0 }
}

function message(over: Partial<CommanderMessage> = {}): CommanderMessage {
  return {
    id: 'u1', session_id: 's1', role: 'user', content: '', tool_calls: null, tool_call_id: null, tool_name: null,
    is_error: false, project_id: null, correlation_id: null, created_at: 1, ...over
  }
}

async function mountCommander(): Promise<HTMLTextAreaElement> {
  render(<CommanderWorkspace />)
  fireEvent.click(await screen.findByText('Launch'))
  const field = await screen.findByLabelText('Message the Commander') as HTMLTextAreaElement
  // Wait for the model selection, so Send is live once there is content.
  await waitFor(() => expect(mocks.settingsApi.set).toHaveBeenCalled())
  return field
}

beforeEach(() => {
  // This mounted transcript is visible; happy-dom does not calculate layout.
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    disconnect() {}
  })
  clearCommanderImageCache()
  useAgentStore.setState({ agents: [], isLoading: false, error: null, sessions: new Map() })
  useCommanderStore.setState({
    sessions: [], selectedSessionId: null, search: '', showArchived: false, messages: {}, streaming: {}, turnErrors: {}, isLoading: false, error: null
  })
  api.listSessions.mockResolvedValue([session()])
  api.listMessages.mockResolvedValue({ messages: [], activeTurnId: null })
  api.markRead.mockResolvedValue(session())
  mocks.settingsApi.getAll.mockResolvedValue({})
  mocks.settingsApi.set.mockResolvedValue(undefined)
  mocks.agentApi.getAll.mockResolvedValue([{
    id: 'claude-agent', name: 'Claude Agent', server_url: '',
    config: { coding_agent: 'claude-code', model: 'claude-saved', reasoning_effort: 'medium' },
    is_default: true, created_at: '', updated_at: ''
  }])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describeChatImagePaste('Commander composer', mountCommander)

describe('Commander composer: sending images', () => {
  const pngData = toBase64(imageBytes())

  it('sends pasted images with the text, clears the tray, and shows them in the transcript', async () => {
    const field = await mountCommander()
    fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('diagram.png')] }) })
    await screen.findByRole('img', { name: 'diagram.png' })
    fireEvent.change(field, { target: { value: 'What is wrong here?' } })

    api.send.mockResolvedValue({
      turnId: 't1',
      message: message({ content: 'What is wrong here?', images: [{ id: 'img-1', name: 'diagram.png', mime_type: 'image/png', size: 64 }] })
    })
    fireEvent.click(screen.getByLabelText('Send'))

    await waitFor(() => expect(api.send).toHaveBeenCalledWith('s1', 'What is wrong here?', [
      { name: 'diagram.png', mimeType: 'image/png', data: pngData }
    ]))
    await waitFor(() => expect(screen.queryByTestId('chat-attachment-chip')).toBeNull())
    // The sent bytes seed the transcript: no round trip to main for the thumbnail.
    const shown = await screen.findByTestId('chat-message-images')
    expect(shown.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${pngData}`)
    expect(api.getImage).not.toHaveBeenCalled()
  })

  it('sends an image with no text', async () => {
    const field = await mountCommander()
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('a.png')] }) })
    await screen.findByRole('img', { name: 'a.png' })
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(false)
    api.send.mockResolvedValue({ turnId: 't1', message: message({ images: [{ id: 'i', name: 'a.png', mime_type: 'image/png', size: 64 }] }) })
    fireEvent.click(screen.getByLabelText('Send'))
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('s1', '', [{ name: 'a.png', mimeType: 'image/png', data: pngData }]))
  })

  it('keeps the text and images, and shows the reason, when the model cannot read images', async () => {
    const field = await mountCommander()
    fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('a.png')] }) })
    await screen.findByRole('img', { name: 'a.png' })
    fireEvent.change(field, { target: { value: 'Explain' } })
    const reason = "The selected model (m) can't read images. Your message was not sent: remove the images or choose another model."
    api.send.mockRejectedValue(new Error(`Error invoking remote method 'commander:send': Error: ${reason}`))
    fireEvent.click(screen.getByLabelText('Send'))

    expect(await screen.findByText(reason)).toBeTruthy()
    expect(field.value).toBe('Explain')
    expect(screen.getByRole('img', { name: 'a.png' })).toBeTruthy()
  })

  it('keeps one in-flight send even before IPC responds', async () => {
    const field = await mountCommander()
    let rejectSend!: (error: Error) => void
    api.send.mockImplementationOnce(() => new Promise((_, reject) => { rejectSend = reject }))
    fireEvent.change(field, { target: { value: 'Send once' } })
    fireEvent.click(screen.getByLabelText('Send'))
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1))
    await act(async () => { rejectSend(new Error('offline')) })
    expect(field.value).toBe('Send once')
    expect(api.send).toHaveBeenCalledTimes(1)
  })

  it('does not send a draft to another session after waiting for model settings', async () => {
    const field = await mountCommander()
    let finishSettings!: () => void
    mocks.settingsApi.set.mockImplementation(() => new Promise<void>((resolve) => { finishSettings = resolve }))
    fireEvent.change(screen.getByLabelText('Thinking level'), { target: { value: 'high' } })
    await waitFor(() => expect(finishSettings).toBeDefined())
    fireEvent.change(field, { target: { value: 'Private session A' } })
    fireEvent.click(screen.getByLabelText('Send'))
    await act(async () => {
      useCommanderStore.setState({ selectedSessionId: 's2', sessions: [session(), { ...session(), id: 's2' }] })
      finishSettings()
    })
    expect(api.send).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Message the Commander') as HTMLTextAreaElement).value).toBe('')
  })

  it('loads the thumbnails of stored messages from main', async () => {
    api.listMessages.mockResolvedValue({
      messages: [message({ content: 'old', images: [{ id: 'img-9', name: 'old.png', mime_type: 'image/png', size: 64 }] })],
      activeTurnId: null
    })
    api.getImage.mockResolvedValue({ id: 'img-9', name: 'old.png', mimeType: 'image/png', data: pngData })
    await mountCommander()
    const img = await screen.findByRole('img', { name: 'old.png' })
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${pngData}`)
    expect(api.getImage).toHaveBeenCalledWith('img-9')
  })
})
