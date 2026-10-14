import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { TRAY_PREFERENCE_CODECS, TRAY_PREFERENCE_OPERATIONS, TRAY_PREFERENCE_LIMITS, TRAY_PREFERENCE_SETTING, type TrayPreferenceOperation, type TrayPreferenceCodec } from '../shared/tray-preference-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { JsonValue } from '../shared/service-protocol'
import { ServiceProtocolError } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { TrayPreferenceBackend, type TrayPreferenceBackendOptions } from './tray-preference-backend'

const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'tray-fixture', webviewId: 'main', origin: 'app://tray-fixture', uiLeaseId: 'tray_document_one' }
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, backend: TrayPreferenceBackend, options: TrayPreferenceBackendOptions, root: string
let available: boolean, read: boolean, write: boolean, currentLease: string
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('tray-fixture')))
  available = read = write = true; currentLease = caller.uiLeaseId!
  manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
  options = { database: db, manager, trayAvailable: true, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!available || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') },
    assertOwners(owners) { if (owners.database !== db || owners.manager !== manager) throw new ServiceProtocolError('DISCONNECTED') },
    isTrustedDesktop: value => value.origin === caller.origin && value.webviewId === caller.webviewId && value.uiLeaseId === currentLease,
    canManageGlobalConfiguration: (_caller, access) => access === 'read' ? read : write }
  backend = new TrayPreferenceBackend(options)
})
afterEach(async () => { await backend.close(); vi.restoreAllMocks(); await manager.stopAllSessions(); await manager.stopServer(); db.close(); rmSync(root, { recursive: true, force: true }) })
async function call<K extends TrayPreferenceOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = TRAY_PREFERENCE_CODECS[operation] as TrayPreferenceCodec<K>, wire = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(wire)).toBe(true); return codec.decodeResult((wire as { value: JsonValue }).value)
}

describe('actual tray durable preference owner', () => {
  it('uses exactly the existing true string, persists strict booleans via actual DatabaseManager and leaves sessions/settings unrelated', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual([...TRAY_PREFERENCE_OPERATIONS]); expect(backend.getPreference()).toBe(false)
    const setter = vi.spyOn(db, 'setSetting'), stop = vi.spyOn(manager, 'stopAllSessions'), queue = vi.spyOn(manager, 'drainStartQueue')
    db.setSetting('unrelated-tray-fixture', 'Preserve historical metadata'); setter.mockClear()
    expect(await call('app:setMinimizeToTray', [true])).toBe(true); expect(setter).toHaveBeenCalledWith(TRAY_PREFERENCE_SETTING, 'true')
    expect(await call('app:getMinimizeToTray', [])).toBe(true); expect(backend.getPreference()).toBe(true)
    expect(await call('app:setMinimizeToTray', [false])).toBe(false); expect(setter).toHaveBeenLastCalledWith(TRAY_PREFERENCE_SETTING, 'false')
    expect(db.getSetting(TRAY_PREFERENCE_SETTING)).toBe('false'); expect(db.getSetting('unrelated-tray-fixture')).toBe('Preserve historical metadata'); expect(stop).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled()
  })
  it('projects one bounded SQL boolean without fetching any full settings or credential values, including huge/malformed legacy rows', async () => {
    const all = vi.spyOn(db, 'getAllSettings').mockImplementation(() => { throw new Error('Secret settings forbidden') }), one = vi.spyOn(db, 'getSetting').mockImplementation(() => { throw new Error('Whole value forbidden') })
    for (const value of ['true', 'false', '', 'True', ' true', 'true ', '1', 'x'.repeat(2 * 1024 * 1024)]) {
      db.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(TRAY_PREFERENCE_SETTING, value)
      expect(backend.getPreference()).toBe(value === 'true'); expect(await call('app:getMinimizeToTray', [])).toBe(value === 'true')
    }
    db.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(TRAY_PREFERENCE_SETTING, Buffer.from('true')); expect(backend.getPreference()).toBe(false)
    expect(all).not.toHaveBeenCalled(); expect(one).not.toHaveBeenCalled()
  })
  it('does not register either control or access settings when the captured actual tray capability is absent', async () => {
    await backend.close(); options = { ...options, trayAvailable: false }; backend = new TrayPreferenceBackend(options)
    const sql = vi.spyOn(db.db, 'prepare'); expect(backend.operationSchemas(caller)).toEqual({})
    for (const operation of TRAY_PREFERENCE_OPERATIONS) await expect(backend.registry.invoke(operation, operation === 'app:getMinimizeToTray' ? {} : { enabled: true }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(() => backend.getPreference()).toThrow(); expect(sql).not.toHaveBeenCalled()
  })
  it('requires distinct read/write grants and rejects wrong principal, epoch, origin and missing/stale document lease before writes', async () => {
    const setter = vi.spyOn(db, 'setSetting')
    for (const identity of [{ ...caller, principal: 'untrusted-webview' as never }, { ...caller, engineEpoch: 'old' }, { ...caller, origin: 'https://untrusted.example' }, { ...caller, uiLeaseId: undefined }, { ...caller, uiLeaseId: 'tray_document_old' }, { ...caller, uiLeaseId: '../forged' }]) await expect(call('app:setMinimizeToTray', [true], undefined, identity)).rejects.toBeDefined()
    write = false; expect(await call('app:getMinimizeToTray', [])).toBe(false); await expect(call('app:setMinimizeToTray', [true])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    read = false; write = true; expect(await call('app:setMinimizeToTray', [true])).toBe(true); await expect(call('app:getMinimizeToTray', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(setter).toHaveBeenCalledTimes(1)
  })
  it.each(['grant', 'document', 'owner', 'cancel'] as const)('fences %s loss after request admission before the actual synchronous DB write', async kind => {
    const setter = vi.spyOn(db, 'setSetting'), controller = new AbortController(), outcome = call('app:setMinimizeToTray', [true], controller.signal).catch(error => error)
    if (kind === 'grant') write = false
    if (kind === 'document') currentLease = 'tray_document_replacement'
    if (kind === 'owner') available = false
    if (kind === 'cancel') controller.abort()
    expect(await outcome).toMatchObject({ code: kind === 'owner' ? 'DISCONNECTED' : kind === 'cancel' ? 'CANCELLED' : 'INVALID_REQUEST' }); expect(setter).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT 1 FROM settings WHERE key=?').get(TRAY_PREFERENCE_SETTING)).toBeUndefined()
  })
  it('keeps a committed preference after a late revoked grant, with no replay or native action', async () => {
    const original = db.setSetting.bind(db), setter = vi.spyOn(db, 'setSetting').mockImplementation((key, value) => { original(key, value); write = false })
    await expect(call('app:setMinimizeToTray', [true])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.db.prepare('SELECT value FROM settings WHERE key=?').get(TRAY_PREFERENCE_SETTING)).toMatchObject({ value: 'true' }); expect(setter).toHaveBeenCalledTimes(1)
  })
  it('captures actual owner identities and capability rather than accepting later replacements', async () => {
    options.trayAvailable = false; await expect(call('app:getMinimizeToTray', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); options.trayAvailable = true
    const original = options.manager; options.manager = {} as AgentManager
    expect(() => backend.getPreference()).toThrow(); options.manager = original
    options.assertOwners = () => { throw new Error('Wrong native tray/profile identity') }; expect(() => backend.getPreference()).toThrow()
  })
  it('bounds sixteen admitted requests and joins their fenced work during shutdown without applying queued writes', async () => {
    const setter = vi.spyOn(db, 'setSetting'), pending = Array.from({ length: TRAY_PREFERENCE_LIMITS.requests }, () => call('app:setMinimizeToTray', [true]).catch(error => error))
    const overflow = call('app:getMinimizeToTray', []).catch(error => error); await Promise.resolve(); expect(backend.inflightCount).toBe(TRAY_PREFERENCE_LIMITS.requests)
    backend.shutdown(); expect(await overflow).toMatchObject({ code: 'BACKPRESSURE' }); await backend.close()
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: 'CANCELLED' })
    expect(backend.inflightCount).toBe(0); expect(setter).not.toHaveBeenCalled(); expect(db.db.open).toBe(true)
    await expect(call('app:getMinimizeToTray', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
