import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import type { ChatProvider, ChatProviderEvent } from './chat/providers/types'

const host = vi.hoisted(() => ({ provider: null as ChatProvider | null }))
vi.mock('./chat/provider-factory', () => ({ createChatProviderFromSettings: () => host.provider }))
vi.mock('./ipc/commander', () => ({ getCommanderService: () => null }))

import { closeScheduledCoordination, startScheduledCoordination, stopScheduledCoordination } from './scheduled-coordination'

describe('scheduled coordination application owner', () => {
  const sources: ReturnType<typeof createPortableDbFixture>[] = []
  afterEach(async () => {
    await closeScheduledCoordination()
    for (const source of sources.splice(0)) source.rawDb.close()
    host.provider = null
  })
  it('coalesces startup and retains a stopped owner through failed close before source replacement', async () => {
    const source = createPortableDbFixture(), replacement = createPortableDbFixture()
    sources.push(source, replacement)
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    let entered = false
    host.provider = {
      id: 'fixture', model: 'fixture',
      stream: async function* (): AsyncGenerator<ChatProviderEvent> {
        entered = true
        await gate
        yield { type: 'text_delta', text: 'Fixture summary' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      }
    }
    const deps = { db: source.db, agents: {} as never }
    const owner = startScheduledCoordination(deps)
    expect(startScheduledCoordination(deps)).toBe(owner)
    const briefing = owner.runBriefingNow()
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      stopScheduledCoordination()
      expect(() => startScheduledCoordination({ ...deps, db: replacement.db })).toThrow('SCHEDULED_COORDINATION_SHUTDOWN_INCOMPLETE')
      await expect(closeScheduledCoordination(5)).rejects.toThrow('SCHEDULED_COORDINATION_SHUTDOWN_INCOMPLETE')
      expect(() => startScheduledCoordination(deps)).toThrow('SCHEDULED_COORDINATION_CLOSED')
      const retry = closeScheduledCoordination()
      finish()
      expect(await briefing).toBeNull()
      await retry
      const next = startScheduledCoordination({ ...deps, db: replacement.db })
      expect(next).not.toBe(owner)
      await next.tick()
      await closeScheduledCoordination()
      expect(() => startScheduledCoordination({ ...deps, db: replacement.db })).toThrow('SCHEDULED_COORDINATION_CLOSED')
    } finally { finish(); await briefing }
  })
})
