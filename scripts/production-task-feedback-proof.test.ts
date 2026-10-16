import { describe, expect, it } from 'vitest'
import { feedbackTitleIsBounded, TASK_FEEDBACK_EVENTS, TASK_FEEDBACK_FIXTURE } from './production-task-feedback-proof'

describe('task feedback proof fixture boundaries', () => {
  it('rejects blank, NUL, broken Unicode and byte-overflow notice titles', () => {
    expect(feedbackTitleIsBounded('🧪'.repeat(128))).toBe(true)
    expect(feedbackTitleIsBounded('🧪'.repeat(129))).toBe(false)
    expect(feedbackTitleIsBounded('\ud800')).toBe(false)
    expect(feedbackTitleIsBounded('\udc00')).toBe(false)
    expect(feedbackTitleIsBounded('unsafe\0title')).toBe(false)
    expect(feedbackTitleIsBounded(' \ufeff\t')).toBe(false)
    expect(feedbackTitleIsBounded('\u0085')).toBe(true)
  })
  it('keeps only the three agreed notice effects within finite fixture limits', () => {
    expect(TASK_FEEDBACK_EVENTS).toEqual(['agent:incompatible-session', 'task:checkpointAnswered', 'task:source-action-failed'])
    expect(TASK_FEEDBACK_FIXTURE.eventBytes).toBe(2048)
    expect(TASK_FEEDBACK_FIXTURE.titleBytes).toBe(512)
    expect(TASK_FEEDBACK_FIXTURE.maxRequests).toBe(64)
  })
})
