import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setActivityTimeSource } from '@/lib/activity/activity-clock'
import {
  __resetCommanderCall,
  bindCommanderCallDriver,
  onCallMediaEvent,
  useCommanderCallStore,
  type CommanderCallDriver
} from './commander-call-store'

function fakeDriver(openMicrophone: () => Promise<string> = async () => 'mic-1'): CommanderCallDriver {
  return {
    setActive: vi.fn(async () => undefined),
    openMicrophone: vi.fn(openMicrophone),
    closeMicrophone: vi.fn(),
    stopPlayback: vi.fn(),
    bargeIn: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined)
  }
}

beforeEach(() => {
  __resetCommanderCall()
  __setActivityTimeSource(() => 500)
})

afterEach(() => {
  useCommanderCallStore.getState().end()
  __resetCommanderCall()
  __setActivityTimeSource(null)
})

describe('Commander call lifetime', () => {
  it('starts once, becomes live, and ignores a duplicate start for the same session', async () => {
    const driver = fakeDriver()
    bindCommanderCallDriver(driver)

    await useCommanderCallStore.getState().start('session-1')
    expect(useCommanderCallStore.getState()).toMatchObject({
      status: 'live', sessionId: 'session-1', turnId: 'mic-1', error: null
    })
    expect(driver.setActive).toHaveBeenCalledWith('session-1')
    expect(driver.openMicrophone).toHaveBeenCalledTimes(1)

    await useCommanderCallStore.getState().start('session-1')
    expect(driver.openMicrophone).toHaveBeenCalledTimes(1)
  })

  it('End from a live call closes mic/playback/synthesis/turn and returns off', async () => {
    const driver = fakeDriver()
    bindCommanderCallDriver(driver)
    await useCommanderCallStore.getState().start('session-1')

    useCommanderCallStore.getState().end()

    expect(useCommanderCallStore.getState()).toMatchObject({ status: 'off', sessionId: null, turnId: null, error: null })
    expect(driver.closeMicrophone).toHaveBeenCalledWith('mic-1')
    expect(driver.stopPlayback).toHaveBeenCalled()
    expect(driver.bargeIn).toHaveBeenCalledWith('session-1')
    expect(driver.setActive).toHaveBeenLastCalledWith(null)
  })

  it('mutes and reopens the microphone without ending the call', async () => {
    const driver = fakeDriver()
    bindCommanderCallDriver(driver)
    await useCommanderCallStore.getState().start('session-1')

    await useCommanderCallStore.getState().toggleMicrophone()
    expect(useCommanderCallStore.getState()).toMatchObject({ status: 'live', sessionId: 'session-1', turnId: null })
    expect(driver.closeMicrophone).toHaveBeenCalledWith('mic-1')
    expect(driver.setActive).toHaveBeenCalledTimes(1)

    await useCommanderCallStore.getState().toggleMicrophone()
    expect(useCommanderCallStore.getState()).toMatchObject({ status: 'live', sessionId: 'session-1', turnId: 'mic-1' })
    expect(driver.openMicrophone).toHaveBeenCalledTimes(2)
    expect(driver.setActive).toHaveBeenCalledTimes(1)
  })

  it('retries a failed microphone unmute without reopening the call session', async () => {
    let attempts = 0
    const driver = fakeDriver(async () => {
      attempts++
      if (attempts === 2) throw new Error('Device is busy')
      return `mic-${attempts}`
    })
    bindCommanderCallDriver(driver)
    await useCommanderCallStore.getState().start('session-1')
    await useCommanderCallStore.getState().toggleMicrophone()
    await useCommanderCallStore.getState().toggleMicrophone()
    expect(useCommanderCallStore.getState()).toMatchObject({ status: 'live', turnId: null, error: 'Device is busy' })

    await useCommanderCallStore.getState().retry()
    expect(useCommanderCallStore.getState()).toMatchObject({ status: 'live', turnId: 'mic-3', error: null })
    expect(driver.setActive).toHaveBeenCalledTimes(1)
  })

  it('End during start prevents a slow microphone from reviving the call', async () => {
    let resolve!: (turnId: string) => void
    const opened = new Promise<string>((done) => { resolve = done })
    const driver = fakeDriver(() => opened)
    bindCommanderCallDriver(driver)

    const starting = useCommanderCallStore.getState().start('session-1')
    await vi.waitFor(() => expect(useCommanderCallStore.getState().status).toBe('starting'))
    useCommanderCallStore.getState().end()
    resolve('late-mic')
    await starting

    expect(useCommanderCallStore.getState().status).toBe('off')
    expect(driver.closeMicrophone).toHaveBeenCalledWith('late-mic')
  })

  it('closes a late unmute through its original driver after unmount and replacement', async () => {
    let resolve!: (turnId: string) => void
    const first = fakeDriver()
    bindCommanderCallDriver(first)
    await useCommanderCallStore.getState().start('session-1')
    await useCommanderCallStore.getState().toggleMicrophone()
    ;(first.openMicrophone as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>((done) => { resolve = done })
    )

    const pending = useCommanderCallStore.getState().toggleMicrophone()
    const unbind = bindCommanderCallDriver(first)
    unbind()
    const replacement = fakeDriver()
    bindCommanderCallDriver(replacement)
    await useCommanderCallStore.getState().start('session-2')
    resolve('late-original-mic')
    await pending

    expect(first.closeMicrophone).toHaveBeenCalledWith('late-original-mic')
    expect(replacement.closeMicrophone).not.toHaveBeenCalledWith('late-original-mic')
    expect(useCommanderCallStore.getState()).toMatchObject({ sessionId: 'session-2', turnId: 'mic-1' })
  })

  it('serializes rapid unmute attempts into one media acquisition', async () => {
    let resolve!: (turnId: string) => void
    const driver = fakeDriver()
    bindCommanderCallDriver(driver)
    await useCommanderCallStore.getState().start('session-1')
    await useCommanderCallStore.getState().toggleMicrophone()
    ;(driver.openMicrophone as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>((done) => { resolve = done })
    )

    const first = useCommanderCallStore.getState().toggleMicrophone()
    const second = useCommanderCallStore.getState().toggleMicrophone()
    expect(driver.openMicrophone).toHaveBeenCalledTimes(2)
    resolve('resumed-mic')
    await Promise.all([first, second])
    expect(useCommanderCallStore.getState().turnId).toBe('resumed-mic')
  })

  it('interrupts without ending, emits media events, and can accept another reply', async () => {
    const driver = fakeDriver()
    bindCommanderCallDriver(driver)
    await useCommanderCallStore.getState().start('session-1')
    const barge = vi.fn()
    const interrupted = vi.fn()
    onCallMediaEvent('barge_in', barge)
    onCallMediaEvent('interrupted', interrupted)

    useCommanderCallStore.getState().interrupt('barge_in')

    expect(useCommanderCallStore.getState()).toMatchObject({
      status: 'live', interruptedAt: 500, replyInterrupted: true
    })
    expect(driver.stopPlayback).toHaveBeenCalled()
    expect(driver.bargeIn).toHaveBeenCalledWith('session-1')
    expect(barge).toHaveBeenCalledTimes(1)
    expect(interrupted).toHaveBeenCalledTimes(1)

    useCommanderCallStore.getState().sendTranscript(' next request ')
    await vi.waitFor(() => expect(driver.send).toHaveBeenCalledWith('session-1', 'next request'))
    await vi.waitFor(() => expect(useCommanderCallStore.getState().replyInterrupted).toBe(false))
  })

  it('turns failed start and lost media into retryable errors', async () => {
    const first = fakeDriver(async () => { throw new Error('No microphone') })
    bindCommanderCallDriver(first)
    await useCommanderCallStore.getState().start('session-1')
    expect(useCommanderCallStore.getState()).toMatchObject({
      status: 'off', error: 'No microphone', retrySessionId: 'session-1'
    })

    const second = fakeDriver()
    bindCommanderCallDriver(second)
    await useCommanderCallStore.getState().retry()
    expect(useCommanderCallStore.getState().status).toBe('live')

    useCommanderCallStore.getState().mediaLost('Device disconnected')
    expect(useCommanderCallStore.getState()).toMatchObject({
      status: 'off', error: 'Device disconnected', retrySessionId: 'session-1'
    })
  })

  it('records action/report events only for the live call session', async () => {
    bindCommanderCallDriver(fakeDriver())
    await useCommanderCallStore.getState().start('session-1')
    const event = {
      kind: 'report' as const,
      at: 500,
      sessionId: 'session-1',
      messageId: 'message-1',
      projectId: 'project-1'
    }
    useCommanderCallStore.getState().recordEvent({ ...event, sessionId: 'other' })
    expect(useCommanderCallStore.getState().lastEvent).toBeNull()
    useCommanderCallStore.getState().recordEvent(event)
    expect(useCommanderCallStore.getState().lastEvent).toMatchObject(event)
    expect(useCommanderCallStore.getState().lastEvent?.generation).toEqual(expect.any(Number))
  })

  it('gives replacement events a distinct identity even when provider IDs and time repeat', async () => {
    bindCommanderCallDriver(fakeDriver())
    await useCommanderCallStore.getState().start('session-1')
    const event = {
      kind: 'action' as const,
      at: 500,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'reused',
      toolName: 'archive_project'
    }
    useCommanderCallStore.getState().recordEvent(event)
    const first = useCommanderCallStore.getState().lastEvent!
    useCommanderCallStore.getState().recordEvent(event)
    const replacement = useCommanderCallStore.getState().lastEvent!

    useCommanderCallStore.getState().clearEvent(first)
    expect(useCommanderCallStore.getState().lastEvent).toEqual(replacement)
    expect(replacement.generation).not.toBe(first.generation)
  })
})
