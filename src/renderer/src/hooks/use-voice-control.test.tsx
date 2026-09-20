import { describe, it, expect, beforeEach, vi } from 'vitest'

const hotkey = vi.hoisted(() => ({ fire: null as ((event: { action: string }) => void) | null }))

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
} from '@/lib/voice-dictation-target'
import {
  __resetCommanderCall,
  bindCommanderCallDriver,
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
  hotkey.fire = null
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

  it('routes the global shortcut to an active Commander call instead of Captain', async () => {
    const driver: CommanderCallDriver = {
      setActive: vi.fn(async () => undefined),
      openMicrophone: vi.fn(async () => 'commander-mic'),
      closeMicrophone: vi.fn(),
      stopPlayback: vi.fn(),
      bargeIn: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined)
    }
    bindCommanderCallDriver(driver)
    await useCommanderCallStore.getState().start('commander-session')
    useUIStore.setState({ sidebarView: 'tasks', lastNonCommanderView: 'tasks' })
    await act(async () => { render(<Harness />) })

    await act(async () => { hotkey.fire?.({ action: 'toggle' }) })

    // Routing voice does not expand PiP or throw the user out of their work.
    expect(useUIStore.getState().sidebarView).toBe('tasks')
    expect(useCommanderCallStore.getState().turnId).toBeNull()
    expect(driver.closeMicrophone).toHaveBeenCalledWith('commander-mic')
    expect(toggleTurn).not.toHaveBeenCalled()
    expect(useUIStore.getState().showOrchestrator).toBe(false)
  })

  it('does not claim the system shortcut from an editable control', async () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    await act(async () => { render(<Harness />) })

    await act(async () => { hotkey.fire?.({ action: 'toggle' }) })

    expect(toggleTurn).not.toHaveBeenCalled()
    expect(useUIStore.getState().showOrchestrator).toBe(false)
    textarea.remove()
  })

  it('leaves a muted Commander call foreign to an existing Captain voice turn', async () => {
    const driver: CommanderCallDriver = {
      setActive: vi.fn(async () => undefined),
      openMicrophone: vi.fn(async () => 'commander-mic'),
      closeMicrophone: vi.fn(),
      stopPlayback: vi.fn(),
      bargeIn: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined)
    }
    bindCommanderCallDriver(driver)
    await useCommanderCallStore.getState().start('commander-session')
    await useCommanderCallStore.getState().toggleMicrophone()
    useVoiceStore.setState({ turnId: 'captain-mic' })
    registerComposer(CAPTAIN_COMPOSER_KEY, { getField: () => null, submit: vi.fn() })
    await act(async () => { render(<Harness />) })

    await act(async () => { hotkey.fire?.({ action: 'toggle' }) })

    expect(toggleTurn).toHaveBeenCalledWith('conversation')
    expect(useUIStore.getState().showOrchestrator).toBe(true)
  })
})
