import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CommanderEvent, CommanderMessage, CommanderSession } from '@shared/commander'

const mocks = vi.hoisted(() => ({
  commanderApi: {
    listSessions: vi.fn(),
    createSession: vi.fn(),
    renameSession: vi.fn(),
    archiveSession: vi.fn(),
    markRead: vi.fn(),
    setActiveSession: vi.fn(async () => undefined),
    prepareSession: vi.fn(),
    getAgentId: vi.fn(),
    onEvent: vi.fn()
  },
  settingsApi: {
    get: vi.fn(async () => null),
    set: vi.fn()
  },
  agentApi: {
    getAll: vi.fn()
  },
  agentSessionApi: {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ newSessionId: null })),
    getTranscriptSnapshot: vi.fn(async () => []),
    getTranscriptDelta: vi.fn(async () => [])
  },
  onAgentStatus: vi.fn(),
  onTranscriptChanged: vi.fn()
}))
vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  ...mocks
}))

/**
 * The transcript is the shared agent panel with its own IPC; this file is
 * about the Commander around it. Its props are captured so a test can send
 * like a user and see which row it shows.
 */
const panel = vi.hoisted(() => ({ props: null as null | { onSend?: (text: string) => Promise<void> | void; taskId?: string; title?: string } }))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({
  AgentTranscriptPanel: (props: { onSend?: (text: string) => void; taskId?: string; title?: string }) => {
    panel.props = props
    return null
  }
}))

const api = mocks.commanderApi

import { useAgentStore } from '@/stores/agent-store'
import { useCommanderStore } from '@/stores/commander-store'
import { CommanderWorkspace } from './CommanderWorkspace'

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

beforeEach(() => {
  useAgentStore.setState({ agents: [], isLoading: false, error: null, sessions: new Map() })
  useCommanderStore.setState({
    sessions: [],
    selectedSessionId: null,
    search: '',
    showArchived: false,
    isLoading: false,
    error: null
  })
  api.onEvent.mockImplementation((cb: (event: CommanderEvent) => void) => {
    emit = cb
    return () => {}
  })
  panel.props = null
  api.prepareSession.mockImplementation(async (id: string) => ({ taskId: id, agentId: 'claude-agent' }))
  api.getAgentId.mockResolvedValue('claude-agent')
  api.markRead.mockImplementation(async (id: string) => session({ id, unread_count: 0 }))
  mocks.settingsApi.set.mockResolvedValue(undefined)
  mocks.agentApi.getAll.mockResolvedValue([{
    id: 'claude-agent',
    name: 'Claude Agent',
    server_url: '',
    config: { coding_agent: 'claude-code', model: 'claude-saved', reasoning_effort: 'medium' },
    is_default: true,
    created_at: '',
    updated_at: ''
  }, {
    id: 'codex-agent',
    name: 'Codex Agent',
    server_url: '',
    config: { coding_agent: 'codex', model: 'gpt-saved' },
    is_default: false,
    created_at: '',
    updated_at: ''
  }])
  mocks.agentSessionApi.start.mockImplementation(async (_agentId: string, taskId: string) => ({ sessionId: `agent-session-${taskId}` }))
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
    expect(screen.getByText('No sessions yet.')).toBeTruthy()
  })

  it('lists sessions with unread badges and clears them on open', async () => {
    api.listSessions.mockResolvedValue([
      session({ id: 'a', title: 'Alpha', updated_at: 2, unread_count: 2 }),
      session({ id: 'b', title: '', updated_at: 1 })
    ])
    render(<CommanderWorkspace />)
    expect(await screen.findByText('Alpha')).toBeTruthy()
    // An untitled session reads "New session" until it is named.
    expect(within(screen.getByLabelText('Commander sessions')).getByText('New session')).toBeTruthy()
    expect(screen.getByLabelText('2 unread')).toBeTruthy()

    api.markRead.mockResolvedValue(session({ id: 'a', title: 'Alpha', updated_at: 2, unread_count: 0 }))
    fireEvent.click(screen.getByText('Alpha'))
    await waitFor(() => expect(screen.queryByLabelText('2 unread')).toBeNull())
    expect(api.markRead).toHaveBeenCalledWith('a')
  })

  it('counts a report for a session that is not open as unread', async () => {
    api.listSessions.mockResolvedValue([session({ id: 'a', title: 'Alpha' }), session({ id: 'b', title: 'Beta' })])
    render(<CommanderWorkspace />)
    await screen.findByText('Beta')
    act(() => {
      emit({ type: 'messages_appended', sessionId: 'b', messages: [message({ session_id: 'b', role: 'report', content: 'done' })] })
      emit({ type: 'session_updated', session: session({ id: 'b', title: 'Beta', unread_count: 1, updated_at: 5 }) })
    })
    expect(screen.getByLabelText('1 unread')).toBeTruthy()
    expect(api.markRead).not.toHaveBeenCalled()
  })

  it('runs the open session as an agent session on its task row', async () => {
    api.listSessions.mockResolvedValue([session({ id: 'a', title: 'Alpha' })])
    render(<CommanderWorkspace />)
    fireEvent.click(await screen.findByText('Alpha'))

    await waitFor(() => expect(panel.props?.taskId).toBe('a'))
    expect(api.prepareSession).toHaveBeenCalledWith('a')
    expect(api.setActiveSession).toHaveBeenCalledWith('a')

    // Sending starts the agent on the row (quietly), then sends like any task.
    await act(async () => {
      await panel.props!.onSend!('Ask Alpha for a status update')
    })
    expect(mocks.agentSessionApi.start).toHaveBeenCalledWith('claude-agent', 'a', undefined, true)
    expect(mocks.agentSessionApi.send).toHaveBeenCalledWith('agent-session-a', 'Ask Alpha for a status update', 'a', 'claude-agent', undefined)
  })

  it('saves the agent choice for every session and moves the open conversation to it', async () => {
    api.listSessions.mockResolvedValue([session({ id: 'a', title: 'Alpha' })])
    render(<CommanderWorkspace />)
    fireEvent.click(await screen.findByText('Alpha'))
    const select = await screen.findByLabelText('Commander agent')
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('claude-agent'))
    expect(screen.getByText('Claude Agent · claude-saved')).toBeTruthy()

    await act(async () => {
      fireEvent.change(select, { target: { value: 'codex-agent' } })
    })
    expect(mocks.settingsApi.set).toHaveBeenCalledWith('commander_agent_id', 'codex-agent')
    await act(async () => {
      await panel.props!.onSend!('hello')
    })
    expect(mocks.agentSessionApi.start).toHaveBeenCalledWith('codex-agent', 'a', undefined, true)
  })

  it('tells main when the view closes, so reports only queue', async () => {
    api.listSessions.mockResolvedValue([])
    const view = render(<CommanderWorkspace />)
    await screen.findByText('Talk to the Commander')
    view.unmount()
    expect(api.setActiveSession).toHaveBeenLastCalledWith(null)
  })
})
