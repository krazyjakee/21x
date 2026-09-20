import { useRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  levelListener: null as ((level: number) => void) | null,
  unsubscribe: vi.fn(),
  ownsPlayback: true,
  reducedMotion: false,
  speaking: true,
  subscribeLevel: vi.fn((listener: (level: number) => void) => {
    mocks.levelListener = listener
    return mocks.unsubscribe
  })
}))

vi.mock('@/lib/voice-playback', () => ({
  voicePlayback: { subscribeLevel: mocks.subscribeLevel }
}))

vi.mock('./voice-activity-adapter', () => ({
  useVoicePlaybackOwnership: () => mocks.ownsPlayback,
  readVoiceActivitySnapshot: () => ({}),
  deriveVoiceActivity: () => ({ state: mocks.speaking ? 'speaking' : 'none' })
}))

vi.mock('./use-activity', () => ({
  useReducedMotion: () => mocks.reducedMotion
}))

import { speakingRingLevel, useSpeakingRing } from './use-speaking-ring'
import { useVoiceStore } from '@/stores/voice-store'

let renders = 0

function Ring() {
  renders += 1
  const ref = useRef<HTMLSpanElement>(null)
  useSpeakingRing(ref, { kind: 'commander', id: 'session-1' })
  return <span ref={ref} data-testid="ring" />
}

beforeEach(() => {
  mocks.levelListener = null
  mocks.ownsPlayback = true
  mocks.reducedMotion = false
  mocks.speaking = true
  renders = 0
  vi.clearAllMocks()
  useVoiceStore.setState({ level: 0.17 })
})

afterEach(cleanup)

describe('useSpeakingRing', () => {
  it('writes the CSS variable per frame without causing React/store-frequency renders', () => {
    render(<Ring />)
    expect(mocks.subscribeLevel).toHaveBeenCalledTimes(1)

    act(() => {
      mocks.levelListener?.(0.2)
      mocks.levelListener?.(0.55)
      mocks.levelListener?.(0.9)
    })

    expect(screen.getByTestId('ring').style.getPropertyValue('--speaking-level')).toBe('0.9')
    expect(renders).toBe(1)
    expect(useVoiceStore.getState().level).toBe(0.17)
  })

  it('uses fixed reduced-motion steps and cleans up the visible subscription', () => {
    mocks.reducedMotion = true
    const view = render(<Ring />)

    act(() => mocks.levelListener?.(0.45))
    const ring = screen.getByTestId('ring')
    expect(ring.dataset.speakingMotion).toBe('stepped')
    expect(Number(ring.style.getPropertyValue('--speaking-level'))).toBeCloseTo(2 / 3)

    view.unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not subscribe without verified playback ownership', () => {
    mocks.ownsPlayback = false
    render(<Ring />)
    expect(mocks.subscribeLevel).not.toHaveBeenCalled()
    expect(screen.getByTestId('ring').style.getPropertyValue('--speaking-level')).toBe('0')
  })

  it('clamps malformed levels before quantizing them', () => {
    expect(speakingRingLevel(Number.NaN, false)).toBe(0)
    expect(speakingRingLevel(-1, false)).toBe(0)
    expect(speakingRingLevel(2, false)).toBe(1)
    expect(new Set([0.01, 0.2, 0.45, 0.9].map((level) => speakingRingLevel(level, true)))).toEqual(
      new Set([0, 1 / 3, 2 / 3, 1])
    )
  })
})
