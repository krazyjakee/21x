import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { migrateCommanderActions } from '../database/commander-actions-migration'
import { CommanderStore } from '../commander/commander-store'
import { actionMutation } from '../commander/action-results'
import type { IpcDeps } from './deps'
import type { ChatProvider } from '../chat/providers/types'

type Handler = (event: unknown, payload?: unknown) => unknown
const { handlers, send, confirm } = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), send: vi.fn((_sender: unknown, _channel: string, _event: unknown) => true), confirm: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/tmp' }, dialog: { showMessageBox: confirm }, ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } }))
vi.mock('../guarded-ipc-send', () => ({ guardedIpcSend: send }))
vi.mock('../chat/provider-factory', () => ({ createChatProviderFromSettings: vi.fn() }))
vi.mock('../captain-github-tools', () => ({ recoverIssueWriteOutcomes: vi.fn(async () => undefined), setCaptainActionHandler: vi.fn() }))
vi.mock('./projects', () => ({ broadcastProjectChanged: vi.fn() }))
vi.mock('./settings', () => ({ broadcastSkillsChanged: vi.fn() }))

let fixture: ReturnType<typeof createPortableDbFixture>
let store: CommanderStore
let host: typeof import('./commander')
let provider: () => ChatProvider
let sessionId: string
let actionId: string
let projectId: string
let trusted: { sender: EventEmitter & { getType(): string; isDestroyed(): boolean; send: ReturnType<typeof vi.fn> }; senderFrame: { url: string; parent: null } }

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  handlers.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fixture = createPortableDbFixture()
  migrateCommanderActions(fixture.rawDb)
  store = new CommanderStore(fixture.db)
  sessionId = store.createSession('Requested change').id
  const project = fixture.db.createProject({ name: 'Atlas' })!
  projectId = project.id
  const result = actionMutation({ db: fixture.db, sessionId, toolCallId: 'archive-1', scope: 'ipc-test', tool: 'archive_project', target: { kind: 'project', id: project.id, name: project.name }, before: { archived: false },
    write: () => { fixture.db.archiveProject(project.id, true); return fixture.db.getProject(project.id)! }, after: (value) => ({ archived: value.archived }) })
  actionId = JSON.parse(result.content).undoId
  provider = vi.fn(() => { throw new Error('Undo must not build a model provider') })
  host = await import('./commander')
  host.registerCommanderHandlers({ db: fixture.db, agentManager: { sendMessage: vi.fn(async () => ({})) } } as unknown as IpcDeps, { createProvider: provider, getTools: () => [] })
  trusted = { sender: Object.assign(new EventEmitter(), { getType: () => 'window', isDestroyed: () => false, send: vi.fn() }), senderFrame: { url: pathToFileURL(join(__dirname, '../../renderer/index.html')).href, parent: null } }
})
afterEach(async () => {
  await host?.closeCommanderServices()
  fixture.rawDb.close()
  vi.restoreAllMocks()
})

describe('Commander direct Undo IPC', () => {
  it('reads authoritative activity without constructing a provider or loading transcript history', () => {
    const sql = vi.spyOn(fixture.rawDb, 'prepare')
    const snapshot = handlers.get('commander:getActivity')!(trusted, { sessionId })
    expect(snapshot).toMatchObject({ phase: 'idle', turnId: null, ageMs: expect.any(Number), sequence: expect.any(Number), epoch: expect.any(String) })
    expect(sql.mock.calls.every(([query]) => !query.includes('commander_messages'))).toBe(true)
    expect(provider).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('guards activity reads before touching an untrusted payload and rejects missing sessions', () => {
    const read = vi.fn(() => sessionId)
    expect(() => handlers.get('commander:getActivity')!({ ...trusted, senderFrame: { url: 'https://example.com/', parent: null } },
      { get sessionId() { return read() } })).toThrow('only available to the main window')
    expect(read).not.toHaveBeenCalled()
    expect(() => handlers.get('commander:getActivity')!(trusted, { sessionId: 'missing' })).toThrow('Commander session not found')
    expect(provider).not.toHaveBeenCalled()
  })

  it('reverses the recorded action immediately in the same conversation, without a model or confirmation', () => {
    const result = handlers.get('commander:undoAction')!(trusted, { sessionId, actionId }) as { alreadyUndone: boolean; message: { id: string; session_id: string; content: string } }
    expect(result.alreadyUndone).toBe(false)
    expect(fixture.db.getProject(projectId)?.archived).toBe(false)
    expect(result.message).toMatchObject({ session_id: sessionId, content: expect.stringContaining('Undo applied directly: Atlas') })
    expect(store.getMessage(result.message.id)).toBeTruthy()
    expect(send.mock.calls.map((call) => call[2])).toContainEqual(expect.objectContaining({ type: 'messages_appended', sessionId }))
    expect(provider).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    const replay = handlers.get('commander:undoAction')!(trusted, { sessionId, actionId }) as { alreadyUndone: boolean; message: { id: string } }
    expect(replay).toMatchObject({ alreadyUndone: true, message: { id: result.message.id } })
    expect(store.listMessages(sessionId)).toHaveLength(1)
  })

  it.each(['webview', 'subframe', 'foreign', 'missing-frame'])('rejects a %s sender before reading the payload or changing anything', (kind) => {
    const event = kind === 'webview' ? { ...trusted, sender: { getType: () => 'webview' } }
      : kind === 'subframe' ? { ...trusted, senderFrame: { ...trusted.senderFrame, parent: {} } }
        : kind === 'foreign' ? { ...trusted, senderFrame: { url: 'https://example.com/', parent: null } }
          : { sender: trusted.sender, senderFrame: null }
    const read = vi.fn(() => sessionId)
    expect(() => handlers.get('commander:undoAction')!(event, { get sessionId() { return read() }, actionId })).toThrow('only available to the main window')
    expect(read).not.toHaveBeenCalled()
    expect(fixture.db.getProject(projectId)?.archived).toBe(true)
    expect(store.listMessages(sessionId)).toEqual([])
    expect(provider).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('rejects another conversation and refuses stale values without best-effort restoration', () => {
    const other = store.createSession('Other conversation')
    expect(() => handlers.get('commander:undoAction')!(trusted, { sessionId: other.id, actionId })).toThrow('Action not found in this conversation')
    expect(fixture.db.getProject(projectId)?.archived).toBe(true)
    fixture.db.archiveProject(projectId, false)
    expect(() => handlers.get('commander:undoAction')!(trusted, { sessionId, actionId })).toThrow('affected fields changed after this action')
    expect(fixture.db.getProject(projectId)?.archived).toBe(false)
    expect(store.listMessages(sessionId)).toEqual([])
    expect(provider).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
})
