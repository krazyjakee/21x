import { beforeEach, describe, expect, it } from 'vitest'
import { boardColumnKey, sortBoardColumn } from './board-order'
import { useBoardOrderStore } from '@/stores/board-order-store'
import type { Task } from '@/types'

const task = (id: string, created_at: string, last_activity_at?: string): Task => ({ id, created_at, last_activity_at } as Task)
const ids = (tasks: Task[]): string[] => tasks.map((t) => t.id)
const older = '2026-01-01T00:00:00.000Z'
const newer = '2026-01-02T00:00:00.000Z'
beforeEach(() => useBoardOrderStore.setState({ orders: {} }))

describe('board ordering', () => {
  it('sorts activity descending, then creation descending, then ID ascending without mutation', () => {
    const tasks = [task('z', newer, newer), task('b', older, newer), task('a', older, newer), task('quiet', older), task('active', older, '2026-01-03T00:00:00.000Z')]
    expect(ids(sortBoardColumn(tasks))).toEqual(['active', 'z', 'a', 'b', 'quiet'])
    expect(ids(tasks)).toEqual(['z', 'b', 'a', 'quiet', 'active'])
    expect(ids(sortBoardColumn([...tasks].reverse()))).toEqual(ids(sortBoardColumn(tasks)))
  })

  it('uses creation for legacy tasks, with no updated_at or priority influence', () => {
    expect(ids(sortBoardColumn([
      { ...task('quiet', older), updated_at: newer, priority: 'critical' },
      { ...task('new', newer), priority: 'low' }
    ]))).toEqual(['new', 'quiet'])
  })

  it('persists manual precedence only for its project and column, and resets to activity', async () => {
    const tasks = [task('new', newer), task('old', older), task('unranked', older)]
    useBoardOrderStore.getState().setColumnOrder('project', 'not_started', ['gone', 'old', 'new'])
    const getOrder = (project = 'project', status = 'not_started'): string[] | undefined =>
      useBoardOrderStore.getState().orders[boardColumnKey(project, status)]
    expect(ids(sortBoardColumn(tasks, getOrder()))).toEqual(['old', 'new', 'unranked'])
    expect(ids(sortBoardColumn(tasks, getOrder('other')))).toEqual(['new', 'old', 'unranked'])
    expect(ids(sortBoardColumn(tasks, getOrder('project', 'agent_working')))).toEqual(['new', 'old', 'unranked'])
    await useBoardOrderStore.persist.rehydrate()
    expect(getOrder()).toEqual(['gone', 'old', 'new'])
    useBoardOrderStore.getState().resetColumnOrder('project', 'not_started')
    expect(getOrder()).toBeUndefined()
    expect(ids(sortBoardColumn(tasks, getOrder()))).toEqual(['new', 'old', 'unranked'])
    await useBoardOrderStore.persist.rehydrate()
    expect(getOrder()).toBeUndefined()
  })
})
