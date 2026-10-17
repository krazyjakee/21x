import { describe, expect, it } from 'vitest'
import { isNativeAttachmentDrop, isNativeAttachmentDropEvent, isNativeDropContext, validateNativeDropContext } from './native-attachment-drop'
const contextId = '11111111-1111-4111-8111-111111111111'
const dropId = '22222222-2222-4222-8222-222222222222'
const drop = { dropId, contextId, paths: ['/tmp/selected.txt'] }
describe('native-only attachment drop envelope', () => {
  it('accepts only a bounded display batch and opaque intent context', () => {
    expect(isNativeAttachmentDrop(drop)).toBe(true)
    expect(isNativeDropContext(null)).toBe(true)
    expect(isNativeDropContext(contextId)).toBe(true)
    for (const context of [undefined, {}, 'task-id', '/tmp/file', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) {
      expect(isNativeDropContext(context)).toBe(false)
      expect(() => validateNativeDropContext(context)).toThrow()
    }
    for (const value of [{ ...drop, taskId: 'chosen' }, { ...drop, accept: () => {} }, { ...drop, paths: [] },
      { ...drop, paths: Array(17).fill('/tmp/file') }, { ...drop, paths: ['/tmp/file', '/tmp/file'] },
      ...['/tmp/../secret', '/tmp//file', 'file:///tmp/file', '/tmp/file\n', '/tmp/\ud800', '/' + 'x'.repeat(4096)].map(path => ({ ...drop, paths: [path] }))]) {
      expect(isNativeAttachmentDrop(value)).toBe(false)
    }
  })
  it('requires an exact native epoch and physical document stamp without closures', () => {
    const event = { engineEpoch: 'engine-1', leaseId: 'ui_exact_drop_document', drop }
    expect(isNativeAttachmentDropEvent(event)).toBe(true)
    for (const value of [drop, { ...event, leaseId: '' }, { ...event, engineEpoch: 'foreign/epoch' },
      { ...event, owner: 'renderer' }, { ...event, drop: { ...drop, close: () => {} } }]) {
      expect(isNativeAttachmentDropEvent(value)).toBe(false)
    }
  })
})
