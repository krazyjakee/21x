import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_STATES,
  describeActivityQueueReason,
  isAgentStatusHeartbeat,
  isRunningActivity,
  readAgentStatusActivityMeta
} from './activity'

describe('shared activity contract', () => {
  it('has eleven states and only running/thinking/tool count as running', () => {
    expect(ACTIVITY_STATES).toHaveLength(11)
    expect(ACTIVITY_STATES.filter(isRunningActivity)).toEqual(['running', 'thinking', 'tool'])
  })

  it('validates observation metadata at runtime', () => {
    expect(readAgentStatusActivityMeta({ epoch: 'E', seq: 3 })).toEqual({ epoch: 'E', seq: 3 })
    expect(readAgentStatusActivityMeta({ epoch: 'E', seq: 3, heartbeat: true })).toEqual({ epoch: 'E', seq: 3, heartbeat: true })
    expect(readAgentStatusActivityMeta({ epoch: '', seq: 3 })).toBeNull()
    expect(readAgentStatusActivityMeta({ epoch: 'E', seq: 'x' })).toBeNull()
    expect(readAgentStatusActivityMeta({ taskId: 't', status: 'idle' })).toBeNull()
    expect(readAgentStatusActivityMeta(null)).toBeNull()
  })

  it('recognises heartbeats', () => {
    expect(isAgentStatusHeartbeat({ heartbeat: true })).toBe(true)
    expect(isAgentStatusHeartbeat({ heartbeat: 'yes' })).toBe(false)
    expect(isAgentStatusHeartbeat(undefined)).toBe(false)
  })

  it('describes unknown queue reasons generically', () => {
    expect(describeActivityQueueReason('nope')).toBe('waiting for a free slot')
    expect(describeActivityQueueReason(undefined)).toBe('waiting for a free slot')
  })
})
