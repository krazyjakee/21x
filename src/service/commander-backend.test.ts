import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { CommanderStore } from '../main/commander/commander-store'
import { CommanderService } from '../main/commander/commander-service'
import { createCommanderProjectTools } from '../main/commander/project-tools'
import { createCaptainReportHandler } from '../main/commander/report-tools'
import { DeliveryStore } from '../main/sessions/delivery-store'
import { ChatRuntime } from '../main/chat/chat-runtime'
import { ChatAbortError, type ChatProvider, type ChatProviderRequest, type ChatProviderEvent } from '../main/chat/providers/types'
import { CommanderBackend, type CommanderBackendOptions } from './commander-backend'
import { COMMANDER_COMMAND_CODECS, COMMANDER_DESKTOP_LIMITS, type CommanderDesktopOperation, type CommanderCommandCodec } from '../shared/commander-desktop-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'
import type { CommanderEvent } from '../shared/commander'

class ControlledProvider implements ChatProvider {
  readonly id = 'openai-compatible'
  readonly model = 'controlled-model'
  readonly supportsImages = true
  readonly requests: ChatProviderRequest[] = []
  barrier: Promise<void> | null = null
  renameProject: string | null = null
  async *stream(request: ChatProviderRequest, signal: AbortSignal): AsyncIterable<ChatProviderEvent> {
    this.requests.push(request)
    if (this.barrier) await this.barrier
    if (signal.aborted) throw new ChatAbortError()
    if (this.renameProject && request.tools.some(tool => tool.name === 'update_project') && !request.messages.some(message => message.role === 'tool' && message.name === 'update_project')) {
      yield { type: 'tool_call', id: 'project-call', name: 'update_project', input: { project: this.renameProject, changes: { name: 'Renamed by actual tool' } } }
      yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 2, outputTokens: 3 } }
      return
    }
    yield { type: 'text_delta', text: 'All good.' }
    yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } }
  }
}
let db: ReturnType<typeof createPortableTestDb>, agents: AgentManager, store: CommanderStore, commander: CommanderService, chat: ChatRuntime, provider: ControlledProvider, backend: CommanderBackend, options: CommanderBackendOptions
let nativeEvents: Array<{ operation: string; payload: JsonValue; recipient?: DesktopCallerContext }>, sourceEvents: CommanderEvent[], releaseProvider: (() => void) | null
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'commander-epoch', webviewId: 'main', origin: 'app://trusted-main' }
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
  db = createPortableTestDb(); store = new CommanderStore(db); provider = new ControlledProvider(); chat = new ChatRuntime(); nativeEvents = []; sourceEvents = []; releaseProvider = null
  agents = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
  commander = new CommanderService({ store, createProvider: () => provider, emit: event => { sourceEvents.push(event); nativeEvents.push({ operation: 'commander:event', payload: backend.encodeEvent('commander:event', event) }) },
    getTools: context => createCommanderProjectTools({ db, context, agents }) })
  options = { database: db, store, commander, chat, agents, createChatProvider: () => provider, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Profile closed') }, isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin?.startsWith('app://trusted') === true,
    canAccessGlobalCommander: () => true, canAccessSession: () => true, canAccessProject: () => true, canAccessGlobalSkills: () => true,
    emit: (operation, payload, recipient) => { nativeEvents.push({ operation, payload, recipient }) }, onFatalEvent: vi.fn() }
  backend = new CommanderBackend(options)
})
afterEach(async () => {
  releaseProvider?.(); provider.barrier = null
  await backend.close(); await Promise.all([commander.close(), chat.close(), agents.stopAllSessions()])
  const profile = dirname(dirname(db.getWorkspaceDir('cleanup')))
  db.close(); rmSync(profile, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends CommanderDesktopOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], identity = caller, signal = new AbortController().signal): Promise<DesktopCommandMap[K]['result']> {
  const codec = COMMANDER_COMMAND_CODECS[operation] as CommanderCommandCodec<K>
  const encoded = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(encoded)).toBe(true)
  return codec.decodeResult((encoded as { defined: boolean; value?: JsonValue }).value)
}
function holdProvider(): void { provider.barrier = new Promise<void>(resolve => { releaseProvider = resolve }) }
async function settled(): Promise<void> { await vi.waitFor(() => expect(backend.inflightCount).toBe(0)) }

describe('portable actual Commander/chat owners', () => {
  it('persists session CRUD/read/activation and emits changes without starting a model turn', async () => {
    const session = await call('commander:createSession', [{ title: '  Checkout   polish  ' }])
    expect(session.title).toBe('Checkout polish')
    expect((await call('commander:renameSession', [session.id, 'Review checkout']))?.title).toBe('Review checkout')
    expect(await call('commander:listSessions', [{ search: 'Review', includeArchived: true }])).toHaveLength(1)
    await call('commander:setActiveSession', [session.id]); expect(commander.isSessionActive(session.id)).toBe(true)
    backend.detachCaller({ ...caller, principal: 'service' })
    expect(commander.isSessionActive(session.id)).toBe(true)
    await call('commander:setActiveSession', [null]); expect(commander.isSessionActive(session.id)).toBe(false)
    expect((await call('commander:archiveSession', [session.id, true]))?.archived).toBe(true)
    expect(await call('commander:listSessions', [])).toEqual([])
    await call('commander:archiveSession', [session.id, false])
    expect(await call('commander:listMessages', [session.id])).toEqual({ messages: [], activeTurnId: null })
    const schema = backend.operationSchemas(caller)['commander:listMessages']
    if (!schema?.handle) throw new Error('Missing listMessages operation handler')
    const wire = await schema.handle({ sessionId: session.id }, new AbortController().signal)
    expect(schema.validateResult(wire)).toBe(true)
    expect(await call('commander:markRead', [session.id])).toMatchObject({ unread_count: 0 })
    expect(await call('commander:getActivity', [session.id])).toMatchObject({ phase: 'idle', turnId: null })
    expect(provider.requests).toEqual([])
  })
  it('accepts one durable typed image turn, keeps it running across navigation, and cancels the actual owner', async () => {
    holdProvider()
    const session = await call('commander:createSession', [{ title: 'Image review' }])
    const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), image = { name: 'fixture.png', mimeType: 'image/png' as const, data: bytes.toString('base64') }
    const accepted = await call('commander:send', [session.id, 'Describe this fixture.', [image]])
    expect(store.getMessage(accepted.message.id)).toMatchObject({ role: 'user', input_mode: 'typed', content: 'Describe this fixture.' })
    await call('commander:setActiveSession', [null])
    backend.detachCaller(caller)
    expect(commander.activeTurnId(session.id)).toBe(accepted.turnId)
    const rows = await call('commander:listMessages', [session.id])
    expect(rows.activeTurnId).toBe(accepted.turnId)
    const imageId = rows.messages[0]?.images?.[0]?.id
    expect(imageId).toBeTruthy(); if (!imageId) throw new Error('Image fixture was not stored')
    expect(await call('commander:getImage', [imageId])).toEqual({ id: imageId, ...image })
    const storedImage = store.getImage(imageId)
    if (!storedImage) throw new Error('Image fixture was lost')
    expect(Buffer.from(storedImage.data, 'base64')).toEqual(bytes)
    expect(await call('commander:cancel', [session.id])).toEqual({ cancelled: true })
    releaseProvider?.(); provider.barrier = null; await settled()
    expect(await call('commander:cancel', [session.id])).toEqual({ cancelled: false })
    expect(store.listMessages(session.id).filter(message => message.role === 'user')).toHaveLength(1)
    expect(sourceEvents.filter(event => event.type === 'turn_started')).toHaveLength(1)
  })
  it('preserves quiet durable inbox/correlation/outbox delivery and opening never pays for a model turn', async () => {
    const project = db.createProject({ name: 'Checkout project' })!, original = store.createSession('Request thread')
    store.appendMessage(original.id, { role: 'tool', content: 'Captain request accepted.', toolName: 'ask_captain', toolCallId: 'ask-call', projectId: project.id, correlationId: 'request-1' })
    const deliveries = new DeliveryStore(db)
    const report = createCaptainReportHandler({ service: commander, store, deliveries, getProject: id => db.getProject(id) })
    const unsolicited = report({ projectId: project.id, message: 'Deployment needs review.', deliveryId: 'inbox-fixture', source: 'captain_action' })
    expect(unsolicited).toMatchObject({ delivered: true, routedBy: 'inbox', relayed: false })
    if (!unsolicited.delivered) throw new Error('Report fixture was refused')
    const inbox = store.getSession(unsolicited.sessionId)
    expect(inbox).toMatchObject({ is_report_inbox: true, unread_count: 1 })
    const correlated = report({ projectId: project.id, message: 'Requested checkout change finished.', correlationId: 'request-1', source: 'captain_action' })
    expect(correlated).toMatchObject({ delivered: true, sessionId: original.id, routedBy: 'correlation', relayed: false })
    report({ projectId: project.id, message: 'Deployment needs review.', deliveryId: 'inbox-fixture', source: 'captain_action' })
    expect(store.listMessages(unsolicited.sessionId).filter(message => message.role === 'report')).toHaveLength(1)
    expect(db.db.prepare("SELECT state FROM delivery_outbox WHERE idempotency_key='inbox-fixture'").get()).toEqual({ state: 'acknowledged' })
    const timestamp = store.listMessages(original.id).find(message => message.role === 'report')?.created_at
    await call('commander:setActiveSession', [unsolicited.sessionId]); await call('commander:markRead', [unsolicited.sessionId]); await call('commander:listMessages', [unsolicited.sessionId])
    expect(store.listMessages(original.id).find(message => message.role === 'report')?.created_at).toBe(timestamp)
    expect(provider.requests).toEqual([])
    expect(store.getSession(unsolicited.sessionId)?.unread_count).toBe(0)
  })
  it('reverses an actual admin-tool write exactly once and refuses later conflicting writes', async () => {
    const project = db.createProject({ name: 'Original project' })!
    const session = await call('commander:createSession', [{ title: 'Exact Undo' }]); provider.renameProject = project.id
    await call('commander:send', [session.id, 'Rename this project.']); await settled()
    expect(db.getProject(project.id)?.name).toBe('Renamed by actual tool')
    const action = db.db.prepare('SELECT id FROM commander_actions WHERE session_id=?').get(session.id) as { id: string } | undefined
    if (!action) throw new Error('Actual tool did not record an Undo')
    options.canAccessProject = () => false
    await expect(call('commander:undoAction', [session.id, action.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getProject(project.id)?.name).toBe('Renamed by actual tool')
    options.canAccessProject = () => true
    const first = await call('commander:undoAction', [session.id, action.id])
    expect(first.alreadyUndone).toBe(false); expect(db.getProject(project.id)?.name).toBe('Original project')
    expect(await call('commander:undoAction', [session.id, action.id])).toEqual({ alreadyUndone: true, message: first.message })
    expect(store.listMessages(session.id).filter(message => message.tool_name === 'undo_action')).toHaveLength(1)
    const another = store.createSession('Conflict'); await call('commander:send', [another.id, 'Rename this project again.']); await settled()
    const second = db.db.prepare('SELECT id FROM commander_actions WHERE session_id=?').get(another.id) as { id: string } | undefined
    if (!second) throw new Error('Second actual tool did not record an Undo')
    db.updateProject(project.id, { name: 'A later user edit' })
    await expect(call('commander:undoAction', [another.id, second.id])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(db.getProject(project.id)?.name).toBe('A later user edit')
  })
  it('rejects stale/foreign/global/project/image scope before reads, provider work or direct Undo', async () => {
    const session = store.createSession('Private'), project = db.createProject({ name: 'Foreign scope' })!
    const user = store.appendMessage(session.id, { role: 'user', content: 'Private image', images: [{ name: 'fixture.png', mimeType: 'image/png', data: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64') }] })
    store.appendMessage(session.id, { role: 'report', content: 'Private project note', projectId: project.id })
    const imageId = user.images?.[0]?.id; if (!imageId) throw new Error('Missing image fixture')
    await expect(call('commander:send', [session.id, 'Not allowed'], { ...caller, engineEpoch: 'stale' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(call('commander:send', [session.id, 'Not allowed'], { ...caller, principal: 'service' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessProject = () => false
    await expect(call('commander:listMessages', [session.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('commander:getImage', [imageId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await call('commander:listSessions', [])).toEqual([])
    options.canAccessProject = () => true; options.canAccessSession = () => false
    await expect(call('commander:send', [session.id, 'Not allowed'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessSession = () => true; options.canAccessGlobalCommander = () => false
    await expect(call('commander:createSession', [{ title: 'Not allowed' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(provider.requests).toEqual([]); expect(store.listSessions({ includeArchived: true })).toHaveLength(1)
  })
  it('preflights oversized durable rows/images before store materialization and preserves every byte', async () => {
    const session = store.createSession('Large record'), huge = 'x'.repeat(COMMANDER_DESKTOP_LIMITS.fieldBytes + 1)
    const row = store.appendMessage(session.id, { role: 'assistant', content: huge })
    const read = vi.spyOn(store, 'listMessages')
    await expect(call('commander:listMessages', [session.id])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    await expect(call('commander:send', [session.id, 'Do not materialize this'])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    expect(read).not.toHaveBeenCalled(); expect(store.getMessage(row.id)?.content).toBe(huge); expect(provider.requests).toEqual([])
    const bytes = Buffer.alloc(COMMANDER_DESKTOP_LIMITS.imageBytes + 1); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes)
    const imageRow = store.appendMessage(session.id, { role: 'user', content: 'Legacy image', images: [{ name: 'legacy.png', mimeType: 'image/png', data: bytes.toString('base64') }] })
    const id = imageRow.images?.[0]?.id; if (!id) throw new Error('Missing large image fixture')
    const get = vi.spyOn(store, 'getImage')
    await expect(call('commander:getImage', [id])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    expect(get).not.toHaveBeenCalled(); expect(db.db.prepare('SELECT length(data) AS size FROM commander_images WHERE id=?').get(id)).toEqual({ size: bytes.length })
  })
  it('bounds legacy session/message counts before materializing a history list', async () => {
    const session = store.createSession('Many messages')
    for (let index = 0; index <= COMMANDER_DESKTOP_LIMITS.records; index++) store.appendMessage(session.id, { role: 'assistant', content: `Stored row ${index}` })
    const messages = vi.spyOn(store, 'listMessages')
    await expect(call('commander:listMessages', [session.id])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    expect(messages).not.toHaveBeenCalled()
    for (let index = 0; index < COMMANDER_DESKTOP_LIMITS.records; index++) store.createSession(`Stored session ${index}`)
    const sessions = vi.spyOn(store, 'listSessions')
    await expect(call('commander:listSessions', [])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    expect(sessions).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM commander_messages WHERE session_id=?').get(session.id)).toEqual({ count: COMMANDER_DESKTOP_LIMITS.records + 1 })
  })
  it('preflights legacy metadata sizes before session and image-reference materialization', async () => {
    const session = store.createSession('Metadata fixture')
    const imageRow = store.appendMessage(session.id, { role: 'user', content: 'Image metadata', images: [{ name: 'fixture.png', mimeType: 'image/png', data: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64') }] })
    const imageId = imageRow.images?.[0]?.id; if (!imageId) throw new Error('Missing metadata fixture image')
    db.db.prepare('UPDATE commander_images SET mime_type=? WHERE id=?').run('x'.repeat(65), imageId)
    const messages = vi.spyOn(store, 'listMessages')
    await expect(call('commander:listMessages', [session.id])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    expect(messages).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT length(mime_type) AS size FROM commander_images WHERE id=?').get(imageId)).toEqual({ size: 65 })
    db.db.prepare('UPDATE commander_sessions SET title=? WHERE id=?').run('x'.repeat(2001), session.id)
    const sessions = vi.spyOn(store, 'listSessions'), read = vi.spyOn(store, 'getSession')
    await expect(call('commander:listSessions', [])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    await expect(call('commander:archiveSession', [session.id, true])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sessions).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT archived,length(title) AS size FROM commander_sessions WHERE id=?').get(session.id)).toEqual({ archived: 0, size: 2001 })
  })
  it('keeps accepted mutations after request cancellation or publisher failure without retrying the effect', async () => {
    const session = store.createSession('Before'), controller = new AbortController()
    options.emit = (operation, payload) => { nativeEvents.push({ operation, payload }); controller.abort() }
    await expect(call('commander:renameSession', [session.id, 'Accepted rename'], caller, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(store.getSession(session.id)?.title).toBe('Accepted rename'); expect(nativeEvents).toHaveLength(1)
    options.emit = () => { throw new Error('Native sink lost') }
    await expect(call('commander:renameSession', [session.id, 'Accepted before loss'])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(store.getSession(session.id)?.title).toBe('Accepted before loss'); expect(options.onFatalEvent).toHaveBeenCalledOnce()
    await expect(call('commander:renameSession', [session.id, 'Must not repeat'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(store.getSession(session.id)?.title).toBe('Accepted before loss')
  })
  it('runs the actual ChatRuntime and enforces exact native caller cancellation/targeted events', async () => {
    holdProvider()
    const started = await call('chat:start', [{ messages: [{ role: 'user', content: 'Answer this.' }], maxToolCalls: 0 }])
    expect(chat.activeTurnIds).toContain(started.turnId)
    backend.detachCaller({ ...caller, principal: 'service' })
    expect(chat.activeTurnIds).toContain(started.turnId)
    await expect(call('chat:cancel', [started.turnId], { ...caller, origin: 'app://trusted-other' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await call('chat:cancel', [started.turnId])).toEqual({ cancelled: true })
    releaseProvider?.(); provider.barrier = null; await settled()
    expect(await call('chat:cancel', [started.turnId])).toEqual({ cancelled: false })
    expect(nativeEvents.filter(event => event.operation === 'chat:event').every(event => event.recipient?.origin === caller.origin)).toBe(true)
    expect(nativeEvents.find(event => event.operation === 'chat:event' && JSON.stringify(event.payload).includes('cancelled'))).toBeTruthy()
    expect(provider.requests).toHaveLength(1)
  })
  it('keeps a cancelled raw provider owned through a timed-out shutdown and refuses later work', async () => {
    holdProvider()
    const session = store.createSession('Shutdown ownership')
    await call('commander:send', [session.id, 'Wait for the controlled provider.'])
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1))
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(db.db.open).toBe(true); expect(backend.inflightCount).toBeGreaterThan(0)
    await expect(call('commander:createSession', [{ title: 'After close' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    releaseProvider?.(); provider.barrier = null
    await backend.close(); expect(backend.inflightCount).toBe(0)
  })
})
