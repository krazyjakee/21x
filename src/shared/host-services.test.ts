import { describe, expect, it } from 'vitest'
import { HOST_OPERATION_SCHEMAS } from './host-services'

it('keeps suspend demand and applied acknowledgement boolean-only without caller-selected native authority', () => {
  const schema = HOST_OPERATION_SCHEMAS['host.sleep.set']
  for (const enabled of [true, false]) { expect(schema.validateRequest({ enabled })).toBe(true); expect(schema.validateResult({ enabled })).toBe(true) }
  for (const value of [{}, { enabled: 'true' }, { enabled: true, flags: 8 }, { enabled: true, request: '/foreign' }, { enabled: true, reason: 'caller supplied' }, { enabled: true, pid: 123 }, { active: true }]) {
    expect(schema.validateRequest(value)).toBe(false); expect(schema.validateResult(value)).toBe(false)
  }
})

describe('private notification callback shapes', () => {
  it.each(['host.notification.show', 'host.notification.status'] as const)('keeps %s exact byte-bounded text and an explicit boolean acknowledgement', operation => {
    const schema = HOST_OPERATION_SCHEMAS[operation]
    expect(schema.validateRequest({ title: 'Agent finished', body: '"Human task" is ready for review' })).toBe(true)
    expect(schema.validateRequest({ title: 'x'.repeat(160), body: '' })).toBe(true)
    expect(schema.validateRequest({ title: '🌱'.repeat(40), body: '🌱'.repeat(512) })).toBe(true)
    expect(schema.validateRequest({ title: '🌱'.repeat(41), body: '' })).toBe(false)
    expect(schema.validateRequest({ title: 'Agent finished', body: '🌱'.repeat(513) })).toBe(false)
    for (const payload of [{ title: '', body: '' }, { title: '\ud800', body: '' }, { title: 'safe', body: '\udc00' }, { title: 'bad\n', body: '' }, { title: 'safe', body: 'bad\0' }, { title: 'safe', body: 'bad\u007f' }, { title: 'safe', body: '', onClick: 'arbitrary action' }, { title: 'safe', body: '', only_when_inactive: false }, { title: 'safe', body: '', taskId: 'caller-selected' }]) expect(schema.validateRequest(payload)).toBe(false)
    expect(schema.validateRequest({ title: 'safe', body: 'Allowed\tline\r\n' })).toBe(true)
    for (const shown of [true, false]) expect(schema.validateResult({ shown })).toBe(true)
    for (const result of [undefined, null, {}, { shown: 1 }, { shown: 'true' }, { shown: true, action: 'arbitrary' }]) expect(schema.validateResult(result)).toBe(false)
  })
})
