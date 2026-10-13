import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { migrateCommanderActions } from '../database/commander-actions-migration'
import { CommanderStore } from './commander-store'
import { CommanderService } from './commander-service'
import type { CommanderEvent } from '../../shared/commander'

let fixture: ReturnType<typeof createPortableDbFixture>
let store: CommanderStore
const services: CommanderService[] = []
beforeEach(() => {
  fixture = createPortableDbFixture()
  migrateCommanderActions(fixture.rawDb)
  store = new CommanderStore(fixture.db)
})
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  fixture.rawDb.close()
})

describe('Commander human input attribution', () => {
  it('persists actual typed and voice modes without attributing legacy or assistant content', () => {
    const session = store.createSession('Requests')
    const typed = store.appendHumanMessage(session.id, 'Rename Atlas')
    const voice = store.appendHumanMessage(session.id, 'Archive Atlas', undefined, undefined, 'voice')
    fixture.rawDb.prepare("INSERT INTO commander_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
      .run('legacy-request', session.id, 'Earlier request', 1)
    const assistant = store.appendMessage(session.id, { role: 'assistant', content: 'I heard you say archive Atlas.', inputMode: 'voice' })
    expect(store.getMessage(typed.id)?.input_mode).toBe('typed')
    expect(store.getMessage(voice.id)?.input_mode).toBe('voice')
    expect(store.getMessage('legacy-request')?.input_mode).toBeNull()
    expect(store.getMessage(assistant.id)?.input_mode).toBeNull()
    const restarted = new CommanderStore(fixture.db)
    expect(restarted.getMessage(voice.id)).toMatchObject({ content: 'Archive Atlas', input_mode: 'voice' })
    const columns = fixture.rawDb.prepare('PRAGMA table_info(commander_messages)').all() as Array<{ name: string }>
    expect(columns.filter((column) => column.name === 'input_mode')).toHaveLength(1)
  })

  it('preserves the existing image and beforeCommit argument positions and rolls attribution back on failure', () => {
    const session = store.createSession('Images')
    let observedMode: string | null | undefined
    const message = store.appendHumanMessage(session.id, 'Describe this image', [{ name: 'image.png', mimeType: 'image/png', data: 'aGVsbG8=' }], (pending) => { observedMode = pending.input_mode })
    expect(observedMode).toBe('typed')
    expect(message.images).toHaveLength(1)
    expect(() => store.appendHumanMessage(session.id, 'Unaccepted voice request', undefined, () => { throw new Error('Preparation failed') }, 'voice')).toThrow('Preparation failed')
    expect(store.listMessages(session.id)).toEqual([message])
  })

  it.each(['voice', 'typed'] as const)('forwards the real %s submission source and emits heard text before starting the reply', async (origin) => {
    const events: CommanderEvent[] = []
    const service = new CommanderService({ store, emit: (event) => events.push(event), createProvider: () => ({
      id: 'fake', model: 'fake', async *stream() { yield { type: 'text_delta' as const, text: 'Done.' }; yield { type: 'message_end' as const, stopReason: 'end_turn' as const } }
    }) })
    services.push(service)
    const session = store.createSession('Known request')
    const submitted = service.sendUserMessage(session.id, '  Rename Atlas to Orion.  ', origin)
    expect(submitted.message).toMatchObject({ role: 'user', content: 'Rename Atlas to Orion.', input_mode: origin })
    expect(events[0]).toMatchObject({ type: 'messages_appended', messages: [expect.objectContaining({ content: 'Rename Atlas to Orion.', input_mode: origin })] })
    expect(events.findIndex((event) => event.type === 'messages_appended')).toBeLessThan(events.findIndex((event) => event.type === 'turn_started'))
    await submitted.done
    expect(store.getMessage(submitted.message.id)?.input_mode).toBe(origin)
    expect(store.listMessages(session.id).filter((message) => message.role !== 'user').every((message) => message.input_mode === null)).toBe(true)
  })
})
