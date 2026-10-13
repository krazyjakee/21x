import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeAgent } from '../../test/helpers/task-fixtures'
import { CaptainWaker, type CaptainWakerAgents, type CaptainWakerOptions } from './captain-waker'
import { projectEvents, type ProjectEvent } from './project-events'

describe('Captain wake raw delivery ownership', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  const owners: CaptainWaker[] = []
  beforeEach(() => {
    source = createPortableDbFixture()
    source.db.createAgent(makeAgent({ is_default: true }))
  })
  afterEach(async () => {
    for (const owner of owners) await owner.close()
    owners.length = 0
    source.rawDb.close()
  })
  function fixture(sendMessage = vi.fn().mockResolvedValue({}), options: CaptainWakerOptions = {}) {
    const project = source.db.createProject({ name: 'Wake ownership' })!
    const owner = new CaptainWaker(source.db, {
      findSessionByTaskId: () => undefined, sendMessage
    } as unknown as CaptainWakerAgents, { debounceMs: 60_000, ...options })
    owners.push(owner)
    const event: ProjectEvent = {
      kind: 'task_ready_for_review', projectId: project.id,
      taskId: 'fixture-task', title: 'Fixture completed', at: new Date().toISOString()
    }
    return { owner, project, event, sendMessage }
  }
  function held() {
    let finish!: () => void
    const promise = new Promise<void>(resolve => { finish = resolve })
    return { promise, finish }
  }

  it('retains an accepted delivery through failed close and joins its late SQLite write', async () => {
    const gate = held()
    const send = vi.fn(async () => {
      await gate.promise
      source.db.setSetting('captain_late_delivery', 'settled')
      return {}
    })
    const { owner, event, project } = fixture(send)
    owner.start()
    projectEvents.emitEvent(event)
    const delivery = owner.flush(project.id)
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('CAPTAIN_WAKER_SHUTDOWN_INCOMPLETE')
      let closed = false
      const retry = owner.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      const read = vi.spyOn(source.db, 'getProject')
      projectEvents.emitEvent(event)
      owner.handleEvent(event)
      await owner.flush(project.id)
      expect(read).not.toHaveBeenCalled()
      read.mockRestore()
      expect(() => owner.start()).toThrow('CAPTAIN_WAKER_CLOSED')
      gate.finish()
      await delivery
      await retry
      expect(source.db.getSetting('captain_late_delivery')).toBe('settled')
      expect(send).toHaveBeenCalledOnce()
    } finally { gate.finish(); await delivery }
  })

  it('cancels a queued send and ignores a stale timer callback before host invocation', async () => {
    const callbacks: Array<() => void> = []
    const clearTimer = vi.fn()
    const { owner, event, project, sendMessage } = fixture(undefined, {
      setTimer: fn => { callbacks.push(fn); return fn }, clearTimer
    })
    owner.handleEvent(event)
    const delivery = owner.flush(project.id)
    owner.shutdown()
    await owner.close()
    await delivery
    const read = vi.spyOn(source.db, 'getProject')
    expect(clearTimer).toHaveBeenCalledOnce()
    callbacks[0]()
    await owner.flush(project.id)
    owner.handleEvent(event)
    expect(read).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    read.mockRestore()
  })

  it('joins every project delivery rather than returning after the first settles', async () => {
    const first = held(), second = held()
    const send = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const { owner, event, project } = fixture(send)
    const another = source.db.createProject({ name: 'Second' })!
    owner.handleEvent(event)
    owner.handleEvent({ ...event, projectId: another.id })
    const deliveries = Promise.all([owner.flush(project.id), owner.flush(another.id)])
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
      let closed = false
      const close = owner.close().then(() => { closed = true })
      first.finish()
      await Promise.resolve()
      await Promise.resolve()
      expect(closed).toBe(false)
      second.finish()
      await deliveries
      await close
    } finally { first.finish(); second.finish(); await deliveries }
  })

  it('retains reusable stop/start and validates deadlines before final shutdown', async () => {
    const { owner, event, project, sendMessage } = fixture()
    owner.start()
    owner.stop()
    owner.start()
    await expect(owner.close(0)).rejects.toBeInstanceOf(RangeError)
    projectEvents.emitEvent(event)
    await owner.flush(project.id)
    expect(sendMessage).toHaveBeenCalledOnce()
    await owner.close()
    expect(() => owner.start()).toThrow('CAPTAIN_WAKER_CLOSED')
  })

  it('joins a rejected raw send and leaves its rejection handled', async () => {
    const gate = held()
    const send = vi.fn(async () => { await gate.promise; throw new Error('Fixture send failure') })
    const { owner, event, project } = fixture(send)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    owner.handleEvent(event)
    const delivery = owner.flush(project.id)
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      const close = owner.close()
      gate.finish()
      await delivery
      await close
      expect(error).toHaveBeenCalledOnce()
    } finally { gate.finish(); await delivery; error.mockRestore() }
  })
})
