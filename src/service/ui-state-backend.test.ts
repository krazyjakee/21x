import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { ProductionUiOwner, assertUiStateReferences, assertUiCommandReferences, type NativeUiSnapshot } from '../main/production-ui-owner'
import type { UiStateSnapshot } from '../shared/ui-commands'
import { UI_DESKTOP_CODECS } from '../shared/ui-desktop-codecs'
import { ServiceProtocolError } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { UiStateBackend, type UiStateBackendOptions } from './ui-state-backend'

let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, ui: ProductionUiOwner, backend: UiStateBackend, options: UiStateBackendOptions, state: UiStateSnapshot
let native: NativeUiSnapshot, releases: Array<() => void>, snapshot: ReturnType<typeof vi.fn<() => Promise<NativeUiSnapshot>>>
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'ui-epoch', webviewId: 'main', origin: 'app://ui', uiLeaseId: 'lease:one' }
beforeEach(() => {
  releases = []; db = createPortableTestDb(); native = { available: true, leaseId: 'lease:one' }
  manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
  const project = db.createProject({ name: 'Scoped UI project' })!, agent = db.createAgent({ name: 'Scoped UI agent' })!, task = db.createTask({ title: 'Readable task title', project_id: project.id })!
  db.updateTask(task.id, { agent_id: agent.id })
  state = { view: 'dashboard', projectId: project.id, modal: null, selectedTaskId: task.id, selectedTaskTitle: task.title, dashboardPreviewTaskId: task.id, captainOpen: false, settingsTab: null, waitingForYou: false, visibleTaskIds: [task.id], canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [{ panelId: 'panel_one', type: 'task', taskId: task.id, title: task.title, x: 0, y: 0, width: 600, height: 400 }] } }
  snapshot = vi.fn(async () => native)
  const grants = { canAccessProject: () => true, canAccessTask: () => true, canAccessAgent: () => true }
  ui = new ProductionUiOwner({ database: db, manager, native: { snapshot, send: async (_command, leaseId) => ({ ok: true, leaseId }) }, assertCurrent: () => { if (!db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, beforeState: value => assertUiStateReferences(db, value, grants), beforeCommand: command => assertUiCommandReferences(db, command, grants) })
  options = { database: db, manager, ui, engineEpoch: caller.engineEpoch,
    assertAvailable: () => { if (!db.db.open) throw new ServiceProtocolError('DISCONNECTED') },
    assertUiOwners: actual => { if (actual.database !== db || actual.manager !== manager || actual.ui !== ui) throw new ServiceProtocolError('DISCONNECTED') },
    isTrustedDesktop: identity => identity.webviewId === caller.webviewId && identity.origin === caller.origin,
    canPublishUi: () => true, canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true }
  backend = new UiStateBackend(options)
})
afterEach(async () => { for (const release of releases) release(); await backend.close(); await ui.close(); await manager.stopAllSessions(); const root = dirname(dirname(db.getWorkspaceDir('cleanup'))); db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
function publish(identity = caller, signal = new AbortController().signal) { return backend.registry.invoke('ui:publishState', UI_DESKTOP_CODECS['ui:publishState'].encodeArguments([{ ...state }]), identity, signal) }
function heldSnapshot() {
  let resolve!: (value: NativeUiSnapshot) => void
  const promise = new Promise<NativeUiSnapshot>(done => { resolve = done }); snapshot.mockImplementationOnce(() => promise)
  releases.push(() => resolve(native)); return resolve
}
describe('actual protected-profile UI state publication', () => {
  it('returns the legacy undefined result only after native document lease verification', async () => {
    expect(await publish()).toEqual({ defined: false }); expect(await ui.snapshot()).toMatchObject({ ...state, available: true })
    native = { available: false }; expect(await ui.snapshot()).toEqual({ available: false })
    await expect(publish()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
  it('requires independent publish and entity read grants plus trusted current ingress identity', async () => {
    for (const identity of [{ ...caller, uiLeaseId: undefined }, { ...caller, uiLeaseId: 'forged' }, { ...caller, webviewId: 'untrusted' }, { ...caller, principal: 'service' as const }]) await expect(publish(identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(publish({ ...caller, engineEpoch: 'old-epoch' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    options.canPublishUi = () => false; await expect(publish()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canPublishUi = () => true
    for (const key of ['canAccessProject','canAccessTask','canAccessAgent'] as const) {
      options[key] = () => false; await expect(publish()).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); options[key] = () => true
    }
    expect(await ui.snapshot()).toEqual({ available: false })
  })
  it('bounds actual scalar references without materializing large unrelated task/config JSON', async () => {
    const agentId = (db.db.prepare('SELECT agent_id FROM tasks WHERE id=?').get(state.selectedTaskId) as { agent_id: string }).agent_id
    db.db.prepare('UPDATE agents SET config=? WHERE id=?').run('{malformed' + 'x'.repeat(2 * 1024 * 1024), agentId)
    db.db.prepare('UPDATE tasks SET description=? WHERE id=?').run('x'.repeat(2 * 1024 * 1024), state.selectedTaskId)
    const taskGetter = vi.spyOn(db, 'getTask'), agentGetter = vi.spyOn(db, 'getAgent'), projectGetter = vi.spyOn(db, 'getProject')
    expect(await publish()).toEqual({ defined: false }); expect(await ui.snapshot()).toMatchObject({ available: true })
    expect(taskGetter).not.toHaveBeenCalled(); expect(agentGetter).not.toHaveBeenCalled(); expect(projectGetter).not.toHaveBeenCalled()
    db.db.prepare('UPDATE tasks SET role=? WHERE id=?').run('x'.repeat(1024 * 1024), state.selectedTaskId)
    await expect(publish()).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(taskGetter).not.toHaveBeenCalled()
  })
  it('rechecks revoked caller grants and moved task bindings after a native await before publication', async () => {
    let resolve = heldSnapshot(), pending = publish(), failure = expect(pending).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1)); options.canAccessTask = () => false; resolve(native); await failure
    options.canAccessTask = () => true; expect(await ui.snapshot()).toEqual({ available: false })
    resolve = heldSnapshot(); pending = publish(); failure = expect(pending).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await vi.waitFor(() => expect(backend.inflightCount).toBe(1))
    db.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(db.createProject({ name: 'Foreign project' })!.id, state.selectedTaskId)
    resolve(native); await failure; expect(await ui.snapshot()).toEqual({ available: false })
  })
  it('rejects forged state fields and retains ignored shutdown work until raw callback acknowledgement', async () => {
    await expect(backend.registry.invoke('ui:publishState', { state: { ...state, uiLeaseId: 'forged' } } as never, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(snapshot).not.toHaveBeenCalled()
    const resolve = heldSnapshot(), pending = publish(), failure = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1)); await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(backend.inflightCount).toBe(1); expect(ui.inflightCount).toBe(1)
    resolve(native); await failure; await backend.close(); expect(backend.inflightCount).toBe(0); expect(ui.inflightCount).toBe(0)
    expect(await ui.snapshot()).toEqual({ available: false })
  })
})
