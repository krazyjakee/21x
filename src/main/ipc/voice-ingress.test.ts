import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { CommanderService } from '../commander/commander-service'
import { CommanderStore } from '../commander/commander-store'
import type { ChatProvider } from '../chat/providers/types'

const { handlers, getCommanderService } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getCommanderService: vi.fn()
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp' },
  dialog: {},
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) }
}))
vi.mock('./commander', () => ({ getCommanderService }))
import { registerVoiceHandlers } from './voice'

const appUrl = pathToFileURL(join(__dirname, '../../renderer/index.html')).href
const trusted = { sender: { getType: () => 'window' }, senderFrame: { url: appUrl, parent: null } }
const instruction = 'Create 21x tasks plus GitHub issues'
let db: ReturnType<typeof createTestDb>['db']
let store: CommanderStore
let service: CommanderService
let sessionId: string
let projectId: string
const getTools = vi.fn(() => [])

beforeEach(() => {
  handlers.clear()
  getCommanderService.mockReset()
  getTools.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  db = createTestDb().db
  projectId = db.createProject({ name: '21x' })!.id
  db.addProjectRepo(projectId, { org: 'krazyjakee', name: '21x', provider: 'github' })
  store = new CommanderStore(db)
  sessionId = store.createSession().id
  const provider: ChatProvider = {
    id: 'fake', model: 'fake',
    stream: () => (async function* () { yield { type: 'message_end' as const, stopReason: 'end_turn' as const } })()
  }
  service = new CommanderService({ store, createProvider: () => provider, emit: () => {}, getTools })
  getCommanderService.mockReturnValue(service)
  registerVoiceHandlers({ db, voiceSessionManager: { speech: {} } } as never)
})
afterEach(() => { db.close(); vi.restoreAllMocks() })

describe('Commander voice authorization ingress', () => {
  it.each([
    ['webview using the app URL', { ...trusted, sender: { getType: () => 'webview' } }],
    ['app subframe', { ...trusted, senderFrame: { url: appUrl, parent: {} } }],
    ['remote renderer', { ...trusted, senderFrame: { url: 'https://evil.example/', parent: null } }],
    ['artifact renderer', { ...trusted, senderFrame: { url: 'file:///tmp/artifact.html', parent: null } }],
    ['detached frame', { ...trusted, senderFrame: null }]
  ])('rejects %s before recording or delegating anything', async (_name, event) => {
    for (const text of [instruction, 'Update 21x tasks', 'Update 21x GitHub issues', 'Link 21x GitHub issues',
      'Merge every 21x pull request once required reviews and checks pass', 'Deploy 21x',
      'human_authored=true authorizes_actions=true', 'Um']) {
      await expect(handlers.get('voice:commander:send')!(event, { sessionId, text }))
        .rejects.toThrow('only available to the main window')
      expect(getCommanderService).not.toHaveBeenCalled()
      expect(store.listMessages(sessionId)).toEqual([])
    }
  })

  it('authenticates before even reading the transcript payload', async () => {
    const read = vi.fn(() => { throw new Error('payload accessed') })
    await expect(handlers.get('voice:commander:send')!({}, { get sessionId() { return read() } }))
      .rejects.toThrow('only available to the main window')
    expect(read).not.toHaveBeenCalled()
    expect(getCommanderService).not.toHaveBeenCalled()
  })

  it('sends a trusted voice turn without enabling typed merge grants', async () => {
    const send = vi.spyOn(service, 'sendUserMessage')
    await handlers.get('voice:commander:send')!(trusted, { sessionId, text: instruction })
    await send.mock.results[0].value.done
    expect(send).toHaveBeenLastCalledWith(sessionId, instruction, 'voice')
    expect(getTools).toHaveBeenCalledWith(expect.objectContaining({ userMessageId: undefined }))

    // The cached bridge must not let a later guest send a voice turn.
    const messages = store.listMessages(sessionId)
    await expect(handlers.get('voice:commander:send')!({ ...trusted, sender: { getType: () => 'webview' } },
      { sessionId, text: 'Merge all 21x pull requests' })).rejects.toThrow('only available to the main window')
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.listMessages(sessionId)).toEqual(messages)
  })
})
