import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { CommanderEvent, CommanderMessage } from '@shared/commander'
import type { VoiceModelState } from '@shared/voice'
import type { VoiceTtsSnapshot } from '@shared/voice-tts'
const mocks = vi.hoisted(() => ({ listeners: new Set<(event: CommanderEvent) => void>() }))
vi.mock('@/lib/ipc-client', async original => ({ ...await original<typeof import('@/lib/ipc-client')>(), commanderApi: { onEvent: (listener: (event: CommanderEvent) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) } } }))
import { CallAnnouncer } from './CallAnnouncer'
import { CommanderActionToast } from './CommanderActionToast'
import { activityNow, __setActivityTimeSource, __resetActivityClock, revalidateActivityNow } from '@/lib/activity/activity-clock'
import { __resetCommanderActivity, useCommanderActivityStore } from '@/lib/activity/commander-activity-adapter'
import { useCommanderCallStore, __resetCommanderCall } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { useCommanderStore } from '@/stores/commander-store'
import { useUIStore } from '@/stores/ui-store'
import { useVoiceStore } from '@/stores/voice-store'

const initialVoice = useVoiceStore.getState()
const message = (id: string, role: CommanderMessage['role'], content: string): CommanderMessage => ({ id, role, content, session_id: 's1', tool_calls: null, tool_call_id: null, tool_name: null, is_error: false, project_id: null, correlation_id: null, created_at: 1 })
function emit(event: CommanderEvent) { act(() => { for (const listener of mocks.listeners) listener(event) }) }
function thinking(turnId = 't1') {
  act(() => useCommanderActivityStore.setState({ sessions: { s1: { sessionId: 's1', turnId, phase: 'thinking', openTools: [], hasText: false, observedAt: activityNow() } } }))
}
beforeEach(() => {
  vi.useFakeTimers(); __resetActivityClock(); __setActivityTimeSource(() => Date.now()); __resetCommanderCall(); __resetCommanderActivity(); mocks.listeners.clear()
  useUIStore.setState({ sidebarView: 'commander' })
  useCommanderStore.setState({ selectedSessionId: 's1', recentAction: null, streaming: {}, turnErrors: {}, undoneActions: [], undoingActions: [] })
  useCommanderCallUiStore.setState({ captions: true, captionSize: 'medium', notice: null })
  useVoiceStore.setState({ ...initialVoice, available: true, enabled: true, permission: 'granted', runtime: { installed: true, version: '', modulePath: '', sizeBytes: 0 }, models: [{ id: 'model', installed: true } as VoiceModelState], engine: { state: 'ready', modelId: 'model', engine: 'fixture' }, tts: { enabled: true, status: { state: 'ready' } } as VoiceTtsSnapshot })
})
afterEach(() => { cleanup(); __resetCommanderCall(); __resetCommanderActivity(); __resetActivityClock(); __setActivityTimeSource(null); useVoiceStore.setState(initialVoice); vi.useRealTimers() })

describe('one honest Commander announcer', () => {
  it('announces unavailable reasons politely once and never partial words', () => {
    useVoiceStore.setState({ permission: 'denied' }); render(<CallAnnouncer />)
    const polite = screen.getByTestId('commander-polite-announcer')
    expect(polite).toHaveTextContent('Microphone access is blocked')
    const original = polite.firstChild
    act(() => useVoiceStore.setState({ partial: 'secret partial words' }))
    expect(polite.firstChild).toBe(original); expect(polite).not.toHaveTextContent('secret partial words')
    expect(screen.getByTestId('commander-assertive-announcer').textContent).toBe('')
  })
  it('waits one second for thinking and cancels notices on completion or unknown/stale activity', () => {
    render(<CallAnnouncer />); thinking()
    act(() => vi.advanceTimersByTime(999))
    expect(screen.getByTestId('commander-polite-announcer')).not.toHaveTextContent('thinking')
    act(() => useCommanderActivityStore.setState({ sessions: { s1: { sessionId: 's1', turnId: 't1', phase: 'idle', openTools: [], hasText: false, observedAt: activityNow() } } }))
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByTestId('commander-polite-announcer')).not.toHaveTextContent('thinking')
    thinking('t2'); act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByTestId('commander-polite-announcer')).toHaveTextContent('Commander is thinking.')
    const announced = screen.getByTestId('commander-polite-announcer').firstChild
    thinking('t3')
    act(() => useCommanderActivityStore.setState({ sessions: { s1: { sessionId: 's1', turnId: 't3', phase: 'thinking', openTools: [], hasText: false, observedAt: activityNow(), unavailable: true, known: false } } }))
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByTestId('commander-polite-announcer').firstChild).toBe(announced)
  })
  it('keeps semantic paragraph announcements for repeated thinking on distinct turns', () => {
    render(<CallAnnouncer />)
    thinking('first-thinking'); act(() => vi.advanceTimersByTime(1000))
    const polite = screen.getByTestId('commander-polite-announcer')
    const first = polite.firstElementChild
    expect(first?.tagName).toBe('P')
    expect(first).toHaveTextContent('Commander is thinking.')
    thinking('second-thinking'); act(() => vi.advanceTimersByTime(999))
    expect(polite.firstElementChild).toBe(first)
    act(() => vi.advanceTimersByTime(1))
    expect(polite.firstElementChild).not.toBe(first)
    expect(polite.firstElementChild?.tagName).toBe('P')
    expect(polite).toHaveTextContent('Commander is thinking.')
    const second = polite.firstElementChild
    thinking('second-thinking'); act(() => vi.advanceTimersByTime(1000))
    expect(polite.firstElementChild).toBe(second)
  })
  it('does not replay a retained turn error after Retry, navigation, session return or End, but announces a new failing turn', async () => {
    useCommanderCallStore.setState({ status: 'live', sessionId: 's1' })
    render(<CallAnnouncer />)
    const error = 'The connection was lost. Retry the reply or type instead.'
    const fail = (turnId: string) => {
      emit({ type: 'turn_started', sessionId: 's1', turnId })
      emit({ type: 'turn_event', sessionId: 's1', turnId, event: { type: 'error', message: error } })
      act(() => {
        useCommanderStore.setState({ turnErrors: { s1: error } })
        useCommanderActivityStore.setState({ sessions: { s1: { sessionId: 's1', turnId, phase: 'error', error, openTools: [], hasText: false, observedAt: activityNow() } } })
      })
    }
    fail('failed-first')
    const urgent = screen.getByTestId('commander-assertive-announcer')
    const first = urgent.firstElementChild
    expect(first?.textContent).toBe(`Commander error: ${error}`)
    await act(async () => { await useCommanderCallStore.getState().retry('failed-first') })
    expect(urgent.firstElementChild).toBe(first)
    act(() => useUIStore.setState({ sidebarView: 'tasks' }))
    act(() => useUIStore.setState({ sidebarView: 'commander' }))
    expect(urgent.firstElementChild).toBe(first)
    act(() => useCommanderStore.setState({ selectedSessionId: 'inbox' }))
    act(() => useCommanderStore.setState({ selectedSessionId: 's1' }))
    expect(urgent.firstElementChild).toBe(first)
    act(() => useCommanderCallStore.getState().end())
    expect(urgent.firstElementChild).toBe(first)
    fail('failed-second')
    expect(urgent.firstElementChild).not.toBe(first)
    expect(urgent.textContent).toBe(`Commander error: ${error}`)
    const second = urgent.firstElementChild
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'failed-second', event: { type: 'error', message: error } })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'failed-second', event: { type: 'done', stopReason: 'cancelled' } })
    expect(urgent.firstElementChild).toBe(second)
  })
  it('allows a new microphone failure with the same wording after the old call ended', () => {
    render(<CallAnnouncer />)
    act(() => useCommanderCallStore.setState({ error: 'Microphone disconnected.', retrySessionId: 's1' }))
    const urgent = screen.getByTestId('commander-assertive-announcer')
    const first = urgent.firstElementChild
    act(() => useUIStore.setState({ sidebarView: 'tasks' }))
    act(() => useUIStore.setState({ sidebarView: 'commander' }))
    expect(urgent.firstElementChild).toBe(first)
    act(() => useCommanderCallStore.getState().end())
    act(() => useCommanderCallStore.setState({ error: 'Microphone disconnected.', retrySessionId: 's1' }))
    expect(urgent.firstElementChild).not.toBe(first)
    expect(urgent.textContent).toBe('Commander error: Microphone disconnected.')
  })
  it('announces ordinary call-off typed Chat after successful completion even with global TTS ready', () => {
    render(<CallAnnouncer />)
    const written = message('written', 'assistant', 'This is the final typed reply.')
    emit({ type: 'turn_started', sessionId: 's1', turnId: 'typed-turn' })
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'typed-turn', messages: [written] })
    const polite = screen.getByTestId('commander-polite-announcer')
    expect(polite).not.toHaveTextContent(written.content)
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'typed-turn', event: { type: 'done', stopReason: 'end_turn' } })
    expect(polite.textContent).toBe(`Commander replied: ${written.content}`)
    expect(polite.firstElementChild?.tagName).toBe('P')
    const original = polite.firstChild
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'typed-turn', messages: [written] })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'typed-turn', event: { type: 'done', stopReason: 'end_turn' } })
    expect(polite.firstChild).toBe(original)
  })
  it('suppresses active-call spoken replies but announces a completed call reply when speech is off', () => {
    useCommanderCallStore.setState({ status: 'live', sessionId: 's1' })
    render(<CallAnnouncer />)
    const spoken = message('spoken', 'assistant', 'Delivered through the active call voice.')
    emit({ type: 'turn_started', sessionId: 's1', turnId: 'spoken-turn' })
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'spoken-turn', messages: [spoken] })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'spoken-turn', event: { type: 'done', stopReason: 'end_turn' } })
    const polite = screen.getByTestId('commander-polite-announcer')
    expect(polite).not.toHaveTextContent(spoken.content)
    act(() => useVoiceStore.setState({ tts: { enabled: false, status: { state: 'ready' } } as VoiceTtsSnapshot }))
    const written = message('text-only', 'assistant', 'The call reply uses text only.')
    emit({ type: 'turn_started', sessionId: 's1', turnId: 'text-only-turn' })
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'text-only-turn', messages: [written] })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'text-only-turn', event: { type: 'done', stopReason: 'end_turn' } })
    expect(polite).toHaveTextContent(written.content)
  })
  it.each(['end', 'disable speech'] as const)('remembers turn speech intent after %s before final persistence', action => {
    useCommanderCallStore.setState({ status: 'live', sessionId: 's1' })
    render(<CallAnnouncer />)
    emit({ type: 'turn_started', sessionId: 's1', turnId: 'spoken-turn' })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'spoken-turn', event: { type: 'text_delta', text: 'Already delivered while the call was open.' } })
    act(() => {
      if (action === 'end') useCommanderCallStore.getState().end()
      else useVoiceStore.setState({ tts: { enabled: false, status: { state: 'ready' } } as VoiceTtsSnapshot })
    })
    const stored = message('late-spoken', 'assistant', 'Already delivered while the call was open.')
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'spoken-turn', messages: [stored] })
    // A final success may race End after speech was already delivered.
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'spoken-turn', event: { type: 'done', stopReason: 'end_turn' } })
    expect(screen.getByTestId('commander-polite-announcer')).not.toHaveTextContent(stored.content)
  })
  it('remembers speech enabled during a typed turn before End, rather than replaying its spoken tail', () => {
    render(<CallAnnouncer />)
    emit({ type: 'turn_started', sessionId: 's1', turnId: 'mixed-turn' })
    act(() => useCommanderCallStore.setState({ status: 'starting', sessionId: 's1' }))
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'mixed-turn', event: { type: 'text_delta', text: 'The tail is spoken in this call.' } })
    act(() => useCommanderCallStore.getState().end())
    const stored = message('mixed', 'assistant', 'The tail is spoken in this call.')
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'mixed-turn', messages: [stored] })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'mixed-turn', event: { type: 'done', stopReason: 'end_turn' } })
    expect(screen.getByTestId('commander-polite-announcer')).not.toHaveTextContent(stored.content)
  })
  it.each(['cancelled', 'error'] as const)('never reads persisted prefixes/partial replies after %s', stopReason => {
    render(<CallAnnouncer />)
    emit({ type: 'turn_started', sessionId: 's1', turnId: 'partial-turn' })
    const prefix = { ...message('prefix', 'assistant', 'I will change Web now.'), tool_calls: [{ id: 'call', name: 'update_project', input: {} }] }
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'partial-turn', messages: [prefix, message('partial', 'assistant', 'The unfinished reply')] })
    expect(screen.getByTestId('commander-polite-announcer')).not.toHaveTextContent('change Web')
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'partial-turn', event: { type: 'done', stopReason } })
    expect(screen.getByTestId('commander-polite-announcer').textContent).toBe('')
  })
  it('ignores tool-call prefixes/context notes and matches delayed persistence to its own successful turn', () => {
    render(<CallAnnouncer />)
    emit({ type: 'turn_started', sessionId: 's1', turnId: 'old-turn' })
    emit({ type: 'turn_started', sessionId: 's1', turnId: 'new-turn' })
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'old-turn', messages: [message('old', 'assistant', 'Retired turn persistence.')] })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'old-turn', event: { type: 'done', stopReason: 'end_turn' } })
    const prefix = { ...message('prefix', 'assistant', 'I will change Web now.'), tool_calls: [{ id: 'call', name: 'update_project', input: {} }] }
    const context = { ...message('notice', 'assistant', 'Context note from the application.'), tool_name: 'context_notice' }
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'new-turn', messages: [prefix, context] })
    expect(screen.getByTestId('commander-polite-announcer').textContent).toBe('')
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'new-turn', messages: [message('new', 'assistant', 'The final current reply.')] })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'new-turn', event: { type: 'done', stopReason: 'end_turn' } })
    expect(screen.getByTestId('commander-polite-announcer')).toHaveTextContent('The final current reply.')
    expect(screen.getByTestId('commander-polite-announcer')).not.toHaveTextContent('Retired turn')
  })
  it('does not read unmatched history and accepts a proven legacy streamed final only after done', () => {
    render(<CallAnnouncer />)
    emit({ type: 'messages_appended', sessionId: 's1', turnId: 'unseen', messages: [message('unseen', 'assistant', 'Unobserved history.')] })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'unseen', event: { type: 'done', stopReason: 'end_turn' } })
    emit({ type: 'turn_started', sessionId: 's1', turnId: 'legacy' })
    emit({ type: 'messages_appended', sessionId: 's1', messages: [message('mismatch', 'assistant', 'Unmatched legacy text.')] })
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'legacy', event: { type: 'text_delta', text: 'Proven legacy final.' } })
    emit({ type: 'messages_appended', sessionId: 's1', messages: [message('legacy', 'assistant', 'Proven legacy final.')] })
    expect(screen.getByTestId('commander-polite-announcer').textContent).toBe('')
    emit({ type: 'turn_event', sessionId: 's1', turnId: 'legacy', event: { type: 'done', stopReason: 'end_turn' } })
    expect(screen.getByTestId('commander-polite-announcer')).toHaveTextContent('Proven legacy final.')
  })
  it('keeps quiet report arrival cues deduplicated without reading report contents', () => {
    render(<CallAnnouncer />)
    const polite = screen.getByTestId('commander-polite-announcer')
    const report = message('report', 'report', 'Private report evidence must stay quiet.')
    emit({ type: 'messages_appended', sessionId: 'inbox', messages: [report] })
    expect(polite).toHaveTextContent('New project report in Project reports.')
    expect(polite).not.toHaveTextContent(report.content)
    const arrival = polite.firstChild
    emit({ type: 'messages_appended', sessionId: 'inbox', messages: [report] }); expect(polite.firstChild).toBe(arrival)
    emit({ type: 'messages_appended', sessionId: 'inbox', messages: [{ ...report, id: 'next-report' }] }); expect(polite.firstChild).not.toBe(arrival)
  })
  it('announces validated destructive actions and errors assertively, and expires the one Undo toast after eight seconds', () => {
    render(<><CallAnnouncer /><CommanderActionToast /></>)
    const result = { ...message('executed', 'tool', JSON.stringify({ status: 'ok', target: { kind: 'project', id: 'web', name: 'Web' }, changes: [{ field: 'archived', before: false, after: true }], undoId: 'exact-undo' })), tool_call_id: 'archive-1', tool_name: 'archive_project' }
    act(() => useCommanderStore.setState({ recentAction: { call: { id: 'archive-1', name: 'archive_project', input: {} }, result, observedAt: activityNow() } }))
    expect(screen.getByTestId('commander-assertive-announcer')).toHaveTextContent('Web')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByTestId('commander-action-toast')).not.toHaveAttribute('role', 'alert')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(7999)); expect(screen.getByTestId('commander-action-toast')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1); revalidateActivityNow() }); expect(screen.queryByTestId('commander-action-toast')).toBeNull()
    act(() => useCommanderCallStore.setState({ error: 'Microphone disconnected.', retrySessionId: 's1' }))
    expect(screen.getByTestId('commander-assertive-announcer')).toHaveTextContent('Microphone disconnected.')
  })
})
