import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'

const hotkey = vi.hoisted(() => ({ fire: null as ((event: { action: string }) => void) | null }))
const segment = vi.hoisted(() => ({
  fire: null as ((event: { turnId: string; turnEpoch: string | null; text: string; index: number }) => void) | null,
}))

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  // The store subscribes to every channel as it loads; only the hotkey matters
  // here, so the rest are quiet no-ops.
  voiceApi: new Proxy(
    {
      onHotkey: (cb: (event: { action: string }) => void) => {
        hotkey.fire = cb
        return () => {
          hotkey.fire = null
        }
      },
      onSegment: (cb: NonNullable<typeof segment.fire>) => {
        segment.fire = cb
        return () => {
          segment.fire = null
        }
      },
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
  __resetCommanderCall,
  bindCommanderCallDriver,
  COMMANDER_VOICE_COMPOSER_KEY,
  useCommanderCallStore,
  type CommanderCallDriver,
} from '@/stores/commander-call-store'
import {
  CAPTAIN_COMPOSER_KEY,
  clearDictationTarget,
  getActiveComposer,
  registerComposer,
  setActiveComposer,
} from '@/lib/voice-dictation-target'

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
  __resetCommanderCall()
  vi.clearAllMocks()
  clearDictationTarget()
  hotkey.fire = null
  toggleTurn = vi.fn(async () => undefined)
  useUIStore.setState({ showOrchestrator: false })
  useVoiceStore.setState({
    conversation: true,
    turnId: null,
    confirmation: null,
    toggleTurn: toggleTurn as never,
    initialize: (async () => undefined) as never,
    setContextProvider: vi.fn() as never,
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { voice: {}, ui: {} }
})

describe('a sentence heard during a Commander call', () => {
  function liveCall(micMode: 'open-mic' | 'push-to-talk' = 'open-mic'): CommanderCallDriver {
    const driver: CommanderCallDriver = {
      setActive: vi.fn(async () => undefined),
      openMicrophone: vi.fn(async () => 'mic'),
      closeMicrophone: vi.fn(),
      stopPlayback: vi.fn(),
      bargeIn: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
    }
    bindCommanderCallDriver(driver)
    useCommanderCallStore.setState({ status: 'live', sessionId: 's1', turnId: 'mic', micMode })
    useVoiceStore.setState({ turnId: 'mic', turnEpoch: 'epoch', partial: 'Half a sent', testTranscript: '' })
    render(<Harness />)
    return driver
  }

  it('is sent once even when the call has lost its private composer', () => {
    const driver = liveCall()

    segment.fire?.({ turnId: 'mic', turnEpoch: 'epoch', text: 'Where are we?', index: 1 })

    expect(driver.send).toHaveBeenCalledExactlyOnceWith('s1', 'Where are we?')
    expect(useCommanderCallStore.getState().userCaption).toBe('Where are we?')
    expect(useVoiceStore.getState()).toMatchObject({ partial: '', testTranscript: '' })
  })

  it('goes through the composer alone when the composer is there', () => {
    const driver = liveCall()
    const field = document.createElement('textarea')
    document.body.append(field)
    const submit = vi.fn()
    registerComposer(COMMANDER_VOICE_COMPOSER_KEY, { getField: () => field, submit, focusOnInsert: false })
    setActiveComposer(COMMANDER_VOICE_COMPOSER_KEY)

    segment.fire?.({ turnId: 'mic', turnEpoch: 'epoch', text: 'Where are we?', index: 1 })

    expect(submit).toHaveBeenCalledOnce()
    expect(driver.send).not.toHaveBeenCalled()
    field.remove()
  })

  it('does not change what push-to-talk does with a lost composer', () => {
    const driver = liveCall('push-to-talk')

    segment.fire?.({ turnId: 'mic', turnEpoch: 'epoch', text: 'Held sentence.', index: 1 })

    expect(driver.send).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().testTranscript).toBe('Held sentence.')
  })
})

describe('the global shortcut', () => {
  it('targets the surviving Commander call instead of claiming Captain or opening another turn', async () => {
    const toggleMicrophone = vi.fn(async () => {})
    const initialToggle = useCommanderCallStore.getState().toggleMicrophone
    useCommanderCallStore.setState({ status: 'live', sessionId: 'call-session', toggleMicrophone })
    await act(async () => { render(<Harness />) })
    expect(hotkey.fire).toBeTypeOf('function')
    await act(async () => { hotkey.fire?.({ action: 'toggle' }) })
    expect(toggleMicrophone).toHaveBeenCalledOnce()
    expect(toggleTurn).not.toHaveBeenCalled()
    expect(useUIStore.getState().showOrchestrator).toBe(false)
    expect(getActiveComposer()).not.toBe(CAPTAIN_COMPOSER_KEY)
    useCommanderCallStore.setState({ toggleMicrophone: initialToggle })
  })
  it('starts and finishes a PTT sentence on the Commander call and ignores a starting call', async () => {
    const state = useCommanderCallStore.getState()
    const beginTalk = vi.fn(async () => {}), finishTalk = vi.fn()
    useCommanderCallStore.setState({ status: 'starting', sessionId: 'call-session', micMode: 'push-to-talk', beginTalk, finishTalk })
    await act(async () => { render(<Harness />) })
    expect(hotkey.fire).toBeTypeOf('function')
    await act(async () => { hotkey.fire?.({ action: 'toggle' }) })
    expect(beginTalk).not.toHaveBeenCalled(); expect(toggleTurn).not.toHaveBeenCalled()
    useCommanderCallStore.setState({ status: 'live' })
    await act(async () => hotkey.fire?.({ action: 'toggle' }))
    expect(beginTalk).toHaveBeenCalledOnce()
    useCommanderCallStore.setState({ pttHeld: true })
    await act(async () => hotkey.fire?.({ action: 'toggle' }))
    expect(finishTalk).toHaveBeenCalledOnce(); expect(toggleTurn).not.toHaveBeenCalled()
    useCommanderCallStore.setState({ beginTalk: state.beginTalk, finishTalk: state.finishTalk })
  })
  describe('during a Commander call', () => {
    let toggleMicrophone: ReturnType<typeof vi.fn>
    const realToggle = useCommanderCallStore.getState().toggleMicrophone
    const fire = () => act(async () => hotkey.fire?.({ action: 'toggle' }))
    beforeEach(async () => {
      toggleMicrophone = vi.fn(async () => {})
      useCommanderCallStore.setState({ status: 'live', sessionId: 'call-session', toggleMicrophone: toggleMicrophone as never })
      await act(async () => { render(<Harness />) })
    })
    afterEach(() => {
      useCommanderCallStore.setState({ toggleMicrophone: realToggle })
      document.body.innerHTML = ''
      vi.restoreAllMocks()
    })

    it('waits for a pending voice confirmation', async () => {
      useVoiceStore.setState({ confirmation: { turnId: 'other', proposal: {} as never, reason: 'policy' } })
      await fire()
      expect(toggleMicrophone).not.toHaveBeenCalled()
      expect(toggleTurn).not.toHaveBeenCalled()
    })
    it('waits for an open dialog', async () => {
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog"></div>')
      await fire()
      expect(toggleMicrophone).not.toHaveBeenCalled()
    })
    it('leaves another editor alone only while this window has focus', async () => {
      document.body.insertAdjacentHTML('beforeend', '<textarea aria-label="Task notes"></textarea>')
      document.querySelector<HTMLTextAreaElement>('textarea')!.focus()
      const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      await fire()
      expect(toggleMicrophone).not.toHaveBeenCalled()
      // Pressed from another application: the field still has this document's focus.
      focused.mockReturnValue(false)
      await fire()
      expect(toggleMicrophone).toHaveBeenCalledOnce()
    })
    it('can always finish a sentence that is being held', async () => {
      const finishTalk = vi.fn()
      const original = useCommanderCallStore.getState().finishTalk
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog"></div>')
      useCommanderCallStore.setState({ micMode: 'push-to-talk', pttHeld: true, finishTalk })
      await fire()
      expect(finishTalk).toHaveBeenCalledOnce()
      useCommanderCallStore.setState({ finishTalk: original })
    })
    it('stays with a microphone another surface owns', async () => {
      useVoiceStore.setState({ turnId: 'captain-turn' })
      await fire()
      expect(toggleMicrophone).not.toHaveBeenCalled()
      expect(toggleTurn).toHaveBeenCalledOnce()
    })
  })

  it('talks to Captain rather than running a command', async () => {
    registerComposer(CAPTAIN_COMPOSER_KEY, { getField: () => null, submit: vi.fn() })
    await act(async () => {
      render(<Harness />)
    })

    await act(async () => {
      hotkey.fire?.({ action: 'toggle' })
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
      hotkey.fire?.({ action: 'toggle' })
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
      hotkey.fire?.({ action: 'toggle' })
    })
    expect(toggleTurn).toHaveBeenCalledWith('dictation')
  })
})
