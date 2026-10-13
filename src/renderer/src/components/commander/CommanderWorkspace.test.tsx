import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CommanderEvent, CommanderMessage, CommanderSession } from '@shared/commander'

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
    cancel: vi.fn(),
    onEvent: vi.fn()
  },
  settingsApi: {
    getAll: vi.fn(),
    set: vi.fn()
  },
  agentApi: {
    getAll: vi.fn()
  },
  agentSessionApi: {},
  onAgentStatus: vi.fn(),
  onTranscriptChanged: vi.fn()
}))
vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ipc-client')>(),
  ...mocks
}))

const api = mocks.commanderApi

import { useAgentStore } from '@/stores/agent-store'
import { useCommanderStore } from '@/stores/commander-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { CommanderWorkspace } from './CommanderWorkspace'
import { toolCallLabel } from './tool-call-label'

function session(over: Partial<CommanderSession> = {}): CommanderSession {
  return { id: 's1', title: 'Launch', created_at: 1, updated_at: 1, archived: false, last_read_at: 1, unread_count: 0, ...over }
}

function message(over: Partial<CommanderMessage> = {}): CommanderMessage {
  return {
    id: `m-${Math.random()}`,
    session_id: 's1',
    role: 'user',
    content: '',
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    is_error: false,
    project_id: null,
    correlation_id: null,
    created_at: 1,
    ...over
  }
}

let emit: (event: CommanderEvent) => void = () => {}

function renderWorkspace() {
  const result = render(<CommanderWorkspace />)
  fireEvent.click(screen.getByRole('button', { name: 'Open Commander sessions' }))
  return result
}


beforeEach(() => {
  useCommanderCallUiStore.setState({ captions: true, captionSize: 'medium', panelOpen: true, pipRequested: false, notice: null })
  useAgentStore.setState({ agents: [], isLoading: false, error: null, sessions: new Map() })
  useCommanderStore.setState({
    drafts: {},
    sessions: [], reportInbox: null, unseenReports: {}, recentAction: null, undoneActions: [], undoingActions: [],
    selectedSessionId: null,
    search: '',
    showArchived: false,
    messages: {},
    streaming: {},
    turnErrors: {},
    isLoading: false,
    error: null
  })
  api.onEvent.mockImplementation((cb: (event: CommanderEvent) => void) => {
    emit = cb
    return () => {}
  })
  api.listMessages.mockResolvedValue({ messages: [], activeTurnId: null })
  api.markRead.mockImplementation(async (id: string) => session({ id, unread_count: 0 }))
  mocks.settingsApi.getAll.mockResolvedValue({})
  mocks.settingsApi.set.mockResolvedValue(undefined)
  mocks.agentApi.getAll.mockResolvedValue([{
    id: 'claude-agent',
    name: 'Claude Agent',
    server_url: '',
    config: { coding_agent: 'claude-code', model: 'claude-saved', reasoning_effort: 'medium' },
    is_default: true,
    created_at: '',
    updated_at: ''
  }])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CommanderWorkspace', () => {
  it('restores the session draft when returning after the workspace unmounts', async () => {
    api.listSessions.mockResolvedValue([session()])
    const first = renderWorkspace()
    fireEvent.click(await screen.findByText('Launch'))
    fireEvent.change(screen.getByLabelText('Message the Commander'), { target: { value: 'A draft before navigating away' } })
    first.unmount()
    render(<CommanderWorkspace />)
    expect(screen.getByLabelText('Message the Commander')).toHaveValue('A draft before navigating away')
    expect(api.send).not.toHaveBeenCalled()
  })
  it('starts with the stage beside Chat and preserves the typed draft across panel and tab toggles', async () => {
    api.listSessions.mockResolvedValue([session()])
    renderWorkspace(); fireEvent.click(await screen.findByText('Launch'))
    expect(screen.getByLabelText('Commander stage')).toBeTruthy()
    expect(screen.getByRole('toolbar', { name: 'Commander call controls' })).toBeTruthy()
    const field = screen.getByLabelText('Message the Commander')
    fireEvent.change(field, { target: { value: 'Keep my draft' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Actions' }))
    expect(field).toHaveValue('Keep my draft')
    expect(screen.getByTestId('commander-messages')).toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    fireEvent.click(screen.getByLabelText('Hide Chat panel'))
    expect(field.closest('[hidden]')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Show Chat panel'))
    expect(screen.getByLabelText('Message the Commander')).toBe(field)
    expect(field).toHaveValue('Keep my draft')
  })

  it('keeps the quiet inbox discoverable after rename and does not start a turn when opening it', async () => {
    const inbox = session({ id: 'inbox', title: 'Renamed by the user', unread_count: 3, is_report_inbox: true })
    api.listSessions.mockResolvedValue([session(), inbox])
    api.markRead.mockImplementation(async id => id === 'inbox' ? { ...inbox, unread_count: 0 } : session())
    renderWorkspace(); fireEvent.click(await within(screen.getByRole('list', { name: 'Commander sessions' })).findByText('Launch'))
    fireEvent.click(screen.getByRole('button', { name: 'Project reports, 3 unread' }))
    await waitFor(() => expect(useCommanderStore.getState().selectedSessionId).toBe('inbox'))
    expect(api.send).not.toHaveBeenCalled()
    expect(api.listMessages).toHaveBeenCalledWith('inbox')
  })

  it('threads a quiet correlated report below its request without moving focus or scrolling', async () => {
    api.listSessions.mockResolvedValue([session()])
    api.listMessages.mockResolvedValue({ messages: [
      message({ id: 'ask', role: 'assistant', content: 'I asked Web to review checkout.', tool_calls: [{ id: 'ask-1', name: 'ask_captain', input: { project: 'Web', message: 'Review checkout' } }] }),
      message({ id: 'tool', role: 'tool', tool_call_id: 'ask-1', tool_name: 'ask_captain', correlation_id: 'request-1', content: 'Queued', created_at: 2 }),
      message({ id: 'later-user', content: 'Another question', created_at: 3 })
    ], activeTurnId: null })
    renderWorkspace(); fireEvent.click(await screen.findByText('Launch'))
    await screen.findByText('Another question')
    const field = screen.getByLabelText('Message the Commander'); field.focus()
    const messages = screen.getByTestId('commander-messages'); messages.scrollTop = 17
    act(() => emit({ type: 'messages_appended', sessionId: 's1', messages: [message({ id: 'quiet', role: 'report', correlation_id: 'request-1', content: 'Checkout review complete; approval is needed.', created_at: 4 })] }))
    expect(screen.getByTestId('commander-report-thread')).toHaveTextContent('Checkout review complete; approval is needed.')
    expect(screen.getByText('New update')).toBeTruthy()
    expect(field).toHaveFocus()
    expect(messages.scrollTop).toBe(17)
    expect(api.send).not.toHaveBeenCalled()
  })

  it('opts the full session interface into shared reading-surface scaling', async () => {
    api.listSessions.mockResolvedValue([session()])
    const { container } = renderWorkspace()
    fireEvent.click(await screen.findByText('Launch'))
    const workspace = container.querySelector('.commander-workspace')
    expect(workspace).toHaveClass('ui-scale')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(workspace).toContainElement(screen.getByLabelText('Commander stage'))
    expect(workspace).toContainElement(screen.getByLabelText('Message the Commander'))
    expect(screen.getByLabelText('Message the Commander')).toHaveClass('text-base', 'leading-relaxed', 'min-w-0')
  })

  it('leaves Shift+Enter and IME Enter to the editor, and submits plain Enter once', async () => {
    api.listSessions.mockResolvedValue([session()])
    let finish: (value: unknown) => void = () => {}
    api.send.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    renderWorkspace()
    fireEvent.click(await screen.findByText('Launch'))
    await waitFor(() => expect(screen.getByLabelText('Commander model')).not.toBeDisabled())
    const input = screen.getByRole('textbox', { name: 'Message the Commander' })
    input.focus()
    fireEvent.change(input, { target: { value: 'Hello' } })
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true)
    expect(api.send).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1))
    expect(input).not.toBeDisabled()
    expect(input).toHaveAttribute('readonly')
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.send).toHaveBeenCalledTimes(1)
    // Completing an asynchronous send must not steal focus back from another control.
    fireEvent.click(screen.getByRole('button', { name: 'Open Commander sessions' }))
    const search = screen.getByRole('textbox', { name: 'Search sessions' })
    search.focus()
    await act(async () => { finish({ turnId: 'keyboard-turn', message: message({ content: 'Hello' }) }) })
    expect(input).not.toHaveAttribute('readonly')
    expect(input).toHaveValue('')
    expect(search).toHaveFocus()
  })

  it('shows the empty state when there is no session', async () => {
    api.listSessions.mockResolvedValue([])
    renderWorkspace()
    expect(await screen.findByText('Talk to the Commander')).toBeTruthy()
    expect(screen.getByText('No sessions yet.')).toBeTruthy()
  })

  it('lists sessions with unread badges and clears them on open', async () => {
    api.listSessions.mockResolvedValue([
      session({ id: 'a', title: 'Alpha', updated_at: 2, unread_count: 2 }),
      session({ id: 'b', title: '', updated_at: 1 })
    ])
    renderWorkspace()
    expect(await screen.findByText('Alpha')).toBeTruthy()
    // An untitled session reads "New session" until it is named.
    expect(within(screen.getByRole('list', { name: 'Commander sessions' })).getByText('New session')).toBeTruthy()
    expect(screen.getByLabelText('2 unread')).toBeTruthy()

    api.markRead.mockResolvedValue(session({ id: 'a', title: 'Alpha', updated_at: 2, unread_count: 0 }))
    fireEvent.click(screen.getByText('Alpha'))
    await waitFor(() => expect(screen.queryByLabelText('2 unread')).toBeNull())
    expect(api.markRead).toHaveBeenCalledWith('a')
  })

  it('counts a report for a session that is not open as unread', async () => {
    api.listSessions.mockResolvedValue([session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })])
    renderWorkspace()
    await screen.findByText('Beta')
    act(() => {
      emit({ type: 'messages_appended', sessionId: 'b', messages: [message({ session_id: 'b', role: 'report', content: 'done' })] })
      emit({ type: 'session_updated', session: session({ id: 'b', title: 'Beta', unread_count: 1, updated_at: 5 }) })
    })
    expect(screen.getByLabelText('1 unread')).toBeTruthy()
    expect(api.markRead).not.toHaveBeenCalled()
  })

  it('streams a turn, renders tool chips and reports distinctly, then shows the stored reply', async () => {
    api.listSessions.mockResolvedValue([session()])
    api.listMessages.mockResolvedValue({
      messages: [
        message({ id: 'u1', content: 'Ask web to deploy', created_at: 1 }),
        message({ id: 'a1', role: 'assistant', content: '', created_at: 2, tool_calls: [{ id: 'c1', name: 'ask_project', input: { project: 'web', message: 'deploy' } }] }),
        message({ id: 't1', role: 'tool', content: 'queued', tool_call_id: 'c1', tool_name: 'ask_project', created_at: 3 }),
        message({ id: 'r1', role: 'report', content: 'Deployed to prod', project_id: 'web', created_at: 4 })
      ],
      activeTurnId: null
    })
    renderWorkspace()
    fireEvent.click(await screen.findByText('Launch'))

    expect(await screen.findByText('Asked web: deploy')).toBeTruthy()
    const report = screen.getByTestId('commander-report')
    expect(report.textContent).toContain('Deployed to prod')
    expect(report.textContent).not.toContain('web')

    api.send.mockResolvedValue({ turnId: 't-1', message: message({ id: 'u2', content: 'Status?', created_at: 5 }) })
    fireEvent.change(screen.getByLabelText('Message the Commander'), { target: { value: 'Status?' } })
    fireEvent.click(screen.getByLabelText('Send'))
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('s1', 'Status?'))
    expect(await screen.findByLabelText('Stop')).toBeTruthy()

    act(() => {
      emit({ type: 'turn_event', sessionId: 's1', turnId: 't-1', event: { type: 'text_delta', text: 'All ' } })
      emit({ type: 'turn_event', sessionId: 's1', turnId: 't-1', event: { type: 'text_delta', text: 'good.' } })
    })
    expect(screen.getByTestId('commander-streaming').textContent).toContain('All good.')

    fireEvent.click(screen.getByLabelText('Stop'))
    expect(api.cancel).toHaveBeenCalledWith('s1')

    act(() => {
      emit({ type: 'messages_appended', sessionId: 's1', messages: [message({ id: 'a2', role: 'assistant', content: 'All good.', created_at: 6 })] })
      emit({ type: 'turn_event', sessionId: 's1', turnId: 't-1', event: { type: 'done', stopReason: 'end_turn' } })
    })
    expect(screen.queryByTestId('commander-streaming')).toBeNull()
    expect(screen.getByText('All good.')).toBeTruthy()
    expect(screen.getByLabelText('Send')).toBeTruthy()
  })

  it('does not duplicate messages when the open session is selected again', async () => {
    api.listSessions.mockResolvedValue([session()])
    api.listMessages.mockResolvedValue({
      messages: [message({ id: 'u1', content: 'Hi there', created_at: 1 })],
      activeTurnId: null
    })
    renderWorkspace()
    fireEvent.click(await screen.findByText('Launch'))
    expect(await screen.findByText('Hi there')).toBeTruthy()

    // A stored reply arrives while the session is open...
    act(() => {
      emit({ type: 'messages_appended', sessionId: 's1', messages: [message({ id: 'a1', role: 'assistant', content: 'Hello!', created_at: 2 })] })
    })
    expect(screen.getByText('Hello!')).toBeTruthy()

    // ...and the next selection click refetches the same history.
    api.listMessages.mockResolvedValue({
      messages: [
        message({ id: 'u1', content: 'Hi there', created_at: 1 }),
        message({ id: 'a1', role: 'assistant', content: 'Hello!', created_at: 2 })
      ],
      activeTurnId: null
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open Commander sessions' }))
    fireEvent.click(within(screen.getByRole('list', { name: 'Commander sessions' })).getByText('Launch'))
    await waitFor(async () => expect(api.listMessages).toHaveBeenCalledTimes(2))
    expect(screen.getAllByText('Hi there')).toHaveLength(1)
    expect(screen.getAllByText('Hello!')).toHaveLength(1)
  })

  it('persists model and thinking choices before sending', async () => {
    api.listSessions.mockResolvedValue([session()])
    api.send.mockResolvedValue({ turnId: 't-config', message: message({ content: 'Hello' }) })
    mocks.agentApi.getAll.mockResolvedValue([
      {
        id: 'claude-agent', name: 'Claude Agent', server_url: '',
        config: { coding_agent: 'claude-code', model: 'claude-saved', reasoning_effort: 'medium' },
        is_default: true, created_at: '', updated_at: ''
      },
      {
        id: 'codex-agent', name: 'Codex Agent', server_url: '',
        config: { coding_agent: 'codex', model: 'gpt-saved', reasoning_effort: 'low' },
        is_default: false, created_at: '', updated_at: ''
      }
    ])
    renderWorkspace()
    fireEvent.click(await screen.findByText('Launch'))

    await waitFor(() => expect(screen.getByLabelText('Commander model')).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('Commander model'), {
      target: { value: 'codex-agent' }
    })
    fireEvent.change(screen.getByLabelText('Thinking level'), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText('Message the Commander'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByLabelText('Send'))

    await waitFor(() => expect(api.send).toHaveBeenCalledWith('s1', 'Hello'))
    expect(mocks.settingsApi.set).toHaveBeenCalledWith('chat_agent_id', 'codex-agent')
    expect(mocks.settingsApi.set).toHaveBeenCalledWith('chat_provider', 'openai-compatible')
    expect(mocks.settingsApi.set).toHaveBeenCalledWith('chat_model', 'gpt-saved')
    expect(mocks.settingsApi.set).toHaveBeenCalledWith('chat_reasoning_effort', 'high')
    const lastSettingWrite = Math.max(...mocks.settingsApi.set.mock.invocationCallOrder)
    expect(lastSettingWrite).toBeLessThan(api.send.mock.invocationCallOrder[0])
  })

  it('does not offer or send with an unconfigured model', async () => {
    api.listSessions.mockResolvedValue([session()])
    mocks.agentApi.getAll.mockResolvedValue([])
    renderWorkspace()
    fireEvent.click(await screen.findByText('Launch'))

    expect(await screen.findByText('No configured Commander model')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Message the Commander'), { target: { value: 'Hello' } })
    expect(screen.getByLabelText('Send')).toBeDisabled()
    expect(api.send).not.toHaveBeenCalled()
  })

  it('does not restart streaming when the send reply arrives after the turn is over', async () => {
    useCommanderStore.setState({ selectedSessionId: 's1', sessions: [session()], messages: { s1: [] } })
    let resolveSend: (v: unknown) => void = () => {}
    api.send.mockReturnValue(new Promise((r) => { resolveSend = r }))
    const sending = useCommanderStore.getState().send('hi')
    useCommanderStore.getState().handleEvent({ type: 'turn_event', sessionId: 's1', turnId: 't-fast', event: { type: 'done', stopReason: 'end_turn' } })
    resolveSend({ turnId: 't-fast', message: message({ id: 'u9', content: 'hi' }) })
    await sending
    expect(useCommanderStore.getState().streaming.s1).toBeUndefined()
  })
})

describe('toolCallLabel', () => {
  it('reads as a delegation when the call names a project', () => {
    expect(toolCallLabel('ask_project', { project: 'Web' })).toBe('Asked Web…')
    expect(toolCallLabel('ask_captain', { project: 'Web', message: 'Deploy the site' })).toBe('Asked Web: Deploy the site')
    expect(toolCallLabel('list_projects', {})).toBe('List projects')
    expect(toolCallLabel('archive_project', { project: 'Web' })).toBe('Archive project · Web')
    expect(toolCallLabel('navigate_to_project', { project: 'Web' })).toBe('Navigate to project · Web')
  })
})
