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
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderStore } from '@/stores/commander-store'
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

async function openSessions(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /Sessions/ }))
  return screen.findByRole('dialog', { name: 'Sessions' })
}

async function openSession(title = 'Launch'): Promise<void> {
  const drawer = await openSessions()
  fireEvent.click(await within(drawer).findByText(title))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull())
}

beforeEach(() => {
  useCommanderCallStore.setState({
    status: 'off',
    sessionId: null,
    turnId: null,
    error: null,
    retrySessionId: null,
    interruptedAt: null,
    replyInterrupted: false,
    lastEvent: null,
    startedAt: null
  })
  useAgentStore.setState({ agents: [], isLoading: false, error: null, sessions: new Map() })
  useCommanderStore.setState({
    sessions: [],
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
  it('shows the empty state when there is no session', async () => {
    api.listSessions.mockResolvedValue([])
    render(<CommanderWorkspace />)
    expect(await screen.findByText('Talk to the Commander')).toBeTruthy()
    const drawer = await openSessions()
    expect(within(drawer).getByText('No sessions yet.')).toBeTruthy()
  })

  it('renders the stage-first layout, state word, tabs and accessible toolbar toggles', async () => {
    api.listSessions.mockResolvedValue([])
    render(<CommanderWorkspace />)
    await screen.findByText('Talk to the Commander')

    expect(screen.getByLabelText('Commander call stage')).toHaveAttribute('data-call-state', 'unavailable')
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Actions' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('toolbar', { name: 'Commander call controls' })).toBeTruthy()

    const captions = screen.getByLabelText('Turn captions off')
    expect(captions).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(captions)
    expect(screen.getByLabelText('Turn captions on')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('commander-captions')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Actions' }))
    expect(screen.getByText('No recent actions')).toBeTruthy()
  })

  it('retains a typed draft when the side panel closes and supports toolbar arrow keys', async () => {
    api.listSessions.mockResolvedValue([session()])
    render(<CommanderWorkspace />)
    await openSession()

    const composer = screen.getByLabelText('Message the Commander')
    fireEvent.change(composer, { target: { value: 'Keep this draft' } })
    const captions = screen.getByLabelText('Turn captions off')
    captions.focus()
    fireEvent.keyDown(captions, { key: 'ArrowRight' })
    expect(screen.getAllByLabelText('Close side panel')).toContain(document.activeElement)

    fireEvent.click(screen.getAllByLabelText('Close side panel')[0])
    fireEvent.click(screen.getByLabelText('Open side panel'))
    expect(screen.getByLabelText('Message the Commander')).toHaveValue('Keep this draft')
  })

  it('shows a report arrival as a plain project chip without relaying raw report text', async () => {
    api.listSessions.mockResolvedValue([session()])
    render(<CommanderWorkspace />)
    await openSession()

    act(() => useCommanderCallStore.setState({
      status: 'live',
      sessionId: 's1',
      turnId: 'voice-1',
      startedAt: Date.now(),
      lastEvent: {
        kind: 'report',
        at: performance.now(),
        sessionId: 's1',
        messageId: 'report-1',
        projectId: 'Web'
      }
    }))

    expect(screen.getByTestId('commander-call-event')).toHaveTextContent('Report from Web')
    expect(screen.getByTestId('commander-call-event')).not.toHaveTextContent('implementation details')
  })

  it('lists sessions with unread badges and clears them on open', async () => {
    api.listSessions.mockResolvedValue([
      session({ id: 'a', title: 'Alpha', updated_at: 2, unread_count: 2 }),
      session({ id: 'b', title: '', updated_at: 1 })
    ])
    render(<CommanderWorkspace />)
    const drawer = await openSessions()
    expect(await within(drawer).findByText('Alpha')).toBeTruthy()
    // An untitled session reads "New session" until it is named.
    expect(within(drawer).getByText('New session')).toBeTruthy()
    expect(within(drawer).getByLabelText('2 unread')).toBeTruthy()

    api.markRead.mockResolvedValue(session({ id: 'a', title: 'Alpha', updated_at: 2, unread_count: 0 }))
    fireEvent.click(within(drawer).getByText('Alpha'))
    await waitFor(() => expect(screen.queryByLabelText('2 unread')).toBeNull())
    expect(api.markRead).toHaveBeenCalledWith('a')
    await waitFor(() => expect(screen.getByRole('button', { name: /Sessions/ })).toHaveFocus())
  })

  it('counts a report for a session that is not open as unread', async () => {
    api.listSessions.mockResolvedValue([session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })])
    render(<CommanderWorkspace />)
    const drawer = await openSessions()
    await within(drawer).findByText('Beta')
    act(() => {
      emit({ type: 'messages_appended', sessionId: 'b', messages: [message({ session_id: 'b', role: 'report', content: 'done' })] })
      emit({ type: 'session_updated', session: session({ id: 'b', title: 'Beta', unread_count: 1, updated_at: 5 }) })
    })
    expect(within(drawer).getByLabelText('1 unread')).toBeTruthy()
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
    render(<CommanderWorkspace />)
    await openSession()

    expect(await screen.findByText('Asked web: deploy')).toBeTruthy()
    const report = screen.getByTestId('commander-report')
    expect(report.textContent).toContain('Deployed to prod')
    expect(report.textContent).toContain('web')

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
    render(<CommanderWorkspace />)
    await openSession()
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
    const drawer = await openSessions()
    fireEvent.click(within(drawer).getByText('Launch'))
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
    render(<CommanderWorkspace />)
    await openSession()

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
    render(<CommanderWorkspace />)
    await openSession()

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

/**
 * The pane decides which stored tool call may still be running, and it is the
 * only place that decision is made from real state (#83). `CommanderMessageItem`
 * is always handed `turnActive` directly, so these cases are what stop the
 * "a call with no result is running" bug from coming back through the pane.
 */
describe('CommanderChatPane: a stored tool call spins only while it can still finish (#83)', () => {
  const CALL = { id: 'c1', name: 'ask_project', input: { project: 'web', message: 'deploy' } }

  async function openWith(messages: CommanderMessage[], activeTurnId: string | null): Promise<void> {
    api.listSessions.mockResolvedValue([session()])
    api.listMessages.mockResolvedValue({ messages, activeTurnId })
    render(<CommanderWorkspace />)
    await openSession()
    expect(await screen.findByText('Asked web: deploy')).toBeTruthy()
  }

  function chipState(): string {
    return screen.getByTestId('commander-tool-state').textContent ?? ''
  }

  function spinners(): number {
    return document.querySelectorAll('.animate-spin').length
  }

  it('reads a call of a finished turn as "Not run", never as running', async () => {
    // A session saved by an older build: the call has no `tool` row and no
    // turn is live, so nothing will ever answer it.
    await openWith(
      [
        message({ id: 'u1', content: 'Ask web to deploy', created_at: 1 }),
        message({ id: 'a1', role: 'assistant', content: '', created_at: 2, tool_calls: [CALL] })
      ],
      null
    )
    expect(chipState()).toBe('(Not run)')
    expect(spinners()).toBe(0)
  })

  it('does not revive an older turn\'s unanswered call just because a new turn is running', async () => {
    // The adversarial case for the pane's rule: a turn IS live, but it is not
    // this message's turn. Gating on `streaming` alone would spin for ever.
    await openWith(
      [
        message({ id: 'u1', content: 'Ask web to deploy', created_at: 1 }),
        message({ id: 'a1', role: 'assistant', content: '', created_at: 2, tool_calls: [CALL] }),
        message({ id: 'u2', content: 'Any news?', created_at: 3 })
      ],
      'turn-live'
    )
    expect(useCommanderStore.getState().streaming.s1?.turnId).toBe('turn-live')
    expect(chipState()).toBe('(Not run)')
    expect(spinners()).toBe(0)
  })

  it('still spins for the running turn\'s own newest call', async () => {
    // The other half: the fix must not stop every stored call from spinning.
    await openWith(
      [
        message({ id: 'u1', content: 'Ask web to deploy', created_at: 1 }),
        message({ id: 'a1', role: 'assistant', content: '', created_at: 2, tool_calls: [CALL] })
      ],
      'turn-live'
    )
    expect(chipState()).toBe('(Running)')
    expect(spinners()).toBeGreaterThan(0)
  })

  it('stops spinning as soon as that turn ends, with no result ever stored', async () => {
    await openWith(
      [
        message({ id: 'u1', content: 'Ask web to deploy', created_at: 1 }),
        message({ id: 'a1', role: 'assistant', content: '', created_at: 2, tool_calls: [CALL] })
      ],
      'turn-live'
    )
    expect(chipState()).toBe('(Running)')
    act(() => {
      emit({ type: 'turn_event', sessionId: 's1', turnId: 'turn-live', event: { type: 'done', stopReason: 'max_tokens' } })
    })
    await waitFor(() => expect(chipState()).toBe('(Not run)'))
    expect(spinners()).toBe(0)
  })

  it('lets a stored result win over the running turn', async () => {
    await openWith(
      [
        message({ id: 'u1', content: 'Ask web to deploy', created_at: 1 }),
        message({ id: 'a1', role: 'assistant', content: '', created_at: 2, tool_calls: [CALL] }),
        message({ id: 't1', role: 'tool', content: 'queued', tool_call_id: 'c1', tool_name: 'ask_project', created_at: 3 })
      ],
      'turn-live'
    )
    expect(screen.queryByTestId('commander-tool-state')).toBeNull()
    expect(spinners()).toBe(0)
  })
})
