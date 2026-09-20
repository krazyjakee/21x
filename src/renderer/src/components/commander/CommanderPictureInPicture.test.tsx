import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { VoiceModelState } from '@shared/voice'
import type { VoiceTtsSnapshot } from '@shared/voice-tts'

const mocks = vi.hoisted(() => ({ undoAction: vi.fn(async () => ({ status: 'undone' })) }))
vi.mock('@/lib/ipc-client', async (original) => {
  const actual = await original<typeof import('@/lib/ipc-client')>()
  return { ...actual, commanderApi: { ...actual.commanderApi, undoAction: mocks.undoAction } }
})

import {
  __resetCommanderCall,
  bindCommanderCallDriver,
  useCommanderCallStore,
  type CommanderCallDriver
} from '@/stores/commander-call-store'
import { useVoiceStore } from '@/stores/voice-store'
import { useUIStore } from '@/stores/ui-store'
import { enterCommanderPictureInPicture } from '@/lib/commander-call/commander-call-ui'
import { CommanderPictureInPicture, snapPictureInPictureCorner } from './CommanderPictureInPicture'

const initialVoice = useVoiceStore.getState()
const INSTALLED_MODEL = { id: 'parakeet', installed: true } as unknown as VoiceModelState
const TTS_READY = { enabled: true, status: { state: 'ready' } } as unknown as VoiceTtsSnapshot

function driver(): CommanderCallDriver {
  return {
    setActive: vi.fn(async () => undefined),
    prepare: vi.fn(async () => undefined),
    openMicrophone: vi.fn(async () => 'mic-1'),
    closeMicrophone: vi.fn(),
    finishMicrophone: vi.fn(),
    stopPlayback: vi.fn(),
    bargeIn: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined)
  }
}

function Surface(): React.JSX.Element {
  const view = useUIStore((s) => s.sidebarView)
  return (
    <>
      {view === 'commander' && (
        <button data-commander-pip-toggle onClick={() => enterCommanderPictureInPicture()}>Picture in picture</button>
      )}
      <CommanderPictureInPicture />
    </>
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  __resetCommanderCall()
  localStorage.clear()
  useUIStore.setState({
    sidebarView: 'dashboard',
    lastNonCommanderView: 'dashboard',
    activeModal: null,
    commanderCaptionsEnabled: true
  })
  useVoiceStore.setState({
    ...initialVoice,
    available: true,
    enabled: true,
    runtime: { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 },
    engine: { state: 'ready', modelId: 'parakeet', engine: 'sherpa-onnx' },
    models: [INSTALLED_MODEL],
    permission: 'granted',
    tts: TTS_READY,
    turnId: 'mic-1',
    state: 'listening',
    partial: 'archive the web project',
    final: '',
    speechText: '',
    speaking: false
  }, true)
  bindCommanderCallDriver(driver())
  await useCommanderCallStore.getState().setMicrophoneMode('open-mic')
  await useCommanderCallStore.getState().start('session-1')
})

afterEach(() => {
  cleanup()
  __resetCommanderCall()
  useVoiceStore.setState(initialVoice, true)
})

describe('Commander picture in picture', () => {
  it('shows the shared call after leaving Commander, with caption and controls', () => {
    render(<CommanderPictureInPicture />)
    expect(screen.getByTestId('commander-pip')).toHaveClass('w-[280px]')
    expect(screen.getByLabelText('Commander picture in picture')).toHaveTextContent('Commander')
    expect(screen.getByLabelText('Commander picture in picture')).toHaveTextContent('archive the web project')
    expect(screen.getByRole('toolbar', { name: 'Commander picture in picture controls' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mute microphone' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('honours the shared captions preference in PiP', () => {
    useUIStore.setState({ commanderCaptionsEnabled: false })
    render(<CommanderPictureInPicture />)

    expect(screen.getByLabelText('Captions off')).toHaveTextContent('Captions off')
    expect(screen.queryByText('archive the web project')).toBeNull()
  })

  it('keeps keyboard focus on counterpart controls across full view and PiP', async () => {
    useUIStore.setState({ sidebarView: 'commander' })
    render(<Surface />)
    const collapse = screen.getByRole('button', { name: 'Picture in picture' })
    collapse.focus()
    fireEvent.click(collapse)

    const expand = await screen.findByRole('button', { name: 'Expand Commander call' })
    await waitFor(() => expect(expand).toHaveFocus())
    fireEvent.click(expand)

    const restored = await screen.findByRole('button', { name: 'Picture in picture' })
    await waitFor(() => expect(restored).toHaveFocus())
    expect(useUIStore.getState().sidebarView).toBe('commander')
  })

  it('shows the latest action toast and invokes exact Undo only when reversible', async () => {
    act(() => useCommanderCallStore.getState().recordEvent({
      kind: 'action',
      at: performance.now(),
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'archive_project'
    }))
    render(<CommanderPictureInPicture />)

    expect(screen.getByTestId('commander-action-toast')).toHaveTextContent('Archive project')
    expect(screen.getByTestId('commander-action-toast')).toHaveClass('bottom-full')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(mocks.undoAction).toHaveBeenCalledWith('session-1', 'call-1'))
    await waitFor(() => expect(screen.queryByTestId('commander-action-toast')).toBeNull())
  })

  it('opens the action toast into the viewport from a top corner', () => {
    localStorage.setItem('commander-pip-corner', 'top-right')
    act(() => useCommanderCallStore.getState().recordEvent({
      kind: 'action',
      at: performance.now(),
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-2',
      toolName: 'archive_project'
    }))
    render(<CommanderPictureInPicture />)

    expect(screen.getByTestId('commander-action-toast')).toHaveClass('top-full')
  })

  it('snaps a dragged tile to the nearest viewport corner', () => {
    expect(snapPictureInPictureCorner(10, 10, 1_000, 800)).toBe('top-left')
    expect(snapPictureInPictureCorner(900, 20, 1_000, 800)).toBe('top-right')
    expect(snapPictureInPictureCorner(20, 700, 1_000, 800)).toBe('bottom-left')
    expect(snapPictureInPictureCorner(900, 700, 1_000, 800)).toBe('bottom-right')
  })
})
