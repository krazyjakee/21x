import { describe, it, expect, beforeEach, vi } from 'vitest'

const events = vi.hoisted(() => ({
  hotkey: null as ((event: { action: string }) => void) | null,
  dictate: null as ((event: { turnId: string; text: string }) => void) | null,
  segment: null as ((event: { turnId: string; text: string; index: number }) => void) | null
}))

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  // The store subscribes to every channel as it loads; only the hotkey matters
  // here, so the rest are quiet no-ops.
  voiceApi: new Proxy(
    {
      onHotkey: (cb: (event: { action: string }) => void) => {
        events.hotkey = cb
        return () => {
          events.hotkey = null
        }
      },
      onDictate: (cb: (event: { turnId: string; text: string }) => void) => {
        events.dictate = cb
        return () => { events.dictate = null }
      },
      onSegment: (cb: (event: { turnId: string; text: string; index: number }) => void) => {
        events.segment = cb
        return () => { events.segment = null }
      }
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        return prop.startsWith('on') ? () => () => {} : async () => undefined
      },
    }
  ),
}))

import { act, cleanup, render } from '@testing-library/react'
import { useVoiceControl } from './use-voice-control'
import { useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import {
  CAPTAIN_COMPOSER_KEY,
  clearDictationTarget,
  getActiveComposer,
  registerComposer,
  setActiveComposer,
} from '@/lib/voice-dictation-target'
import {
  __resetCommanderCall,
  bindCommanderCallDriver,
  COMMANDER_VOICE_COMPOSER_KEY,
  useCommanderCallStore,
  type CommanderCallDriver
} from '@/stores/commander-call-store'

/**
 * The global shortcut.
 *
 * The rule this file protects: speech goes to the agent. The shortcut used to
 * run the eight built-in command rules instead, so anything outside those
 * phrases was rejected — and the agent can do far more than eight things.
 */

function Harness(): null {
  useVoiceControl()
  return null
}

let toggleTurn: ReturnType<typeof vi.fn>

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  clearDictationTarget()
  __resetCommanderCall()
  events.hotkey = null
  events.dictate = null
  events.segment = null
  toggleTurn = vi.fn(async () => undefined)
  useUIStore.setState({ showOrchestrator: false })
  useVoiceStore.setState({
    conversation: true,
    toggleTurn: toggleTurn as never,
    initialize: (async () => undefined) as never,
    setContextProvider: vi.fn() as never,
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { voice: {}, ui: {} }
})

describe('the global shortcut', () => {
  it('talks to Captain rather than running a command', async () => {
    registerComposer(CAPTAIN_COMPOSER_KEY, { getField: () => null, submit: vi.fn() })
    await act(async () => {
      render(<Harness />)
    })

    await act(async () => {
      events.hotkey?.({ action: 'toggle' })
    })

    // Never 'command': that mode is what rejected anything outside eight phrases.
    expect(toggleTurn).toHaveBeenCalledWith('conversation')
    expect(getActiveComposer()).toBe(CAPTAIN_COMPOSER_KEY)
    // Opened, so the words arrive somewhere the user can see.
    expect(useUIStore.getState().showOrchestrator).toBe(true)
  })

  it('dictates one turn when the loop is switched off', async () => {
    useVoiceStore.setState({ conversation: false })
    registerComposer(CAPTAIN_COMPOSER_KEY, { getField: () => null, submit: vi.fn() })
    await act(async () => {
      render(<Harness />)
    })

    await act(async () => {
      events.hotkey?.({ action: 'toggle' })
    })
    expect(toggleTurn).toHaveBeenCalledWith('dictation')
  })

  it('dictates one turn when the drawer cannot send', async () => {
    // No submit registered: a loop would have nowhere to send each sentence.
    registerComposer(CAPTAIN_COMPOSER_KEY, { getField: () => null })
    await act(async () => {
      render(<Harness />)
    })

    await act(async () => {
      events.hotkey?.({ action: 'toggle' })
    })
    expect(toggleTurn).toHaveBeenCalledWith('dictation')
  })

  it('routes the global shortcut to an active Commander call instead of Captain', async () => {
    const driver: CommanderCallDriver = {
      setActive: vi.fn(async () => undefined),
      prepare: vi.fn(async () => undefined),
      openMicrophone: vi.fn(async () => 'commander-mic'),
      closeMicrophone: vi.fn(),
      finishMicrophone: vi.fn(),
      stopPlayback: vi.fn(),
      bargeIn: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined)
    }
    bindCommanderCallDriver(driver)
    await useCommanderCallStore.getState().setMicrophoneMode('open-mic')
    await useCommanderCallStore.getState().start('commander-session')
    useUIStore.setState({ sidebarView: 'tasks', lastNonCommanderView: 'tasks' })
    await act(async () => { render(<Harness />) })

    await act(async () => { events.hotkey?.({ action: 'toggle' }) })

    // Routing voice does not expand PiP or throw the user out of their work.
    expect(useUIStore.getState().sidebarView).toBe('tasks')
    expect(useCommanderCallStore.getState().turnId).toBeNull()
    expect(driver.closeMicrophone).toHaveBeenCalledWith('commander-mic')
    expect(toggleTurn).not.toHaveBeenCalled()
    expect(useUIStore.getState().showOrchestrator).toBe(false)
  })
})

describe('Commander transcript safety', () => {
  it('submits a PTT dictation only from main\'s finalized dictate event', async () => {
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    const submit = vi.fn()
    registerComposer(COMMANDER_VOICE_COMPOSER_KEY, { getField: () => field, submit })
    setActiveComposer(COMMANDER_VOICE_COMPOSER_KEY)
    await act(async () => { render(<Harness />) })

    useVoiceStore.setState({ turnId: 'ptt-1', mode: 'dictation', partial: 'archive the' })
    act(() => events.segment?.({ turnId: 'ptt-1', text: 'archive the project', index: 1 }))
    expect(submit).not.toHaveBeenCalled()

    act(() => events.dictate?.({ turnId: 'ptt-1', text: 'archive the project' }))
    expect(field.value).toBe('archive the project')
    expect(submit).toHaveBeenCalledTimes(1)
    field.remove()
  })

  it('drops stale conversation segments before they can submit', async () => {
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    const submit = vi.fn()
    registerComposer(COMMANDER_VOICE_COMPOSER_KEY, { getField: () => field, submit })
    setActiveComposer(COMMANDER_VOICE_COMPOSER_KEY)
    await act(async () => { render(<Harness />) })
    useVoiceStore.setState({ turnId: 'live-turn', mode: 'conversation' })

    act(() => events.segment?.({ turnId: 'old-turn', text: 'delete everything', index: 1 }))

    expect(submit).not.toHaveBeenCalled()
    expect(field.value).toBe('')
    field.remove()
  })

  it('drops a finalized PTT dictate event after a newer turn has replaced it', async () => {
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    const submit = vi.fn()
    registerComposer(COMMANDER_VOICE_COMPOSER_KEY, { getField: () => field, submit })
    setActiveComposer(COMMANDER_VOICE_COMPOSER_KEY)
    await act(async () => { render(<Harness />) })
    useVoiceStore.setState({ turnId: 'new-turn', finalizingTurnId: null, mode: 'dictation' })

    act(() => events.dictate?.({ turnId: 'old-turn', text: 'archive the project' }))

    expect(submit).not.toHaveBeenCalled()
    expect(field.value).toBe('')
    field.remove()
  })
})
