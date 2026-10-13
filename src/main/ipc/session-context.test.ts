import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { CommanderStore } from '../commander/commander-store'
import type { IpcDeps } from './deps'
import { DEFAULT_ROLLOVER_POLICY } from '../../shared/session-context'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => unknown>())
vi.mock('electron', () => ({ app: { isPackaged: true }, ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => handlers.set(channel, handler) } }))
import { registerSessionContextHandlers } from './session-context'
let fixture: ReturnType<typeof createPortableDbFixture>
let ownerId: string
const sender = Object.assign(new EventEmitter(), { getType: () => 'window', isDestroyed: () => false })
const trusted = { sender, senderFrame: { url: pathToFileURL(join(__dirname, '../../renderer/index.html')).href, parent: null } }
beforeEach(() => {
  handlers.clear()
  fixture = createPortableDbFixture()
  ownerId = new CommanderStore(fixture.db).createSession('Requested context').id
  registerSessionContextHandlers({ db: fixture.db } as IpcDeps)
})
afterEach(() => fixture.rawDb.close())

it('guards both context operations before reading foreign payloads or mutating policy', () => {
  const read = vi.fn(() => ownerId)
  const foreign = { ...trusted, senderFrame: { url: 'https://example.com', parent: null } }
  expect(() => handlers.get('sessionContext:getSnapshot')!(foreign, { kind: 'commander', get ownerId() { return read() } })).toThrow('main window')
  expect(() => handlers.get('sessionContext:setPolicy')!(foreign, { get mode() { return read() } })).toThrow('main window')
  expect(read).not.toHaveBeenCalled()
  expect(fixture.db.getSetting('sessions.rollover')).toBeUndefined()
})
it('reads context without model dispatch and saves validated thresholds atomically', () => {
  const snapshot = handlers.get('sessionContext:getSnapshot')!(trusted, { kind: 'commander', ownerId })
  expect(snapshot).toMatchObject({ scope: { kind: 'commander', ownerId }, usage: { tokens: null, source: 'unknown' } })
  expect(handlers.get('sessionContext:setPolicy')!(trusted, { ...DEFAULT_ROLLOVER_POLICY, mode: 'observe' })).toMatchObject({ mode: 'observe' })
  expect(() => handlers.get('sessionContext:setPolicy')!(trusted, { ...DEFAULT_ROLLOVER_POLICY, mode: 'on', turns: -1 })).toThrow('threshold')
  expect(fixture.db.getSetting('sessions.rollover')).toBe('observe')
  expect(fixture.rawDb.prepare('SELECT COUNT(*) AS count FROM session_generations').get()).toEqual({ count: 0 })
})
