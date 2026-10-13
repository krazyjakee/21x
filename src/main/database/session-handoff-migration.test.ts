import { afterEach, describe, expect, it } from 'vitest'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { applySchema } from './schema'
import { CommanderStore } from '../commander/commander-store'

const fixtures: Array<ReturnType<typeof createPortableDbFixture>> = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.rawDb.close() })
describe('installed v35 session handoff upgrade', () => {
  it('runs the version gate once, preserves conversations and constrains durable identities', () => {
    const fixture = createPortableDbFixture(); fixtures.push(fixture)
    const store = new CommanderStore(fixture.db)
    const session = store.createSession('Retained conversation')
    const message = store.appendHumanMessage(session.id, 'Keep this instruction')
    fixture.rawDb.exec('DROP TABLE session_handoffs')
    fixture.db.setSetting('__schema_version', '35')
    expect(applySchema(fixture.rawDb)).toBe(true)
    expect(fixture.db.getSetting('__schema_version')).toBe('37')
    expect(store.listMessages(session.id)).toEqual([message])
    fixture.rawDb.prepare(`INSERT INTO session_handoffs
      (id, owner_id, engine, generation_key, next_generation_key, model, source, state, created_at, updated_at)
      VALUES ('first', ?, 'chat', 'original', 'next', 'own-model', '{}', 'pending', 1, 1)`).run(session.id)
    expect(() => fixture.rawDb.prepare(`INSERT INTO session_handoffs
      (id, owner_id, engine, generation_key, next_generation_key, model, source, state, created_at, updated_at)
      VALUES ('second', ?, 'chat', 'original', 'other', 'own-model', '{}', 'pending', 2, 2)`).run(session.id)).toThrow(/UNIQUE/)
    expect(() => fixture.rawDb.prepare("UPDATE session_handoffs SET state = 'discarded'").run()).toThrow(/CHECK/)
    expect(applySchema(fixture.rawDb)).toBe(false)
    expect(fixture.rawDb.prepare('SELECT id FROM session_handoffs').all()).toEqual([{ id: 'first' }])
    expect(store.listMessages(session.id)).toEqual([message])
  })
})
