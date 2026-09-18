import { describe, it, expect } from 'vitest'
import { TaskStatus } from './constants'
import { findBlockingSibling, isSiblingBlocking, isSuccessorGraphInProgress, successorsFireOnReview } from './subtask-graph'

describe('isSuccessorGraphInProgress', () => {
  it('is false when no subtask has successor edges', () => {
    expect(isSuccessorGraphInProgress([
      { status: TaskStatus.Completed, next_subtask_ids: [] },
      { status: TaskStatus.NotStarted }
    ])).toBe(false)
  })

  it('is false before any subtask has started, so list order picks the first one', () => {
    expect(isSuccessorGraphInProgress([
      { status: TaskStatus.NotStarted, next_subtask_ids: ['b'] },
      { status: TaskStatus.NotStarted, next_subtask_ids: [] }
    ])).toBe(false)
  })

  it('is true once edges exist and the run has begun', () => {
    expect(isSuccessorGraphInProgress([
      { status: TaskStatus.AgentWorking, next_subtask_ids: ['b'] },
      { status: TaskStatus.NotStarted, next_subtask_ids: [] }
    ])).toBe(true)
  })
})

describe('isSiblingBlocking', () => {
  it('blocks only on a genuinely running sibling', () => {
    expect(isSiblingBlocking({ status: TaskStatus.AgentWorking })).toBe(true)
    expect(isSiblingBlocking({ status: TaskStatus.Triaging })).toBe(true)
    expect(isSiblingBlocking({ status: TaskStatus.AgentLearning })).toBe(true)
  })

  it('does not block on ready_for_review, so unattended chains keep moving', () => {
    expect(isSiblingBlocking({ status: TaskStatus.ReadyForReview })).toBe(false)
  })

  it('does not block on not_started or completed', () => {
    expect(isSiblingBlocking({ status: TaskStatus.NotStarted })).toBe(false)
    expect(isSiblingBlocking({ status: TaskStatus.Completed })).toBe(false)
  })
})

describe('findBlockingSibling', () => {
  it('returns the running sibling and skips ones in review', () => {
    const running = { id: 'b', status: TaskStatus.AgentWorking }
    expect(findBlockingSibling([{ id: 'a', status: TaskStatus.ReadyForReview }, running])).toBe(running)
  })

  it('returns undefined when every sibling is finished or waiting', () => {
    expect(findBlockingSibling([
      { status: TaskStatus.ReadyForReview },
      { status: TaskStatus.Completed },
      { status: TaskStatus.NotStarted }
    ])).toBeUndefined()
  })
})

describe('successorsFireOnReview', () => {
  it('is off by default, so a human review advances the chain', () => {
    expect(successorsFireOnReview({}, {})).toBe(false)
    expect(successorsFireOnReview(undefined, undefined)).toBe(false)
  })

  it('is on when the parent runs unattended', () => {
    expect(successorsFireOnReview({ auto_start_agent: true }, {})).toBe(true)
    expect(successorsFireOnReview({ auto_complete_without_review: true }, {})).toBe(true)
  })

  it('is on when the chain carries auto_complete_without_review', () => {
    expect(successorsFireOnReview({}, { auto_complete_without_review: true })).toBe(true)
  })
})
