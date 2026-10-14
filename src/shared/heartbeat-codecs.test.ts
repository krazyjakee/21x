import { describe, expect, it } from 'vitest'
import { HEARTBEAT_CODECS, HEARTBEAT_EVENT_CODECS, HEARTBEAT_LIMITS, HEARTBEAT_OPERATIONS } from './heartbeat-codecs'

describe('finite heartbeat controls and public events', () => {
  it('retains all eight exact positional argument contracts', () => {
    const cases = {
      'heartbeat:enable': [['task_id'], ['task_id', 60]],
      'heartbeat:disable': [['task_id']], 'heartbeat:runNow': [['task_id']],
      'heartbeat:getLogs': [['task_id'], ['task_id', 20]], 'heartbeat:getStatus': [['task_id']],
      'heartbeat:updateInterval': [['task_id', 120]], 'heartbeat:readFile': [['task_id']],
      'heartbeat:writeFile': [['task_id', '\uFEFF# Checks\nCheck 🚀']]
    } as const
    expect(HEARTBEAT_OPERATIONS).toHaveLength(8)
    for (const operation of HEARTBEAT_OPERATIONS) {
      const codec = HEARTBEAT_CODECS[operation]
      for (const args of cases[operation]) {
        const wire = codec.encodeArguments(args as never)
        const decoded = codec.decodeArguments(wire)
        expect(decoded.filter(value => value !== undefined)).toEqual(args)
        expect(codec.validateArguments(decoded)).toBe(true)
      }
      expect(() => codec.decodeArguments({ taskId: 'task_id', authority: 'all' })).toThrow('Invalid operation arguments.')
    }
  })
  it('refuses unbounded/fractional intervals, log counts, paths and malformed text before effect', () => {
    for (const interval of [0, -1, .5, Infinity, NaN, HEARTBEAT_LIMITS.intervalMinutes + 1, '60']) expect(HEARTBEAT_CODECS['heartbeat:enable'].validateArguments(['task_id', interval])).toBe(false)
    for (const limit of [0, -1, 129, .5, '20']) expect(HEARTBEAT_CODECS['heartbeat:getLogs'].validateArguments(['task_id', limit])).toBe(false)
    for (const id of ['../task', 'task/file', '', 'x'.repeat(129)]) expect(HEARTBEAT_CODECS['heartbeat:readFile'].validateArguments([id])).toBe(false)
    for (const body of ['\0', '\ud800', 'é'.repeat(65537)]) expect(HEARTBEAT_CODECS['heartbeat:writeFile'].validateArguments(['task', body])).toBe(false)
    expect(HEARTBEAT_CODECS['heartbeat:writeFile'].validateArguments(['task', '\uFEFFé'.repeat(10)])).toBe(true)
  })
  it('preserves null/undefined/false distinctions and finite status strings', () => {
    expect(HEARTBEAT_CODECS['heartbeat:readFile'].encodeResult(null)).toEqual({ defined: true, value: null })
    expect(HEARTBEAT_CODECS['heartbeat:getStatus'].encodeResult(null)).toEqual({ defined: true, value: null })
    expect(HEARTBEAT_CODECS['heartbeat:enable'].encodeResult(undefined)).toEqual({ defined: false })
    expect(HEARTBEAT_CODECS['heartbeat:writeFile'].encodeResult(false)).toEqual({ defined: true, value: false })
    for (const status of ['sent', 'no_file', 'no_agent', 'in_progress', 'error']) expect(HEARTBEAT_CODECS['heartbeat:runNow'].encodeResult(status)).toEqual({ defined: true, value: status })
    expect(() => HEARTBEAT_CODECS['heartbeat:runNow'].encodeResult('queued')).toThrow('Invalid operation result.')
    expect(HEARTBEAT_CODECS['heartbeat:readFile'].validateWireResult({ defined: false })).toBe(false)
    expect(HEARTBEAT_CODECS['heartbeat:enable'].validateWireResult({ defined: false, value: null })).toBe(false)
  })
  it('exports meaningful human logs and fixes private failure diagnostics', () => {
    const log = { id: 'log_id', task_id: 'task_id', status: 'info', summary: 'Review passed; no requested changes remain.', session_id: null, created_at: '2026-01-01T00:00:00Z' }
    expect(HEARTBEAT_CODECS['heartbeat:getLogs'].encodeResult([log])).toEqual({ defined: true, value: [log] })
    const failure = { ...log, status: 'error', summary: 'private command/token/provider traceback' }
    expect(HEARTBEAT_CODECS['heartbeat:getLogs'].encodeResult([failure])).toEqual({ defined: true, value: [{ ...failure, summary: 'Heartbeat check failed.' }] })
    expect(() => HEARTBEAT_CODECS['heartbeat:getLogs'].encodeResult([{ ...log, nonce: 'private' }])).toThrow('Invalid operation result.')
    expect(() => HEARTBEAT_CODECS['heartbeat:getLogs'].encodeResult([{ ...log, summary: undefined }])).toThrow('Invalid operation result.')
  })
  it('validates exact alert/disabled metadata and roundtrips genuine human summaries', () => {
    const alert = { taskId: 'task_id', title: 'Review the launch', summary: 'The CI job failed after the change 🚀' }
    expect(HEARTBEAT_EVENT_CODECS['heartbeat:alert'].decodePayload(HEARTBEAT_EVENT_CODECS['heartbeat:alert'].encodePayload(alert))).toEqual(alert)
    const disabled = { taskId: 'task_id', reason: '3 consecutive errors' }
    expect(HEARTBEAT_EVENT_CODECS['heartbeat:disabled'].encodePayload(disabled)).toEqual(disabled)
    expect(HEARTBEAT_EVENT_CODECS['heartbeat:alert'].validatePayload({ ...alert, summary: 'x'.repeat(501) })).toBe(false)
    expect(HEARTBEAT_EVENT_CODECS['heartbeat:alert'].validatePayload({ ...alert, summary: '\ud83d' })).toBe(false)
    expect(() => HEARTBEAT_EVENT_CODECS['heartbeat:disabled'].decodePayload({ ...disabled, token: 'private' })).toThrow('Invalid operation result.')
  })
})
