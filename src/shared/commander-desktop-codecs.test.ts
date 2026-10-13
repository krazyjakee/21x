import { describe, expect, it } from 'vitest'
import type { JsonValue } from './service-protocol'
import { COMMANDER_COMMAND_CODECS, COMMANDER_DESKTOP_LIMITS, COMMANDER_EVENT_CODECS, COMMANDER_DESKTOP_ERROR, CHAT_DESKTOP_ERROR, type CommanderDesktopOperation } from './commander-desktop-codecs'
import type { CommanderMessage, CommanderSession } from './commander'
const image = { name: 'fixture.png', mimeType: 'image/png' as const, data: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64') }
const session: CommanderSession = { id: 'session-1', title: 'Project reports', created_at: 1, updated_at: 2, archived: false, last_read_at: null, unread_count: 1, is_report_inbox: true }
const message: CommanderMessage = { id: 'managed-step:turn-1:2', session_id: session.id, role: 'report', content: 'The checkout changed; review the deployment.', tool_calls: null, tool_call_id: null, tool_name: null, is_error: false, project_id: 'project-1', correlation_id: 'request-1', created_at: 3, input_mode: null }
describe('exact Commander/chat codecs', () => {
  it('round-trips every declared operation and preserves explicit null/undefined', () => {
    const cases: Array<[CommanderDesktopOperation, unknown[]]> = [
      ['commander:listSessions', [{ search: 'checkout', includeArchived: true }]], ['commander:createSession', [{ title: 'Checkout' }]],
      ['commander:renameSession', [session.id, 'Renamed']], ['commander:archiveSession', [session.id, false]], ['commander:listMessages', [session.id]],
      ['commander:markRead', [session.id]], ['commander:setActiveSession', [null]], ['commander:send', [session.id, 'Review this', [image]]],
      ['commander:getImage', ['image-1']], ['commander:cancel', [session.id]], ['commander:undoAction', [session.id, 'session-1:delivery-scope:call-1']], ['commander:getActivity', [session.id]],
      ['chat:start', [{ messages: [{ role: 'user', content: 'Describe this', images: [image] }], system: 'Answer briefly', maxToolCalls: 0 }]], ['chat:cancel', ['turn-1']]
    ]
    for (const [operation, args] of cases) expect(COMMANDER_COMMAND_CODECS[operation].decodeArguments(COMMANDER_COMMAND_CODECS[operation].encodeArguments(args as never))).toEqual(args)
    expect(COMMANDER_COMMAND_CODECS['commander:setActiveSession'].encodeResult(undefined)).toEqual({ defined: false })
    expect(COMMANDER_COMMAND_CODECS['commander:renameSession'].decodeResult(null)).toBeNull()
    expect(COMMANDER_COMMAND_CODECS['commander:getImage'].decodeResult(null)).toBeNull()
    expect(COMMANDER_COMMAND_CODECS['commander:send'].validateWireResult({ defined: false })).toBe(false)
    expect(COMMANDER_COMMAND_CODECS['commander:setActiveSession'].validateWireResult({ defined: false, value: null })).toBe(false)
  })
  it('rejects undeclared identity, path, title, boolean and history fields before effects', () => {
    expect(() => COMMANDER_COMMAND_CODECS['commander:listSessions'].decodeArguments({ search: '', projectId: 'foreign' })).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:send'].decodeArguments({ sessionId: session.id, text: 'hello', caller: { principal: 'service' } })).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:archiveSession'].decodeArguments({ id: session.id, archived: 'yes' })).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:renameSession'].encodeArguments([session.id, 'x'.repeat(501)])).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:cancel'].encodeArguments(['../private'])).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['chat:start'].encodeArguments([{ messages: [{ role: 'assistant', content: 'unowned prefix' }] }])).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['chat:start'].decodeArguments({ messages: [{ role: 'user', content: 'hello', taskId: 'foreign' }] })).toThrow()
  })
  it('uses versioned magic-checked base64 bytes without Buffer/Uint8Array or arbitrary filesystem paths', () => {
    const codec = COMMANDER_COMMAND_CODECS['commander:getImage']
    const encoded = codec.encodeResult({ id: 'image-1', ...image })
    expect(encoded).toEqual({ defined: true, value: { id: 'image-1', version: 1, name: image.name, mimeType: image.mimeType, encoding: 'base64', byteLength: 12, data: image.data } })
    expect(encoded.defined && codec.decodeResult(encoded.value)).toEqual({ id: 'image-1', ...image })
    expect(codec.validateWireResult(encoded)).toBe(true)
    expect(() => COMMANDER_COMMAND_CODECS['commander:send'].encodeArguments([session.id, '', [{ ...image, name: '../private.png' }]])).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:send'].encodeArguments([session.id, '', [{ ...image, mimeType: 'image/jpeg' }]])).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:send'].decodeArguments({ sessionId: session.id, text: '', images: { version: 1, images: [{ ...image, encoding: 'base64', byteLength: 999 }] } })).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:send'].decodeArguments({ sessionId: session.id, text: '', images: { version: 2, images: [] } })).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:send'].decodeArguments({ sessionId: session.id, text: 'inspect', images: { version: 1, images: [{ path: '/private', encoding: 'base64' }] } })).toThrow()
    expect(codec.validateResult({ id: 'image-1', ...image, data: new Uint8Array([1, 2]) })).toBe(false)
  })
  it('bounds bytes, count, nesting and UTF-8, including cumulative images and whole replies', () => {
    const bytes = Buffer.alloc(COMMANDER_DESKTOP_LIMITS.imageBytes); Buffer.from(image.data, 'base64').copy(bytes)
    const large = { ...image, data: bytes.toString('base64') }
    expect(() => COMMANDER_COMMAND_CODECS['commander:send'].encodeArguments([session.id, 'two images', [large, large]])).not.toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:send'].encodeArguments([session.id, 'three images', [large, large, large]])).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['chat:start'].encodeArguments([{ messages: [
      { role: 'user', content: 'First image', images: [large] },
      { role: 'assistant', content: 'Received' },
      { role: 'user', content: 'Two more', images: [large, large] }
    ] }])).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['chat:start'].encodeArguments([{ messages: Array.from({ length: 6 }, () => ({ role: 'user' as const, content: 'Tiny image', images: [image] })) }])).toThrow()
    expect(() => COMMANDER_COMMAND_CODECS['commander:send'].encodeArguments([session.id, '💬'.repeat(20_000)])).toThrow()
    const oversized = Array.from({ length: 128 }, (_, index) => ({ ...message, id: `message-${index}`, content: 'x'.repeat(8192) }))
    expect(() => COMMANDER_COMMAND_CODECS['commander:listMessages'].encodeResult({ messages: oversized, activeTurnId: null })).toThrow()
    const input: Record<string, unknown> = {}; input.self = input
    expect(COMMANDER_EVENT_CODECS['commander:event'].validatePayload({ type: 'turn_event', sessionId: session.id, turnId: 'turn-1', event: { type: 'tool_call_start', id: 'call-1', name: 'update_project', input } })).toBe(false)
  })
  it('preserves report correlation/inbox identity, summary dividers, exact action text and honest activity age', () => {
    expect(COMMANDER_COMMAND_CODECS['commander:listSessions'].decodeResult([session] as unknown as JsonValue)).toEqual([session])
    const action = { ...message, role: 'tool' as const, tool_name: 'update_project', content: JSON.stringify({ status: 'ok', undoId: 'action-1', changes: [{ field: 'name', before: 'Old', after: 'New' }] }) }
    const rows = [message, { ...message, id: 'rollover-summary:handoff-1', role: 'summary' as const }, action]
    expect(COMMANDER_COMMAND_CODECS['commander:listMessages'].decodeResult({ messages: rows, activeTurnId: null } as unknown as JsonValue)).toEqual({ messages: rows, activeTurnId: null })
    const activity = { epoch: 'source-epoch', sequence: 2, turnId: 'turn-1', phase: 'unknown', ageMs: 20_000, openTools: [], hasText: false }
    expect(COMMANDER_COMMAND_CODECS['commander:getActivity'].decodeResult(activity)).toEqual(activity)
    expect(COMMANDER_EVENT_CODECS['commander:event'].validatePayload({ type: 'messages_appended', sessionId: 'foreign', messages: [message] })).toBe(false)
  })
  it('redacts provider failure text and round-trips final chat history with image bytes', () => {
    const event = COMMANDER_EVENT_CODECS['commander:event'].encodePayload({ type: 'turn_event', sessionId: session.id, turnId: 'turn-1', event: { type: 'error', message: 'private-provider-key' } })
    expect(event).toMatchObject({ event: { type: 'error', message: COMMANDER_DESKTOP_ERROR } })
    expect(JSON.stringify(event)).not.toContain('private-provider-key')
    const chatError = COMMANDER_EVENT_CODECS['chat:event'].encodePayload({ turnId: 'turn-1', event: { type: 'error', message: 'private endpoint' } })
    expect(chatError).toMatchObject({ event: { message: CHAT_DESKTOP_ERROR } })
    const chat = { turnId: 'turn-1', event: { type: 'done' as const, stopReason: 'end_turn' as const, messages: [{ role: 'user' as const, content: 'Describe this', images: [image] }, { role: 'assistant' as const, content: 'A fixture image.' }], usage: { inputTokens: 3, outputTokens: 4 } } }
    expect(COMMANDER_EVENT_CODECS['chat:event'].decodePayload(COMMANDER_EVENT_CODECS['chat:event'].encodePayload(chat))).toEqual(chat)
  })
})
