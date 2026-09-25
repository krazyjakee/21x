import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'
import type { ChatProvider, ChatProviderEvent } from './chat/providers/types'
import { CommanderStore } from './commander/commander-store'
import {
  BRIEFING_STATE_KEY,
  ScheduledCoordination,
  buildBriefingText,
  latestOccurrence,
  reviewStateKey,
  type ScheduledCoordinationOptions
} from './scheduled-coordination'
import {
  COMMANDER_BRIEFING_SETTING,
  DEFAULT_COMMANDER_BRIEFING,
  DEFAULT_SCHEDULED_REVIEW,
  SCHEDULED_REVIEW_SETTING,
  describeCron,
  isCronShape,
  parseCommanderBriefingSettings,
  readScheduledReviewSettings,
  serializeCommanderBriefingSettings
} from '../shared/scheduled-coordination'
import { SYSTEM_MESSAGE_MARKER } from '../shared/system-authority'

// Monday 21 September 2026. Schedules sit at midday UTC so the local date in
// the session title is the same day on any test machine within ±11h of UTC.
const MONDAY_1130 = Date.parse('2026-09-21T11:30:00.000Z')
const MINUTE = 60_000
const REVIEW_CRON = '0 12 * * 1-5'
const BRIEFING_CRON = '0 12 * * 1-5'

let db: DatabaseManager
let now: number
let agents: {
  findSessionByTaskId: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
}

function fakeProvider(text: string): ChatProvider {
  return {
    id: 'fake',
    model: 'fake-1',
    stream() {
      return (async function* (): AsyncGenerator<ChatProviderEvent> {
        yield { type: 'text_delta', text }
        yield { type: 'message_end', stopReason: 'end_turn' }
      })()
    }
  } as unknown as ChatProvider
}

function scheduler(extra: Partial<ScheduledCoordinationOptions> = {}): ScheduledCoordination {
  return new ScheduledCoordination({
    db,
    agents: agents as never,
    timezone: 'UTC',
    now: () => now,
    notify: vi.fn(),
    ...extra
  })
}

function project(name: string, settings: Record<string, unknown> = {}): string {
  return db.createProject({ name, settings })!.id
}

beforeEach(() => {
  db = createTestDb().db
  db.createAgent({ name: 'Claude', is_default: true, config: { coding_agent: 'claude-code' } as never })
  now = MONDAY_1130
  agents = {
    findSessionByTaskId: vi.fn(() => undefined),
    sendMessage: vi.fn(async () => ({}))
  }
})

describe('settings', () => {
  it('both schedules are off by default', () => {
    expect(DEFAULT_SCHEDULED_REVIEW.enabled).toBe(false)
    expect(DEFAULT_COMMANDER_BRIEFING.enabled).toBe(false)
    expect(readScheduledReviewSettings({})).toEqual(DEFAULT_SCHEDULED_REVIEW)
    expect(readScheduledReviewSettings({ [SCHEDULED_REVIEW_SETTING]: 'junk' })).toEqual(DEFAULT_SCHEDULED_REVIEW)
    expect(parseCommanderBriefingSettings(undefined)).toEqual(DEFAULT_COMMANDER_BRIEFING)
    expect(parseCommanderBriefingSettings('{not json')).toEqual(DEFAULT_COMMANDER_BRIEFING)
    const round = parseCommanderBriefingSettings(serializeCommanderBriefingSettings({ enabled: true, cron: ' 0 7 * * * ', speak: true }))
    expect(round).toEqual({ enabled: true, cron: '0 7 * * *', speak: true })
  })

  it('checks and describes cron expressions', () => {
    expect(isCronShape('0 9 * * 1-5')).toBe(true)
    expect(isCronShape('0 9 * *')).toBe(false)
    expect(isCronShape('every day')).toBe(false)
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00')
    expect(describeCron('30 8 * * *')).toBe('Every day at 08:30')
  })

  it('finds the latest occurrence at or before now', () => {
    expect(latestOccurrence(REVIEW_CRON, Date.parse('2026-09-21T12:00:30.000Z'), 'UTC')).toBe(Date.parse('2026-09-21T12:00:00.000Z'))
    expect(latestOccurrence('not a cron', MONDAY_1130, 'UTC')).toBeNull()
  })

  it('does nothing when nothing is switched on', async () => {
    project('Web')
    const s = scheduler()
    await s.tick()
    now += 2 * 60 * MINUTE
    await s.tick()
    expect(agents.sendMessage).not.toHaveBeenCalled()
    expect(new CommanderStore(db).listSessions()).toHaveLength(0)
  })
})

describe('scheduled Captain reviews', () => {
  it('wakes only enabled, unpaused projects, once per occurrence', async () => {
    const on = project('On', { [SCHEDULED_REVIEW_SETTING]: { enabled: true, cron: REVIEW_CRON } })
    project('Paused', { [SCHEDULED_REVIEW_SETTING]: { enabled: true, cron: REVIEW_CRON }, limits: { paused: true } })
    project('Off', { [SCHEDULED_REVIEW_SETTING]: { enabled: false, cron: REVIEW_CRON } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const s = scheduler()
    await s.tick() // 11:30: seeds the baselines, fires nothing
    expect(agents.sendMessage).not.toHaveBeenCalled()

    now = Date.parse('2026-09-21T12:00:30.000Z')
    await s.tick()
    await s.tick()
    now += MINUTE
    await s.tick()

    expect(agents.sendMessage).toHaveBeenCalledTimes(1)
    const [sessionId, message, taskId] = agents.sendMessage.mock.calls[0] as [string, string, string, string]
    expect(sessionId).toBe('')
    expect(taskId).toBe(db.getCoordinatorTask(on)!.id)
    expect(message).toContain(SYSTEM_MESSAGE_MARKER)
    expect(message).toContain('Scheduled review of "On"')
    expect(message).toContain('update_project_status')
    expect(log.mock.calls.some((call) => String(call[0]).includes('is paused'))).toBe(true)
    log.mockRestore()
  })

  it('does not fire again after a restart', async () => {
    const on = project('On', { [SCHEDULED_REVIEW_SETTING]: { enabled: true, cron: REVIEW_CRON } })
    await scheduler().tick()
    now = Date.parse('2026-09-21T12:00:30.000Z')
    await scheduler().tick()
    expect(agents.sendMessage).toHaveBeenCalledTimes(1)
    expect(db.getSetting(reviewStateKey(on))).toContain(REVIEW_CRON)

    // A fresh scheduler over the same database (the app restarted).
    now += 5 * MINUTE
    await scheduler().tick()
    expect(agents.sendMessage).toHaveBeenCalledTimes(1)

    // The next occurrence still fires.
    now = Date.parse('2026-09-22T12:00:10.000Z')
    await scheduler().tick()
    expect(agents.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('waits for a Captain that is mid-turn', async () => {
    project('Busy', { [SCHEDULED_REVIEW_SETTING]: { enabled: true, cron: REVIEW_CRON } })
    const s = scheduler()
    await s.tick()
    const agentId = db.getAgents()[0].id
    agents.findSessionByTaskId.mockReturnValue({ sessionId: 's-1', session: { status: 'working', agentId } })
    now = Date.parse('2026-09-21T12:00:30.000Z')
    await s.tick()
    expect(agents.sendMessage).not.toHaveBeenCalled()
    agents.findSessionByTaskId.mockReturnValue({ sessionId: 's-1', session: { status: 'idle', agentId } })
    now += MINUTE
    await s.tick()
    expect(agents.sendMessage).toHaveBeenCalledTimes(1)
    expect(agents.sendMessage.mock.calls[0][0]).toBe('s-1')
  })
})

describe('Commander briefing', () => {
  function enableBriefing(extra: Partial<{ speak: boolean; cron: string }> = {}): void {
    db.setSetting(COMMANDER_BRIEFING_SETTING, JSON.stringify({ enabled: true, cron: BRIEFING_CRON, speak: false, ...extra }))
  }

  it('runs with no renderer and leaves an unread session with the project summaries', async () => {
    const web = project('Web')
    db.setProjectStatusSummary(web, 'Launch page is in review.', ['Waiting on copy from marketing'])
    project('Api')
    enableBriefing()
    const notify = vi.fn()
    // No Commander service (no window has registered anything), no provider.
    const s = scheduler({ notify, getCommander: () => null })

    await s.tick() // seeds
    expect(new CommanderStore(db).listSessions()).toHaveLength(0)
    now = Date.parse('2026-09-21T12:00:20.000Z')
    await s.tick()
    await s.tick()

    const store = new CommanderStore(db)
    const sessions = store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('Briefing 2026-09-21')
    expect(sessions[0].unread_count).toBe(1)
    const messages = store.listMessages(sessions[0].id)
    expect(messages.map((m) => m.role)).toEqual(['report'])
    const text = messages[0].content
    expect(text).toContain('## Web')
    expect(text).toContain('Launch page is in review.')
    expect(text).toContain('- Waiting on copy from marketing')
    expect(text).toContain('## Api')
    expect(text).toContain('awaiting approval 0')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toBe('Briefing 2026-09-21')

    // A restart does not brief twice.
    await scheduler({ notify }).tick()
    expect(new CommanderStore(db).listSessions()).toHaveLength(1)
    expect(db.getSetting(BRIEFING_STATE_KEY)).toContain(BRIEFING_CRON)
  })

  it('adds the model summary when a provider is configured, and skips it when not', async () => {
    project('Web')
    const withModel = await scheduler({ createProvider: () => fakeProvider('Two things need you this morning.') }).runBriefingNow()
    expect(withModel?.summary).toBe('Two things need you this morning.')
    const store = new CommanderStore(db)
    expect(store.listMessages(withModel!.sessionId).map((m) => m.role)).toEqual(['report', 'assistant'])
    expect(store.getSession(withModel!.sessionId)!.unread_count).toBe(1)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const without = await scheduler({ createProvider: () => { throw new Error('No API key') } }).runBriefingNow()
    log.mockRestore()
    expect(without?.summary).toBeNull()
    expect(store.listMessages(without!.sessionId).map((m) => m.role)).toEqual(['report'])
  })

  it('speaks only when asked and a window can play it', async () => {
    project('Web')
    const speak = vi.fn(async () => true)
    const muted = await scheduler({ getSpeech: () => ({ speak }), canPlayAudio: () => false }).runBriefingNow({ speak: true })
    expect(muted?.spoken).toBe(false)
    const off = await scheduler({ getSpeech: () => ({ speak }), canPlayAudio: () => true }).runBriefingNow({ speak: false })
    expect(off?.spoken).toBe(false)
    expect(speak).not.toHaveBeenCalled()
    const spoken = await scheduler({ getSpeech: () => ({ speak }), canPlayAudio: () => true }).runBriefingNow({ speak: true })
    expect(spoken?.spoken).toBe(true)
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('builds the briefing from status records only, attention first', () => {
    const text = buildBriefingText(
      [
        { project: { id: 'a', name: 'Quiet' }, status: null, paused: false },
        {
          project: { id: 'b', name: 'Loud' },
          status: { project_id: 'b', counts: { running: 1, queued: 0, awaiting_review: 0, awaiting_approval: 2, blocked: 0 }, summary: 'Going.', top_blockers: [], updated_at: null },
          paused: true
        }
      ],
      '2026-09-21'
    )
    expect(text.startsWith('Briefing for 2026-09-21: 2 active projects, 1 needs attention.')).toBe(true)
    expect(text.indexOf('## Loud (paused)')).toBeLessThan(text.indexOf('## Quiet'))
    expect(text).toContain('Pending approvals: 2 agent steps waiting for approval.')
  })
})
