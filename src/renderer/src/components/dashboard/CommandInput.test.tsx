import { describe, it, expect, beforeEach, vi } from 'vitest'

// happy-dom has no microphone, so the real capture would end the turn at once.
vi.mock('@/lib/voice-capture', () => ({
  voiceCapture: {
    isCapturing: false,
    start: vi.fn(async () => true),
    stop: vi.fn(),
    release: vi.fn(async () => undefined),
  },
}))

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandInput } from './CommandInput'
import { useVoiceStore } from '@/stores/voice-store'
import { useAgentStore } from '@/stores/agent-store'
import type { Agent } from '@/types'
import {
  clearDictationTarget,
  insertAndSubmit,
  insertDictation,
  setActiveComposer,
} from '@/lib/voice-dictation-target'

const RUNTIME = { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 }

function voiceReady(): void {
  useVoiceStore.setState({
    available: true,
    enabled: true,
    runtime: RUNTIME,
    engine: { state: 'ready', modelId: 'test', engine: 'sherpa-onnx' },
    conversation: true,
    turnId: null,
    state: 'idle',
  })
}

describe('CommandInput — dictation', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    clearDictationTarget()
    voiceReady()
  })

  it('offers a microphone once voice is ready', async () => {
    await act(async () => {
      render(<CommandInput onSendToCaptain={vi.fn()} onCreateTask={vi.fn()} />)
    })
    expect(screen.getByTestId('voice-mic-button')).toBeInTheDocument()
  })

  it.each(['Enter', 'Send'])('sends typed text to the Captain via %s', async (button) => {
    const send = vi.fn()
    await act(async () => { render(<CommandInput onSendToCaptain={send} onCreateTask={vi.fn()} />) })
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'Merge PR #12' } })
    if (button === 'Enter') fireEvent.keyDown(field, { key: 'Enter' })
    else fireEvent.click(screen.getByRole('button', { name: 'Send to Captain' }))
    expect(send).toHaveBeenCalledWith('Merge PR #12')
  })

  it('sends a dictated draft on manual Send', async () => {
    const send = vi.fn()
    await act(async () => { render(<CommandInput onSendToCaptain={send} onCreateTask={vi.fn()} />) })
    setActiveComposer('dashboard-command')
    await act(async () => { expect(insertDictation('Merge PR #12')).toBe(true) })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Captain' }))
    expect(send).toHaveBeenCalledWith('Merge PR #12')
  })

  it('hides the microphone while voice is switched off', async () => {
    useVoiceStore.setState({ enabled: false })
    await act(async () => {
      render(<CommandInput onSendToCaptain={vi.fn()} onCreateTask={vi.fn()} />)
    })
    expect(screen.queryByTestId('voice-mic-button')).not.toBeInTheDocument()
  })

  it('sends the words it just heard, not the value React held before', async () => {
    // This box is controlled. A send that read React state would send the
    // previous value, because dictation writes and sends in the same tick.
    const onSendToCaptain = vi.fn()
    await act(async () => {
      render(<CommandInput onSendToCaptain={onSendToCaptain} onCreateTask={vi.fn()} />)
    })
    setActiveComposer('dashboard-command')

    await act(async () => {
      expect(insertAndSubmit('what is blocking the release')).toBe(true)
    })

    expect(onSendToCaptain).toHaveBeenCalledWith('what is blocking the release')
  })

  it('clears the box after each sentence, so a conversation does not repeat itself', async () => {
    const onSendToCaptain = vi.fn()
    await act(async () => {
      render(<CommandInput onSendToCaptain={onSendToCaptain} onCreateTask={vi.fn()} />)
    })
    setActiveComposer('dashboard-command')

    await act(async () => {
      insertAndSubmit('first sentence')
    })
    await act(async () => {
      insertAndSubmit('second sentence')
    })

    expect(onSendToCaptain.mock.calls.map((call) => call[0])).toEqual([
      'first sentence',
      'second sentence',
    ])
  })
})

describe('CommandInput — agent selector', () => {
  const agent = (id: string, name: string, is_default = false) => ({ id, name, is_default }) as Agent
  beforeEach(() => { cleanup(); useAgentStore.setState({ agents: [] }) })

  it('follows the shared list: a rename shows at once and a deleted choice falls back', async () => {
    useAgentStore.setState({ agents: [agent('a', 'Astra', true), agent('b', 'Fable')] })
    await act(async () => { render(<CommandInput onSendToCaptain={vi.fn()} onCreateTask={vi.fn()} />) })
    fireEvent.click(screen.getByTitle('Choose agent'))
    fireEvent.click(screen.getByRole('button', { name: 'Fable' }))
    act(() => useAgentStore.setState({ agents: [agent('a', 'Astra', true), agent('b', 'Fable 2')] }))
    expect(screen.getByTitle('Choose agent').textContent).toContain('Fable 2')
    act(() => useAgentStore.setState({ agents: [agent('a', 'Astra', true)] }))
    expect(screen.getByTitle('Choose agent').textContent).toContain('Astra')
  })

  it('says so when no agent remains, instead of keeping the deleted name', async () => {
    useAgentStore.setState({ agents: [agent('a', 'Astra', true)] })
    await act(async () => { render(<CommandInput onSendToCaptain={vi.fn()} onCreateTask={vi.fn()} />) })
    act(() => useAgentStore.setState({ agents: [] }))
    expect(screen.getByTitle('Choose agent').textContent).toContain('No agents')
  })
})
