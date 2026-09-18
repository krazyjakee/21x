import { describe, it, expect } from 'vitest'
import { TaskStatus } from './constants'
import { isSuccessorGraphInProgress } from './subtask-graph'

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
