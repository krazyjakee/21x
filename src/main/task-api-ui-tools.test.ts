import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handleRoute, setTaskApiNotifier, setTaskApiUiState } from './task-api-server-core'
import { setTaskApiUiOwner } from './task-api/state'
import { ProductionUiOwner, assertUiStateReferences, assertUiCommandReferences, type NativeUiSnapshot, type NativeUiAcknowledgement } from './production-ui-owner'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from './agent-manager-core'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import type { UiStateSnapshot } from '../shared/ui-commands'
import type { TaskMcpScope } from './mcp-servers/task-management-core'
import { UI_COMMAND_CHANNEL } from '../shared/ui-commands'
import type { TaskRecord } from './database'

/**
 * The tools that drive the window.
 *
 * The rule these tests protect: a command that reaches no window is a failure.
 * An agent told "done" would go on to describe a screen the user never saw.
 */

vi.mock('./artifacts', () => ({
  createRegisteredTaskArtifact: vi.fn(),
  editRegisteredTaskArtifactFile: vi.fn(),
  readRegisteredTaskArtifactFile: vi.fn(),
  writeRegisteredTaskArtifactFile: vi.fn(),
  listRegisteredTaskArtifacts: vi.fn(async () => [
    { artifactId: 'art-1', taskId: 't1', title: 'Design', type: 'markdown', files: ['design.md'], createdAt: 1, updatedAt: 2 },
  ]),
}))

const handle = (route: string, params: Record<string, unknown> = {}): Promise<unknown> =>
  handleRoute(makeDb() as never, route, params)

function makeDb() {
  const task = { id: 't1', title: 'Fix login' } as TaskRecord
  return {
    getTask: vi.fn((id: string) => (id === 't1' ? task : undefined)),
    getWorkspaceDir: vi.fn(() => '/tmp/workspace/t1'),
  }
}

let sent: Array<{ channel: string; data: unknown }>

/** A window is open, showing `view`. */
function windowShowing(view: string): void {
  setTaskApiUiState({ view })
}

beforeEach(() => {
  setTaskApiUiOwner(null)
  sent = []
  setTaskApiNotifier((channel, data) => sent.push({ channel, data }))
  windowShowing('tasks')
})

const productionCleanups: Array<() => Promise<void>> = []
afterEach(async () => { setTaskApiUiOwner(null); for (const close of productionCleanups.splice(0)) await close(); vi.restoreAllMocks() })
async function productionWindow() {
  const db = createPortableTestDb(), manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
  const project = db.createProject({ name: 'Window project' })!, task = db.createTask({ title: 'Actual change', project_id: project.id })!
  const native = { state: { available: true, leaseId: 'lease:one' } as NativeUiSnapshot }
  const snapshot = vi.fn(async () => native.state), send = vi.fn(async (_command: unknown, leaseId: string): Promise<NativeUiAcknowledgement> => ({ ok: true, leaseId }))
  const grants = { canAccessProject: () => true, canAccessTask: () => true, canAccessAgent: () => true }
  const ui = new ProductionUiOwner({ database: db, manager, native: { snapshot, send }, assertCurrent: () => {}, beforeState: state => assertUiStateReferences(db,state,grants), beforeCommand: command => assertUiCommandReferences(db,command,grants) })
  const state: UiStateSnapshot = { view: 'tasks', projectId: project.id, modal: null, selectedTaskId: task.id, selectedTaskTitle: task.title, dashboardPreviewTaskId: null, captainOpen: false, settingsTab: null, waitingForYou: false, visibleTaskIds: [task.id] }
  const releases: Array<() => void> = []
  productionCleanups.push(async () => { for (const release of releases) release(); await ui.close(); await manager.stopAllSessions(); const root = dirname(dirname(db.getWorkspaceDir('cleanup'))); db.close(); rmSync(root,{ recursive:true,force:true }) })
  setTaskApiUiOwner(ui); await ui.publish(state,'lease:one',{ beforeEffect: () => {},signal: new AbortController().signal })
  const handle = (route: string, params: Record<string,unknown> = {}, scope?: TaskMcpScope) => handleRoute(db,route,params,scope)
  return { db,project,task,ui,state,native,snapshot,send,handle,releases }
}
describe('production task API UI ownership', () => {
  it('uses native state and acknowledgement without generic notification or an applied claim', async () => {
    const p = await productionWindow(); windowShowing('dashboard')
    const getter = vi.spyOn(p.db,'getTask')
    expect(await p.handle('/get_ui_state')).toMatchObject({ available:true,view:'tasks',projectId:p.project.id })
    expect(await p.handle('/open_task',{ task_id:p.task.id })).toEqual({ success:true,command:'open_task',accepted:true,where:'workspace',task_title:p.task.title })
    expect(p.send).toHaveBeenCalledWith({ kind:'open_task',taskId:p.task.id,where:'workspace' },'lease:one',expect.any(AbortSignal))
    expect(getter).not.toHaveBeenCalled(); expect(sent).toHaveLength(0)
    p.native.state={available:false}; expect(await p.handle('/get_ui_state')).toEqual({available:false})
    expect(await p.handle('/navigate',{view:'tasks'})).toEqual({error:'No 21x window is open'})
    expect(p.send).toHaveBeenCalledTimes(1); expect(sent).toHaveLength(0)
  })
  it('waits ignored native work, redacts failure details and never retries a stale acceptance', async () => {
    const p = await productionWindow(); let resolve!: (value: NativeUiAcknowledgement) => void
    const held = new Promise<NativeUiAcknowledgement>(done => { resolve=done }); p.releases.push(()=>resolve({ok:true,leaseId:'lease:one'})); p.send.mockImplementationOnce(()=>held)
    const pending=p.handle('/navigate',{view:'tasks'}); let settled=false; void pending.then(()=>{settled=true})
    await vi.waitFor(()=>expect(p.send).toHaveBeenCalledTimes(1)); expect(settled).toBe(false)
    p.native.state={available:true,leaseId:'lease:two'}; resolve({ok:true,leaseId:'lease:one'})
    expect(await pending).toHaveProperty('error'); expect(p.send).toHaveBeenCalledTimes(1); expect(sent).toHaveLength(0)
    p.send.mockResolvedValueOnce({ok:false,detail:'private secret/path diagnostics'})
    expect(await p.handle('/navigate',{view:'dashboard'})).toEqual({error:'The window could not accept the command'})
  })
  it('refuses replacement windows before sending commands derived from the old screen', async () => {
    const p = await productionWindow()
    p.snapshot.mockResolvedValueOnce({available:true,leaseId:'lease:one'}).mockResolvedValueOnce({available:true,leaseId:'lease:two'})
    expect(await p.handle('/open_task',{task_id:p.task.id})).toEqual({error:'The window changed before the command could be sent'})
    expect(p.send).not.toHaveBeenCalled(); expect(sent).toHaveLength(0)
  })
  it('honors out-of-band project scope and rereads signed nonce/task binding after native awaits', async () => {
    const p = await productionWindow(), agent=p.db.createAgent({name:'Signed task agent'})!
    p.db.updateTask(p.task.id,{agent_id:agent.id}); p.db.db.prepare('UPDATE tasks SET mcp_scope_nonce=? WHERE id=?').run('nonce-one',p.task.id)
    const scope: TaskMcpScope={parentTaskId:null,taskId:p.task.id,artifactTaskId:p.task.id,projectId:p.project.id,agentId:agent.id,sessionNonce:'nonce-one'}
    expect(await p.handle('/get_ui_state',{},scope)).toMatchObject({available:true})
    const sibling=p.db.createTask({title:'Sibling task',project_id:p.project.id})!
    expect(await p.handle('/open_task',{task_id:sibling.id},scope)).toHaveProperty('error'); expect(p.send).not.toHaveBeenCalled()
    const siblingState={...p.state,selectedTaskId:sibling.id,selectedTaskTitle:sibling.title,visibleTaskIds:[sibling.id]}
    await p.ui.publish(siblingState,'lease:one',{beforeEffect:()=>{},signal:new AbortController().signal})
    expect(await p.handle('/get_ui_state',{},scope)).toEqual({error:'The window state is unavailable'})
    expect(await p.handle('/get_ui_state',{}, {parentTaskId:null,taskId:null,artifactTaskId:p.task.id,projectId:p.project.id})).toEqual({error:'The window state is unavailable'})
    expect(await p.handle('/get_ui_state',{}, {parentTaskId:null,taskId:null,artifactTaskId:null,projectId:p.project.id})).toMatchObject({available:true})
    await p.ui.publish(p.state,'lease:one',{beforeEffect:()=>{},signal:new AbortController().signal})
    const other=p.db.createProject({name:'Foreign project'})!, foreign=p.db.createTask({title:'Foreign private task',project_id:other.id})!
    expect(await p.handle('/open_task',{task_id:foreign.id,scope:{projectId:other.id}},scope)).toHaveProperty('error'); expect(p.send).not.toHaveBeenCalled()
    await p.ui.publish({...p.state,projectId:other.id,selectedTaskId:foreign.id,selectedTaskTitle:foreign.title,visibleTaskIds:[foreign.id]},'lease:one',{beforeEffect:()=>{},signal:new AbortController().signal})
    expect(await p.handle('/get_ui_state',{},scope)).toEqual({error:'The window state is unavailable'})
    expect(await p.handle('/navigate',{view:'tasks'},scope)).toHaveProperty('error')
    await p.ui.publish(p.state,'lease:one',{beforeEffect:()=>{},signal:new AbortController().signal})
    let resolve!: (value: NativeUiSnapshot)=>void; const held=new Promise<NativeUiSnapshot>(done=>{resolve=done}); p.releases.push(()=>resolve(p.native.state))
    p.snapshot.mockImplementationOnce(()=>held); const pending=p.handle('/navigate',{view:'tasks'},scope)
    await vi.waitFor(()=>expect(p.ui.inflightCount).toBe(1)); p.db.db.prepare('UPDATE tasks SET mcp_scope_nonce=? WHERE id=?').run('nonce-two',p.task.id); resolve(p.native.state)
    expect(await pending).toEqual({error:'The window state is unavailable'}); expect(p.send).not.toHaveBeenCalled()
  })
})

describe('no window', () => {
  it('refuses every command rather than reporting a screen nobody saw', async () => {
    setTaskApiUiState(null)
    for (const [route, params] of [
      ['/navigate', { view: 'tasks' }],
      ['/open_task', { task_id: 't1' }],
      ['/open_artifact', { task_id: 't1', artifact_id: 'art-1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = (await handle(route, params)) as { error?: string }
      expect(result.error, route).toMatch(/no 21x window/i)
    }
    expect(sent).toHaveLength(0)
  })
})

describe('navigate', () => {
  it('sends the user to a view', async () => {
    const result = (await handle('/navigate', { view: 'tasks' })) as { success: boolean }
    expect(result.success).toBe(true)
    expect(sent[0]).toEqual({ channel: UI_COMMAND_CHANNEL, data: { kind: 'navigate', view: 'tasks', settingsTab: undefined } })
  })

  it('carries a settings tab', async () => {
    await handle('/navigate', { view: 'settings', settings_tab: 'voice' })
    expect(sent[0].data).toMatchObject({ view: 'settings', settingsTab: 'voice' })
  })

  it('refuses a view that does not exist, including the removed canvas', async () => {
    for (const view of ['kanban', 'canvas']) {
      const result = (await handle('/navigate', { view })) as { error?: string }
      expect(result.error, view).toMatch(/view must be one of/)
    }
    expect(sent).toHaveLength(0)
  })
})

describe('open_task', () => {
  it('opens the dialog when the user is on the dashboard, so they stay there', async () => {
    windowShowing('dashboard')
    const result = (await handle('/open_task', { task_id: 't1' })) as { where: string }
    expect(result.where).toBe('modal')
  })

  it('opens the full view from anywhere else', async () => {
    windowShowing('skills')
    const result = (await handle('/open_task', { task_id: 't1' })) as { where: string }
    expect(result.where).toBe('workspace')
  })

  it('obeys an explicit target over the open view', async () => {
    windowShowing('dashboard')
    const result = (await handle('/open_task', { task_id: 't1', where: 'workspace' })) as { where: string }
    expect(result.where).toBe('workspace')
  })

  it('refuses an unknown task and an unknown target', async () => {
    const unknownTask = (await handle('/open_task', { task_id: 'nope' })) as { error?: string }
    expect(unknownTask.error).toMatch(/not found/i)

    for (const where of ['sidebar', 'canvas']) {
      const badTarget = (await handle('/open_task', { task_id: 't1', where })) as { error?: string }
      expect(badTarget.error, where).toMatch(/where must be one of/)
    }
    expect(sent).toHaveLength(0)
  })
})

describe('removed Canvas routes', () => {
  it('no longer exist', async () => {
    for (const route of ['/move_task_panel', '/close_task_panel', '/set_canvas_view']) {
      expect(await handle(route, { task_id: 't1', x: 0, y: 0, mode: 'reset' }), route).toEqual({ error: 'Unknown route' })
    }
    expect(sent).toHaveLength(0)
  })
})

describe('open_artifact', () => {
  it('opens an artifact of that task', async () => {
    const result = (await handle('/open_artifact', { task_id: 't1', artifact_id: 'art-1' })) as { success: boolean }
    expect(result.success).toBe(true)
    expect(sent[0].data).toEqual({ kind: 'open_artifact', taskId: 't1', artifactId: 'art-1' })
  })

  it('refuses an artifact of another task, and names the real ones', async () => {
    const result = (await handle('/open_artifact', { task_id: 't1', artifact_id: 'art-9' })) as {
      error?: string
      artifacts?: Array<{ artifact_id: string }>
    }
    expect(result.error).toMatch(/artifact not found/i)
    expect(result.artifacts?.[0].artifact_id).toBe('art-1')
    expect(sent).toHaveLength(0)
  })
})
