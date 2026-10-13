import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeAgent } from '../../test/helpers/task-fixtures'
import type { ChatProvider, ChatProviderEvent } from './chat/providers/types'
import { ScheduledCoordination, type ScheduledCoordinationOptions } from './scheduled-coordination-core'
import { SCHEDULED_REVIEW_SETTING } from '../shared/scheduled-coordination'

describe('scheduled coordination raw work ownership', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  const owners: ScheduledCoordination[] = []
  beforeEach(() => {
    source = createPortableDbFixture()
    source.db.createAgent(makeAgent({ is_default: true }))
  })
  afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.close()
    vi.restoreAllMocks()
    source.rawDb.close()
  })
  function fixture(extra: Partial<ScheduledCoordinationOptions> = {}) {
    const owner = new ScheduledCoordination({ db: source.db, agents: null, notify: vi.fn(), ...extra })
    owners.push(owner)
    return owner
  }
  function held() {
    let finish!: () => void
    const promise = new Promise<void>(resolve => { finish = resolve })
    return { promise, finish }
  }

  it('aborts a summary but retains its ignored cancellation until raw completion, without storing a late briefing', async () => {
    const gate = held()
    let signal: AbortSignal | undefined
    const provider: ChatProvider = {
      id: 'fixture', model: 'fixture',
      stream: async function* (_request, received): AsyncGenerator<ChatProviderEvent> {
        signal = received
        await gate.promise
        yield { type: 'text_delta', text: 'Late fixture summary' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      }
    }
    const notify = vi.fn()
    const owner = fixture({ createProvider: () => provider, notify })
    const briefing = owner.runBriefingNow()
    try {
      await vi.waitFor(() => expect(signal).toBeDefined())
      await expect(owner.close(5)).rejects.toThrow('SCHEDULED_COORDINATION_SHUTDOWN_INCOMPLETE')
      expect(signal!.aborted).toBe(true)
      const sql = vi.spyOn(source.rawDb, 'prepare')
      let closed = false
      const retry = owner.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      gate.finish()
      expect(await briefing).toBeNull()
      await retry
      expect(sql).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
      sql.mockRestore()
      expect(() => owner.collectBriefing()).toThrow('SCHEDULED_COORDINATION_CLOSED')
      await expect(owner.runBriefingNow()).rejects.toThrow('SCHEDULED_COORDINATION_CLOSED')
      expect(() => owner.start()).toThrow('SCHEDULED_COORDINATION_CLOSED')
    } finally { gate.finish(); await briefing }
  })

  it('joins raw notification work and skips speech after shutdown', async () => {
    const gate = held()
    const notify = vi.fn(async () => {
      await gate.promise
      source.db.setSetting('fixture_notification_settled', 'yes')
    })
    const speak = vi.fn().mockResolvedValue(true)
    const owner = fixture({ notify, getSpeech: () => ({ speak }), canPlayAudio: () => true })
    const briefing = owner.runBriefingNow({ speak: true })
    try {
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('SCHEDULED_COORDINATION_SHUTDOWN_INCOMPLETE')
      const close = owner.close()
      gate.finish()
      expect((await briefing)?.spoken).toBe(false)
      await close
      expect(source.db.getSetting('fixture_notification_settled')).toBe('yes')
      expect(speak).not.toHaveBeenCalled()
    } finally { gate.finish(); await briefing }
  })

  it('joins an accepted speech operation through failed close and late completion', async () => {
    const gate = held()
    const speak = vi.fn(async () => { await gate.promise; return true })
    const owner = fixture({ getSpeech: () => ({ speak }), canPlayAudio: () => true })
    const briefing = owner.runBriefingNow({ speak: true })
    try {
      await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('SCHEDULED_COORDINATION_SHUTDOWN_INCOMPLETE')
      const retry = owner.close()
      gate.finish()
      expect((await briefing)?.spoken).toBe(true)
      await retry
    } finally { gate.finish(); await briefing }
  })

  it('coalesces ticks, joins the current review, and skips the next project and briefing reads', async () => {
    let now = Date.parse('2026-10-13T09:00:00Z')
    for (const name of ['First', 'Second']) {
      source.db.createProject({ name, settings: { [SCHEDULED_REVIEW_SETTING]: { enabled: true, cron: '* * * * *' } } })
    }
    const gate = held()
    const send = vi.fn(async () => { await gate.promise; return {} })
    const owner = fixture({ now: () => now, timezone: 'UTC', agents: { findSessionByTaskId: () => undefined, sendMessage: send } as never })
    await owner.tick()
    now += 60_000
    const first = owner.tick(), second = owner.tick()
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      await expect(owner.close(5)).rejects.toThrow('SCHEDULED_COORDINATION_SHUTDOWN_INCOMPLETE')
      const sql = vi.spyOn(source.rawDb, 'prepare')
      const retry = owner.close()
      gate.finish()
      await Promise.all([first, second, retry])
      expect(send).toHaveBeenCalledOnce()
      expect(sql).not.toHaveBeenCalled()
      sql.mockRestore()
    } finally { gate.finish(); await Promise.all([first, second]) }
  })

  it('cancels queued tick and briefing work before reading SQLite', async () => {
    const owner = fixture()
    const sql = vi.spyOn(source.rawDb, 'prepare')
    const tick = owner.tick(), briefing = owner.runBriefingNow()
    owner.shutdown()
    await owner.close()
    await tick
    expect(await briefing).toBeNull()
    expect(sql).not.toHaveBeenCalled()
    sql.mockRestore()
  })

  it('validates close deadlines before ending admission', async () => {
    const owner = fixture()
    await expect(owner.close(0)).rejects.toBeInstanceOf(RangeError)
    expect(await owner.runBriefingNow()).not.toBeNull()
  })
})
