import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'

// Stores subscribe to IPC events at import time; every export is a no-op here.
vi.mock('@/lib/ipc-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.keys(actual).map((key) => [key, new Proxy(() => () => undefined, { get: () => vi.fn() })]))
})

import { useUIStore } from '@/stores/ui-store'
import { useSkillStore } from '@/stores/skill-store'
import { useVoiceStore } from '@/stores/voice-store'
import { modKey } from '@/lib/platform'
import { CommandPalette, type CommandPaletteActions } from './CommandPalette'
import { useGlobalShortcuts } from './hooks/use-global-shortcuts'
import { NAV_ITEMS, navShortcutDigit } from './nav-items'
import {
  __resetCommanderCall,
  bindCommanderCallDriver,
  useCommanderCallStore,
  type CommanderCallDriver
} from '@/stores/commander-call-store'

const actions = new Proxy({}, { get: () => vi.fn() }) as CommandPaletteActions

beforeEach(() => {
  __resetCommanderCall()
  useSkillStore.setState({ fetchSkills: vi.fn(async () => undefined), skills: [] } as never)
  useVoiceStore.setState({ turnId: null, confirmation: null })
  useUIStore.setState({
    sidebarView: 'dashboard',
    lastNonCommanderView: 'dashboard',
    activeModal: null,
    commanderCaptionsEnabled: true,
    commanderPanelOpen: true
  })
})
afterEach(() => {
  cleanup()
  __resetCommanderCall()
})

async function openCall(): Promise<CommanderCallDriver> {
  let microphone = 0
  const driver: CommanderCallDriver = {
    setActive: vi.fn(async () => undefined),
    openMicrophone: vi.fn(async () => `mic-${++microphone}`),
    closeMicrophone: vi.fn(),
    stopPlayback: vi.fn(),
    bargeIn: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined)
  }
  bindCommanderCallDriver(driver)
  await useCommanderCallStore.getState().start('session-1')
  return driver
}

describe('Commander navigation', () => {
  it('keeps Mod+1–4 on the existing views and puts Commander on Mod+5', () => {
    expect(NAV_ITEMS.slice(0, 4).map((item) => item.key)).toEqual(['dashboard', 'canvas', 'tasks', 'skills'])
    expect(navShortcutDigit('commander')).toBe(5)
  })

  it.each([
    ['1', 'dashboard'],
    ['4', 'skills'],
    ['5', 'commander']
  ])('Mod+%s opens %s', (digit, view) => {
    renderHook(() => useGlobalShortcuts(actions, vi.fn()))
    fireEvent.keyDown(window, { key: digit, ctrlKey: true })
    expect(useUIStore.getState().sidebarView).toBe(view)
  })

  it('lists "Go to Commander" with its shortcut and opens Commander', () => {
    const onOpenChange = vi.fn()
    render(<CommandPalette open onOpenChange={onOpenChange} actions={actions} />)
    fireEvent.change(screen.getByPlaceholderText(/run a command/), { target: { value: 'commander' } })
    const entry = screen.getByRole('button', { name: /Go to Commander/ })
    expect(entry.textContent).toContain(`${modKey}5`)
    fireEvent.click(entry)
    expect(useUIStore.getState().sidebarView).toBe('commander')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('routes Commander call chords to the shared call and call chrome', async () => {
    const driver = await openCall()
    useUIStore.getState().setSidebarView('commander')
    renderHook(() => useGlobalShortcuts(actions, vi.fn()))

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    await vi.waitFor(() => expect(useCommanderCallStore.getState().turnId).toBeNull())
    expect(driver.closeMicrophone).toHaveBeenCalledWith('mic-1')

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true, shiftKey: true })
    expect(useUIStore.getState().commanderCaptionsEnabled).toBe(false)
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
    expect(useUIStore.getState().commanderPanelOpen).toBe(false)

    fireEvent.keyDown(window, { key: 'm', ctrlKey: true, shiftKey: true })
    expect(useUIStore.getState().sidebarView).toBe('dashboard')
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true, shiftKey: true })
    expect(useUIStore.getState().sidebarView).toBe('commander')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(driver.bargeIn).toHaveBeenCalledWith('session-1')
    expect(useCommanderCallStore.getState().status).toBe('live')

    fireEvent.keyDown(window, { key: 'e', ctrlKey: true, shiftKey: true })
    expect(useCommanderCallStore.getState().status).toBe('off')
  })

  it('uses Mod+Z only for a reversible live action and preserves native text undo', async () => {
    await openCall()
    useCommanderCallStore.getState().recordEvent({
      kind: 'action',
      at: performance.now(),
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'archive_project'
    })
    renderHook(() => useGlobalShortcuts(actions, vi.fn()))
    const input = document.createElement('input')
    document.body.appendChild(input)

    expect(fireEvent.keyDown(input, { key: 'z', ctrlKey: true })).toBe(true)
    expect(useCommanderCallStore.getState().lastEvent).not.toBeNull()

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await vi.waitFor(() => expect(useCommanderCallStore.getState().lastEvent).toBeNull())
    input.remove()
  })

  it.each([
    ['d', false], ['c', true], ['\\', false], ['m', true], ['e', true], ['z', false], ['Escape', false]
  ])('leaves Commander shortcut %s to editable/native handling', async (key, shiftKey) => {
    const driver = await openCall()
    renderHook(() => useGlobalShortcuts(actions, vi.fn()))
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)

    expect(fireEvent.keyDown(textarea, {
      key,
      ctrlKey: key !== 'Escape',
      shiftKey
    })).toBe(true)
    expect(driver.closeMicrophone).not.toHaveBeenCalled()
    expect(driver.bargeIn).not.toHaveBeenCalled()
    expect(useCommanderCallStore.getState().status).toBe('live')
    textarea.remove()
  })

  it('suppresses repeated Commander shortcuts without falling through', async () => {
    const driver = await openCall()
    renderHook(() => useGlobalShortcuts(actions, vi.fn()))

    expect(fireEvent.keyDown(window, { key: 'd', ctrlKey: true, repeat: true })).toBe(false)
    expect(driver.closeMicrophone).not.toHaveBeenCalled()
    expect(useCommanderCallStore.getState().turnId).toBe('mic-1')
  })

  it('leaves Escape to a foreign Captain voice turn while Commander is muted', async () => {
    const driver = await openCall()
    await useCommanderCallStore.getState().toggleMicrophone()
    useVoiceStore.setState({ turnId: 'captain-turn', confirmation: null })
    renderHook(() => useGlobalShortcuts(actions, vi.fn()))

    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(true)
    expect(driver.bargeIn).not.toHaveBeenCalled()
  })
})
