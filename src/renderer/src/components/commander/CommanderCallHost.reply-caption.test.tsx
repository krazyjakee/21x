import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { CommanderEvent, CommanderMessage } from '@shared/commander'
import type { VoiceModelState } from '@shared/voice'
import type { VoiceTtsSnapshot } from '@shared/voice-tts'

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: CommanderEvent) => void>(),
  setActive: vi.fn(async () => ({})),
  bargeIn: vi.fn(async () => ({})),
  send: vi.fn(async () => ({ turnId: 'reply-turn' }))
}))
vi.mock('@/lib/ipc-client', async original => ({
  ...await original<typeof import('@/lib/ipc-client')>(),
  commanderVoiceApi: { setActive: mocks.setActive, bargeIn: mocks.bargeIn, send: mocks.send },
  commanderApi: { onEvent: (listener: (event: CommanderEvent) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) } }
}))

import { useVoiceStore } from '@/stores/voice-store'
import { useCommanderStore } from '@/stores/commander-store'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { __resetCommanderActivity, useCommanderActivityStore } from '@/lib/activity/commander-activity-adapter'
import { activityNow } from '@/lib/activity/activity-clock'
import { voiceCapture } from '@/lib/voice-capture'
import { clearDictationTarget } from '@/lib/voice-dictation-target'
import { CommanderCallHost } from './CommanderCallHost'
import { CommanderStage } from './CommanderStage'

const initial = useVoiceStore.getState()
const startTurn = vi.fn(async () => { useVoiceStore.setState({ turnId: 'mic', turnEpoch: 'epoch', state: 'listening' }); return 'mic' })

beforeEach(() => {
  __resetCommanderCall(); __resetCommanderActivity(); vi.clearAllMocks()
  vi.spyOn(voiceCapture, 'isCapturing', 'get').mockImplementation(() => true)
  useCommanderCallUiStore.setState({ captions: true, captionSize: 'medium', panelOpen: true, pipRequested: false, notice: null })
  useCommanderStore.setState({ sessions: [], selectedSessionId: 's1', messages: { s1: [] }, streaming: {}, turnErrors: {}, recentAction: null })
  useVoiceStore.setState({ ...initial, available: true, enabled: true, permission: 'granted', runtime: { installed: true, version: '', modulePath: '', sizeBytes: 0 },
    models: [{ id: 'model', installed: true } as VoiceModelState], engine: { state: 'ready', modelId: 'model', engine: 'fixture' }, state: 'idle', turnId: null, turnEpoch: null, partial: '', final: '',
    tts: { enabled: true, status: { state: 'ready' } } as VoiceTtsSnapshot, initializeTts: async () => {}, startTurn,
    cancel: async () => { useVoiceStore.setState({ turnId: null, turnEpoch: null, state: 'idle' }) }, stopPlaybackNow: vi.fn() })
})
afterEach(() => { cleanup(); __resetCommanderCall(); clearDictationTarget(); __resetCommanderActivity(); useVoiceStore.setState(initial); vi.restoreAllMocks() })

function message(role: CommanderMessage['role'], content: string, over: Partial<CommanderMessage> = {}): CommanderMessage {
  return { id: `${role}-${content}`, session_id: 's1', role, content, tool_calls: null, tool_call_id: null, tool_name: null, is_error: false, project_id: null, correlation_id: null, created_at: 1, ...over }
}
function emit(event: CommanderEvent): void { act(() => { for (const listener of mocks.listeners) listener(event) }) }
function appended(turnId: string, ...messages: CommanderMessage[]): void { emit({ type: 'messages_appended', sessionId: 's1', turnId, messages }) }
function done(turnId: string): void { emit({ type: 'turn_event', sessionId: 's1', turnId, event: { type: 'done', stopReason: 'end_turn' } }) }
async function liveCall(): Promise<void> {
  render(<><CommanderCallHost /><CommanderStage panelOpen onPanelToggle={() => {}} compact={false} onCompactToggle={() => {}} /></>)
  await act(async () => useCommanderCallStore.getState().start('s1'))
}
async function say(text: string): Promise<void> {
  await act(async () => useCommanderCallStore.getState().sendTranscript(text))
}
const caption = (): HTMLElement => screen.getByTestId('commander-voice-status')

describe('the caption after a spoken sentence', () => {
  it('shows the reply in place of the answered sentence, whether or not it was read aloud', async () => {
    await liveCall()
    await say('Where are we at?')
    expect(caption()).toHaveTextContent('You')
    expect(caption()).toHaveTextContent('Where are we at?')

    appended('reply-turn', message('assistant', '', { tool_calls: [] }), message('tool', 'tool output', { tool_name: 'get_project_summary' }), message('assistant', 'Everything is green.'))
    done('reply-turn')

    expect(caption()).toHaveTextContent('Commander')
    expect(caption()).toHaveTextContent('Everything is green.')
    expect(caption()).not.toHaveTextContent('Where are we at?')
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('s1', 'Where are we at?')
  })

  it('does not take a context notice for the reply', async () => {
    await liveCall()
    await say('Where are we at?')

    appended('reply-turn', message('assistant', '[21x context] Earlier turns are omitted.', { tool_name: 'context_notice' }))

    expect(caption()).toHaveTextContent('Where are we at?')
  })

  it('keeps a new sentence on the caption while the reply it cancelled is stored', async () => {
    await liveCall()
    await say('First question.')
    let release: (value: { turnId: string }) => void = () => {}
    mocks.send.mockImplementationOnce(() => new Promise<{ turnId: string }>(resolve => { release = resolve }))
    await say('Actually, something else.')

    // Main stores what the cancelled turn wrote before it starts the next one.
    appended('reply-turn', message('assistant', 'The answer to the first que'))
    done('reply-turn')
    expect(caption()).toHaveTextContent('Actually, something else.')

    await act(async () => release({ turnId: 'second-turn' }))
    appended('second-turn', message('assistant', 'The second answer.'))
    expect(caption()).toHaveTextContent('The second answer.')
  })

  it('clears a sentence whose turn ended without a reply', async () => {
    await liveCall()
    await say('Where are we at?')

    done('reply-turn')

    expect(caption()).not.toHaveTextContent('Where are we at?')
  })

  it('gives way to the words being spoken now', async () => {
    await liveCall()
    await say('Where are we at?')
    appended('reply-turn', message('assistant', 'Everything is green.'))

    act(() => useVoiceStore.setState({ partial: 'And the' }))

    expect(caption()).toHaveTextContent('You')
    expect(caption()).toHaveTextContent('And the')
  })
})

describe('sounds while a reply is being prepared', () => {
  function replyRunning(): void {
    act(() => useCommanderActivityStore.setState({ sessions: { s1: { sessionId: 's1', turnId: 'reply-turn', phase: 'thinking', openTools: [], hasText: false, observedAt: activityNow() } } }))
  }

  it('does not cancel the reply for a hesitation sound', async () => {
    await liveCall()
    await say('Where are we at?')
    mocks.bargeIn.mockClear()
    replyRunning()

    act(() => useVoiceStore.setState({ partial: 'Mm.' }))

    expect(mocks.bargeIn).not.toHaveBeenCalled()
  })

  it('still cancels it for real words', async () => {
    await liveCall()
    await say('Where are we at?')
    mocks.bargeIn.mockClear()
    replyRunning()

    act(() => useVoiceStore.setState({ partial: 'No, stop' }))

    expect(mocks.bargeIn).toHaveBeenCalledExactlyOnceWith('s1')
  })
})
