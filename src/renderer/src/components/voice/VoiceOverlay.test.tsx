import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { VoiceOverlay } from './VoiceOverlay'
import { useVoiceStore } from '@/stores/voice-store'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'
import type { VoiceIntentProposal } from '@shared/voice'

const CREATE_PROPOSAL: VoiceIntentProposal = {
  intent: { type: 'create_task', title: 'Fix login' },
  confidence: 0.95,
  transcript: 'create a task to fix login',
  source: 'deterministic',
  summary: 'Create task “Fix login”',
}

function reset(partial: Partial<ReturnType<typeof useVoiceStore.getState>> = {}): void {
  useVoiceStore.setState({
    available: true,
    enabled: true,
    runtime: { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 },
    engine: { state: 'ready', modelId: 'test', engine: 'sherpa-onnx' },
    state: 'idle',
    turnId: null,
    partial: '',
    final: '',
    level: 0,
    confirmation: null,
    result: null,
    ...partial,
  })
}

describe('VoiceOverlay', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    reset()
  })

  // The mic button says it is listening and stops it. A bubble as well covered
  // the controls underneath it.
  it.each(['listening', 'transcribing'] as const)('draws nothing while %s', (state) => {
    reset({ state, turnId: 'turn-1', partial: 'half a sentence' })
    const { container } = render(<VoiceOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('still cancels the turn on Escape', async () => {
    const cancel = vi.fn(async () => undefined)
    reset({ state: 'listening', turnId: 'turn-1', cancel: cancel as never })
    render(<VoiceOverlay />)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('shows nothing while voice is switched off', () => {
    reset({ enabled: false, state: 'listening' })
    const { container } = render(<VoiceOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing while the speech runtime is not installed', () => {
    reset({
      state: 'listening',
      partial: 'create a task',
      runtime: { installed: false, version: null, modulePath: null, sizeBytes: 0 },
    })
    const { container } = render(<VoiceOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing while the session is idle', () => {
    const { container } = render(<VoiceOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('dismisses a confirmation on Escape during a muted Commander call', () => {
    const real = useVoiceStore.getState().dismiss
    const dismiss = vi.fn(async () => undefined)
    reset({ confirmation: { turnId: 'turn-1', proposal: CREATE_PROPOSAL, reason: 'policy' }, dismiss: dismiss as never })
    useCommanderCallStore.setState({ status: 'live', sessionId: 's1', turnId: null, muted: true })
    render(<VoiceOverlay />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(dismiss).toHaveBeenCalledOnce()
    __resetCommanderCall()
    useVoiceStore.setState({ dismiss: real })
  })

  it('asks for a confirmation before the action runs', async () => {
    reset({ confirmation: { turnId: 'turn-1', proposal: CREATE_PROPOSAL, reason: 'policy' } })
    render(<VoiceOverlay />)

    expect(screen.getByTestId('voice-confirmation')).toHaveTextContent('Create task “Fix login”')
    const confirmButton = screen.getByTestId('voice-confirm-yes')

    await act(async () => {
      confirmButton.click()
    })
    expect(window.electronAPI.voice.confirm).toHaveBeenCalledWith('turn-1', undefined)
  })

  it('offers the matching records when a name is ambiguous', async () => {
    reset({
      confirmation: {
        turnId: 'turn-2',
        proposal: CREATE_PROPOSAL,
        reason: 'ambiguous_task',
        candidates: [
          { id: 't1', label: 'Fix login', kind: 'task' },
          { id: 't2', label: 'Fix login on mobile', kind: 'task' },
        ],
      },
    })
    render(<VoiceOverlay />)

    await act(async () => {
      screen.getByRole('button', { name: 'Fix login on mobile' }).click()
    })
    expect(window.electronAPI.voice.confirm).toHaveBeenCalledWith('turn-2', { taskId: 't2' })
  })

  it('runs nothing when the user cancels the card', async () => {
    reset({ confirmation: { turnId: 'turn-3', proposal: CREATE_PROPOSAL, reason: 'destructive' } })
    render(<VoiceOverlay />)

    await act(async () => {
      screen.getByRole('button', { name: /cancel/i }).click()
    })
    expect(window.electronAPI.voice.dismiss).toHaveBeenCalledWith('turn-3')
    expect(window.electronAPI.voice.confirm).not.toHaveBeenCalled()
  })

  it('reports the result of an action', () => {
    reset({ result: { kind: 'ok', message: 'Created “Fix login”.', at: Date.now() } })
    render(<VoiceOverlay />)
    expect(screen.getByTestId('voice-result')).toHaveTextContent('Created “Fix login”.')
  })
})
