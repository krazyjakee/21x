import { describe, expect, it } from 'vitest'
import { ActivityObservations, isKnownActivityDisconnect, shouldPublishHeartbeat } from './activity-observations'

describe('ActivityObservations', () => {
  it('distinguishes known transport loss from a generic temporary status failure', () => {
    expect(isKnownActivityDisconnect(Object.assign(new Error('Backend stopped'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isKnownActivityDisconnect(new Error('Client not found'))).toBe(true)
    expect(isKnownActivityDisconnect(new Error('Temporary service pressure'))).toBe(false)
  })
  it('stamps every push with the epoch and an increasing sequence', () => {
    const o = new ActivityObservations(() => 0, 5_000, 'E')
    expect(o.stamp()).toEqual({ epoch: 'E', seq: 1 })
    expect(o.stamp(true)).toEqual({ epoch: 'E', seq: 2, heartbeat: true })
  })

  it('rate-limits heartbeats per session to the revalidation interval', () => {
    let now = 0
    const o = new ActivityObservations(() => now, 5_000, 'E')
    expect(o.takeHeartbeat('s1')).toBe(true)
    now = 2_000
    expect(o.takeHeartbeat('s1')).toBe(false)
    expect(o.takeHeartbeat('s2')).toBe(true)
    now = 5_000
    expect(o.takeHeartbeat('s1')).toBe(true)
    o.forget('s1')
    o.forget('s2')
    expect(o.trackedSessions).toBe(0)
  })

  it('a fresh instance has a different epoch', () => {
    expect(new ActivityObservations().epoch).not.toBe(new ActivityObservations().epoch)
  })

  it('only active or waiting sessions publish heartbeats', () => {
    expect(shouldPublishHeartbeat('working')).toBe(true)
    expect(shouldPublishHeartbeat('waiting_approval')).toBe(true)
    expect(shouldPublishHeartbeat('idle')).toBe(false)
    expect(shouldPublishHeartbeat('error')).toBe(false)
  })
})
