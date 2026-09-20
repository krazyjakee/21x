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
    expect(useCommanderCallStore.getState().lastEvent).toEqual(event)
  })
})
