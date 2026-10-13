import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import { RecurrenceSchedulerCore, type RecurrenceEventHost } from './recurrence-scheduler-core'

describe('portable recurrence ownership', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  const owners: RecurrenceSchedulerCore[] = []
  beforeEach(() => { source = createPortableDbFixture() })
  afterEach(async () => {
    for (const owner of owners) await owner.close()
    owners.length = 0
    vi.useRealTimers()
    vi.restoreAllMocks()
    source.rawDb.close()
  })
  function fixture(events?: RecurrenceEventHost) {
    const owner = new RecurrenceSchedulerCore(source.db, 'UTC', events)
    owners.push(owner)
    return owner
  }
  function due(projectId?: string) {
    const task = source.db.createTask(makeTask({
      title: 'Recurring fixture', is_recurring: true, recurrence_pattern: '0 9 * * *',
      ...(projectId ? { project_id: projectId } : {})
    }))!
    source.db.updateTask(task.id, { next_occurrence_at: new Date(Date.now() - 60_000).toISOString() })
    return task.id
  }
  const children = (id: string) => source.db.getTasks().filter(task => task.recurrence_parent_id === id)

  it('preserves project scope and publishes events only after template advancement', async () => {
    const project = source.db.createProject({ name: 'Other project' })!
    const templateId = due(project.id)
    const emit = vi.fn((channel, payload) => {
      if (channel === 'task:created') {
        expect(payload.task.project_id).toBe(project.id)
        expect(new Date(source.db.getTask(templateId)!.next_occurrence_at!).getTime()).toBeGreaterThan(Date.now())
        expect(source.rawDb.inTransaction).toBe(false)
      }
    })
    await fixture({ emit }).runNow()
    expect(children(templateId)).toHaveLength(1)
    expect(children(templateId)[0].project_id).toBe(project.id)
    expect(emit).toHaveBeenCalledWith('tasks:refresh')
  })

  it('coalesces repeated starts and callers into one timer and one occurrence', async () => {
    vi.useFakeTimers()
    const id = due()
    const owner = fixture()
    owner.start()
    owner.start()
    await Promise.all([owner.runNow(), owner.runNow()])
    expect(vi.getTimerCount()).toBe(1)
    expect(children(id)).toHaveLength(1)
    owner.stop()
    expect(vi.getTimerCount()).toBe(0)
    owner.start()
    await owner.runNow()
    expect(vi.getTimerCount()).toBe(1)
    expect(children(id)).toHaveLength(1)
  })

  it('cancels a queued pass before SQLite access and refuses source revival', async () => {
    due()
    const owner = fixture()
    const read = vi.spyOn(source.rawDb, 'prepare')
    const pass = owner.runNow()
    owner.shutdown()
    await owner.close()
    await pass
    expect(read).not.toHaveBeenCalled()
    await expect(owner.runNow()).rejects.toThrow('RECURRENCE_SCHEDULER_CLOSED')
    expect(() => owner.start()).toThrow('RECURRENCE_SCHEDULER_CLOSED')
    expect(() => owner.initializeRecurringTask('late')).toThrow('RECURRENCE_SCHEDULER_CLOSED')
  })

  it('finishes the accepted template and skips remaining templates and automation after shutdown', async () => {
    const first = due(), second = due()
    let close: Promise<void> | undefined
    const emit = vi.fn((channel) => {
      if (channel === 'task:created') close = owner.close()
    })
    const owner = fixture({ emit })
    const automate = vi.fn()
    owner.setOnInstancesCreated(automate)
    await owner.runNow()
    await close
    expect(children(first)).toHaveLength(1)
    expect(children(second)).toHaveLength(0)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(automate).not.toHaveBeenCalled()
  })

  it('rolls back the instance when template advancement fails, then retries once', async () => {
    const id = due()
    source.rawDb.exec("CREATE TRIGGER fixture_fail_advance BEFORE UPDATE OF last_occurrence_at ON tasks BEGIN SELECT RAISE(ABORT, 'fixture update rejected'); END")
    const emit = vi.fn()
    const owner = fixture({ emit })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await owner.runNow()
    expect(children(id)).toHaveLength(0)
    expect(emit.mock.calls.some(([channel]) => channel === 'task:created')).toBe(false)
    source.rawDb.exec('DROP TRIGGER fixture_fail_advance')
    await owner.runNow()
    await owner.runNow()
    expect(children(id)).toHaveLength(1)
  })

  it('does not duplicate committed work when the event host fails', async () => {
    const id = due()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const owner = fixture({ emit: () => { throw new Error('Fixture renderer unavailable') } })
    await owner.runNow()
    await owner.runNow()
    expect(children(id)).toHaveLength(1)
  })

  it('validates the final close deadline before changing admission', async () => {
    const id = due()
    const owner = fixture()
    await expect(owner.close(0)).rejects.toBeInstanceOf(RangeError)
    await owner.runNow()
    expect(children(id)).toHaveLength(1)
  })
})
