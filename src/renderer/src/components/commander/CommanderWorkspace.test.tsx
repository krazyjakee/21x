import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CommanderEvent, CommanderMessage, CommanderSession } from '@shared/commander'

const api = vi.hoisted(() => ({
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
}))
vi.mock('@/lib/ipc-client', () => ({ commanderApi: api }))

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

beforeEach(() => {
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
    fireEvent.click(await screen.findByText('Launch'))

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
    expect(toolCallLabel('ask_mastermind', { project: 'Web', message: 'Deploy the site' })).toBe('Asked Web: Deploy the site')
    expect(toolCallLabel('list_projects', {})).toBe('List projects')
    expect(toolCallLabel('archive_project', { project: 'Web' })).toBe('Archive project · Web')
    expect(toolCallLabel('navigate_to_project', { project: 'Web' })).toBe('Navigate to project · Web')
  })
})
