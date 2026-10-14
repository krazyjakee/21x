import { describe, expect, it } from 'vitest'
import { HOST_OPERATION_SCHEMAS } from './host-services'

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
