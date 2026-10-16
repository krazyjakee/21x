import { describe, expect, it } from 'vitest'
import { TASK_FEEDBACK_EVENT_CODECS, TASK_SOURCE_ACTION_ERROR } from './task-feedback-event-codecs'

describe('closed production checkpoint and source failure notices', () => {
  it('carries only an actual boolean checkpoint result and literal task identity', () => {
    const codec = TASK_FEEDBACK_EVENT_CODECS['task:checkpointAnswered']
    for (const approved of [true, false]) expect(codec.decodePayload(codec.encodePayload({ taskId: 'task-id', approved }))).toEqual({ taskId: 'task-id', approved })
    for (const value of [{ taskId: 'task-id', approved: 'true' }, { taskId: 'task-id', approved: true, sessionId: 'private' }, { taskId: '../foreign', approved: false }]) {
      expect(codec.validatePayload(value)).toBe(false); expect(() => codec.encodePayload(value)).toThrow()
    }
  })
  it('redacts private source errors and truncates the title at a UTF8 scalar boundary', () => {
    const codec = TASK_FEEDBACK_EVENT_CODECS['task:source-action-failed']
    const raw = { taskId: 'task-id', taskTitle: `${'é'.repeat(255)}😀tail`, error: 'private source credentials response /home/private' }
    const wire = codec.encodePayload(raw)
    expect(codec.decodePayload(wire)).toEqual({ taskId: raw.taskId, taskTitle: 'é'.repeat(255), error: TASK_SOURCE_ACTION_ERROR })
    expect(JSON.stringify(wire)).not.toContain('private'); expect(codec.validatePayload(raw)).toBe(false)
    expect(codec.validatePayload({ taskId: raw.taskId, taskTitle: '😀'.repeat(128), error: TASK_SOURCE_ACTION_ERROR })).toBe(true)
    expect(codec.validatePayload({ taskId: raw.taskId, taskTitle: '😀'.repeat(129), error: TASK_SOURCE_ACTION_ERROR })).toBe(false)
  })
  it('refuses unknown keys, invalid scalars, NUL titles and malformed source identities', () => {
    const codec = TASK_FEEDBACK_EVENT_CODECS['task:source-action-failed'], valid = { taskId: 'task-id', taskTitle: 'Useful task', error: TASK_SOURCE_ACTION_ERROR }
    for (const value of [{ ...valid, sourceId: 'not-in-wire' }, { ...valid, taskId: 'x'.repeat(129) }, { ...valid, taskTitle: 'bad\0title' }, { ...valid, taskTitle: '\ud800' }, { ...valid, taskTitle: ' ' }, { ...valid, error: {} }]) expect(() => codec.encodePayload(value)).toThrow()
    expect(codec.validatePayload({ ...valid, taskTitle: '\ud800' })).toBe(false)
    expect(() => codec.decodePayload({ ...valid, error: 'unredacted' })).toThrow()
  })
  it('projects control-escape titles to the exact final JSON budget without relaxing either wire cap', () => {
    const codec = TASK_FEEDBACK_EVENT_CODECS['task:source-action-failed']
    const source = { taskId: 'x'.repeat(128), taskTitle: `A${'\u0001'.repeat(511)}`, error: 'private raw source response' }
    const wire = codec.encodePayload(source), decoded = codec.decodePayload(wire)
    expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeLessThanOrEqual(2048)
    expect(new TextEncoder().encode(decoded.taskTitle).byteLength).toBeLessThanOrEqual(512)
    expect(source.taskTitle.startsWith(decoded.taskTitle)).toBe(true); expect(decoded.taskTitle).not.toBe(source.taskTitle)
    expect(decoded.error).toBe(TASK_SOURCE_ACTION_ERROR); expect(codec.validatePayload(wire)).toBe(true)
    expect(codec.validatePayload({ ...decoded, taskTitle: source.taskTitle })).toBe(false)
    expect(new TextEncoder().encode(JSON.stringify({ ...decoded, taskTitle: `${decoded.taskTitle}\u0001` })).byteLength).toBeGreaterThan(2048)
  })
})
