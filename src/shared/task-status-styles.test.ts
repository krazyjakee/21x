import { describe, it, expect } from 'vitest'
import { TaskStatus, TASK_STATUSES } from './constants'
import {
  TASK_STATUS_STYLES,
  taskListDotClass,
  taskStatusDotClass,
  taskStatusStyle
} from './task-status-styles'

describe('TASK_STATUS_STYLES', () => {
  it('covers every task status with the canonical label', () => {
    for (const { value, label } of TASK_STATUSES) {
      expect(TASK_STATUS_STYLES[value]).toBeDefined()
      expect(TASK_STATUS_STYLES[value].label).toBe(label)
    }
  })

  it('only uses colours that are remapped for light mode', () => {
    // `styles/globals.css` darkens the *-400 shades in light mode; anything
    // else must be a semantic token, or the label goes invisible on paper.
    for (const style of Object.values(TASK_STATUS_STYLES)) {
      for (const cls of [style.text, style.dot]) {
        expect(cls).toMatch(/^(text|bg)-(muted-foreground|foreground|[a-z]+-400)$/)
      }
    }
  })

  it('falls back to the Not Started style for unknown values', () => {
    expect(taskStatusStyle('nonsense')).toBe(TASK_STATUS_STYLES[TaskStatus.NotStarted])
  })
})

describe('taskStatusDotClass()', () => {
  it('pulses only while triaging', () => {
    expect(taskStatusDotClass(TaskStatus.Triaging)).toContain('animate-pulse')
    expect(taskStatusDotClass(TaskStatus.AgentWorking)).not.toContain('animate-pulse')
    expect(taskStatusDotClass(TaskStatus.Completed)).toBe('bg-emerald-400')
  })
})

describe('taskListDotClass()', () => {
  it('lets learning and triaging outrank a running session', () => {
    expect(taskListDotClass(TaskStatus.AgentLearning, true)).toBe('bg-blue-400 animate-pulse')
    expect(taskListDotClass(TaskStatus.Triaging, true)).toBe('bg-muted-foreground animate-pulse')
  })

  it('shows a working agent for any other status with a live session', () => {
    expect(taskListDotClass(TaskStatus.NotStarted, true)).toBe('bg-amber-400 animate-pulse')
    expect(taskListDotClass(TaskStatus.ReadyForReview, true)).toBe('bg-amber-400 animate-pulse')
  })

  it('falls back to the stored status without a session', () => {
    expect(taskListDotClass(TaskStatus.NotStarted)).toBe('bg-muted-foreground')
    expect(taskListDotClass(TaskStatus.ReadyForReview)).toBe('bg-pink-400')
    expect(taskListDotClass(TaskStatus.Completed, false)).toBe('bg-emerald-400')
  })
})
