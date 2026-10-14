import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from './agent-manager-core'
import { ProductionUiOwner, assertUiStateReferences, assertUiCommandReferences, type NativeUiSnapshot, type UiReferenceGrants, type UiRequestControls } from './production-ui-owner'
import type { UiStateSnapshot } from '../shared/ui-commands'
import { ServiceProtocolError } from '../shared/service-protocol'

let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, ui: ProductionUiOwner, state: UiStateSnapshot
let nativeState: NativeUiSnapshot, current: boolean, authorized: boolean, releases: Array<() => void>
let snapshot: ReturnType<typeof vi.fn<() => Promise<NativeUiSnapshot>>>, send: ReturnType<typeof vi.fn<ConstructorParameters<typeof ProductionUiOwner>[0]['native']['send']>>
const grants: UiReferenceGrants = { canAccessProject: () => true, canAccessTask: () => true, canAccessAgent: () => true }
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const controls = (): UiRequestControls => ({ signal: new AbortController().signal, beforeEffect: () => { if (!authorized) throw new ServiceProtocolError('INVALID_REQUEST') } })
beforeEach(() => {
  db = createPortableTestDb(); current = true; authorized = true; releases = []; nativeState = { available: true, leaseId: 'lease:one' }
  manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
  const project = db.createProject({ name: 'UI project' })!, agent = db.createAgent({ name: 'UI agent' })!, task = db.createTask({ title: 'Meaningful change', project_id: project.id })!
  db.updateTask(task.id, { agent_id: agent.id })
  state = { view: 'canvas', projectId: project.id, modal: null, selectedTaskId: task.id, selectedTaskTitle: task.title, dashboardPreviewTaskId: null, captainOpen: false, settingsTab: null, waitingForYou: false, visibleTaskIds: [task.id], canvas: { viewport: { x: 0, y: 0, zoom: 1 }, panels: [{ panelId: 'panel_one', type: 'task', taskId: task.id, title: task.title, x: 10, y: 20, width: 600, height: 400 }] } }
  snapshot = vi.fn(async () => nativeState); send = vi.fn(async (_command, leaseId) => ({ ok: true as const, leaseId }))
  ui = new ProductionUiOwner({ database: db, manager, native: { snapshot, send }, assertCurrent: () => { if (!current || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, beforeState: value => assertUiStateReferences(db, value, grants), beforeCommand: command => assertUiCommandReferences(db, command, grants) })
})
afterEach(async () => { for (const release of releases) release(); await ui.close(); await manager.stopAllSessions(); const root = dirname(dirname(db.getWorkspaceDir('cleanup'))); db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
describe('real DB and captured native UI acknowledgement owner', () => {
  it('publishes only the current native document and clears on hidden/replaced documents', async () => {
    expect(await ui.snapshot()).toEqual({ available: false })
    await ui.publish(state, 'lease:one', controls())
    expect(await ui.snapshot()).toMatchObject({ ...state, available: true })
    nativeState = { available: false }; expect(await ui.snapshot()).toEqual({ available: false })
    nativeState = { available: true, leaseId: 'lease:two' }; expect(await ui.snapshot()).toEqual({ available: false })
    await expect(ui.publish(state, 'lease:one', controls())).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await ui.publish(state, 'lease:two', controls()); expect(await ui.snapshot()).toMatchObject({ available: true })
  })
  it('waits actual acknowledgement and reports accepted intent without an applied claim', async () => {
    const held = gate<{ ok: true; leaseId: string }>(); send.mockImplementationOnce(() => held.promise); releases.push(() => held.resolve({ ok: true, leaseId: 'lease:one' }))
    const pending = ui.send({ kind: 'switch_project', projectId: state.projectId }, controls()); let settled = false; void pending.finally(() => { settled = true })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1)); expect(settled).toBe(false); expect(ui.inflightCount).toBe(1)
    held.resolve({ ok: true, leaseId: 'lease:one' }); expect(await pending).toEqual({ success: true, command: 'switch_project', accepted: true })
  })
  it('does not redirect a snapshot-derived command to a replacement document or replay accepted work', async () => {
    await ui.publish(state, 'lease:one', controls()); await ui.snapshot(); const receipt = ui.observedLeaseId!
    nativeState = { available: true, leaseId: 'lease:two' }
    expect(await ui.send({ kind: 'open_task', taskId: state.selectedTaskId!, where: 'canvas' }, controls(), receipt)).toHaveProperty('error'); expect(send).not.toHaveBeenCalled()
    const held = gate<{ ok: true; leaseId: string }>(); send.mockImplementationOnce(() => held.promise); releases.push(() => held.resolve({ ok: true, leaseId: 'lease:two' }))
    const pending = ui.send({ kind: 'open_task', taskId: state.selectedTaskId!, where: 'canvas' }, controls())
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1)); nativeState = { available: true, leaseId: 'lease:three' }; held.resolve({ ok: true, leaseId: 'lease:two' })
    expect(await pending).toHaveProperty('error'); expect(send).toHaveBeenCalledTimes(1); expect(await ui.snapshot()).toEqual({ available: false })
  })
  it('retains ignored cancellation through raw native close and supports a bounded drain retry', async () => {
    const held = gate<{ ok: true; leaseId: string }>(); send.mockImplementationOnce(() => held.promise); releases.push(() => held.resolve({ ok: true, leaseId: 'lease:one' }))
    const request = new AbortController(), pending = ui.send({ kind: 'navigate', view: 'dashboard' }, { beforeEffect: () => {}, signal: request.signal })
    const failure = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1)); request.abort()
    await expect(ui.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(ui.inflightCount).toBe(1)
    held.resolve({ ok: true, leaseId: 'lease:one' }); await failure; await ui.close(); expect(ui.inflightCount).toBe(0); expect(send).toHaveBeenCalledTimes(1)
  })
  it('fences late publication/revoked reads and retains the original physical owner identity', async () => {
    const held = gate<NativeUiSnapshot>(); snapshot.mockImplementationOnce(() => held.promise); releases.push(() => held.resolve({ available: true, leaseId: 'lease:one' }))
    const publish = ui.publish(state, 'lease:one', controls()), failure = expect(publish).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    authorized = false; held.resolve({ available: true, leaseId: 'lease:one' }); await failure
    authorized = true; expect(await ui.snapshot()).toEqual({ available: false })
    await ui.publish(state, 'lease:one', controls())
    db.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(db.createProject({ name: 'Reassigned project' })!.id, state.selectedTaskId)
    await expect(ui.snapshot()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(() => ui.assertOwners({ database: {} as never, manager })).toThrow()
  })
  it('discards older native snapshots and refuses malformed/private acknowledgement data', async () => {
    const held = gate<NativeUiSnapshot>(); snapshot.mockImplementationOnce(() => held.promise); releases.push(() => held.resolve({ available: true, leaseId: 'lease:one' }))
    const pending = ui.snapshot(), failure = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    nativeState = { available: true, leaseId: 'lease:two' }; expect(await ui.snapshot()).toEqual({ available: false })
    held.resolve({ available: true, leaseId: 'lease:one' }); await failure; expect(ui.observedLeaseId).toBe('lease:two')
    send.mockResolvedValueOnce({ ok: false, detail: 'private provider/path diagnostics' }); expect(await ui.send({ kind: 'navigate', view: 'dashboard' })).toEqual({ error: 'The window could not accept the command' })
    send.mockResolvedValueOnce({ ok: true, leaseId: 'foreign' }); await expect(ui.send({ kind: 'navigate', view: 'dashboard' })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    for (const detail of ['bad\0detail', '\ud800', 'x'.repeat(257)]) {
      send.mockResolvedValueOnce({ ok: false, detail }); await expect(ui.send({ kind: 'navigate', view: 'dashboard' })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    }
    send.mockRejectedValueOnce(new Error('private secret')); await expect(ui.send({ kind: 'navigate', view: 'dashboard' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})
