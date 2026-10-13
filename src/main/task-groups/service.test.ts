import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../../test/helpers/fake-adapter'
import { AgentManager } from '../agent-manager-core'
import type { AgentManagerHost } from '../agent-manager/host'
import { SessionStatusType } from '../adapters/coding-agent-adapter'
import { TaskStatus } from '../../shared/constants'
import { SyncManager } from '../sync-manager'
import type { PluginRegistry } from '../plugins/registry'
import type { TaskRecord } from '../database'
import { TaskGroupService } from './service'

vi.mock('../agent-manager/workspace-docs', async original => ({
  ...await original<typeof import('../agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined)
}))
type Session = NonNullable<ReturnType<AgentManager['getSession']>>
type Internals = { transitionToIdle(id: string, session: Session): Promise<void>; countedSessions(): unknown[] }
const resources: Array<{ db: ReturnType<typeof createPortableTestDb>; manager: AgentManager; sync: SyncManager; directory: string }> = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.manager.stopAllSessions(); await resource.sync.close(); resource.db.close()
    rmSync(resource.directory, { recursive: true, force: true })
  }
  vi.useRealTimers(); vi.restoreAllMocks()
})

async function fixture(withSource = false) {
  const db = createPortableTestDb()
  const agent = db.createAgent({ name: 'Group fixture', config: { coding_agent: 'codex', model: 'fixture', max_parallel_sessions: 1 } })!
  const project = db.createProject({ name: 'Group project', default_agent_id: agent.id })!
  const source = withSource ? db.createTaskSource({ name: 'Fixture source', plugin_id: 'fixture', mcp_server_id: null, project_id: project.id }) : undefined
  const members = ['First small change', 'Second small change'].map(title => {
    const task = db.createTask({ title, description: `Exact instructions for ${title}`, project_id: project.id, source_id: source?.id })!
    db.updateTask(task.id, { agent_id: agent.id }); return db.getTask(task.id)!
  })
  const adapter = new FakeAdapter({ status: SessionStatusType.BUSY, sessionIds: ['group-native-one', 'group-native-two'] })
  const native: Array<{ channel: string; data: Record<string, unknown> }> = []
  const host: AgentManagerHost = { renderer: { kind: 'native', send(_target, channel, ...args) { native.push({ channel, data: args[0] as Record<string, unknown> }); return true } },
    notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => true }
  const manager = new AgentManager(db, host)
  manager.setMainWindow({ isDestroyed: () => false, isFocused: () => true, show() {}, focus() {}, webContents: { send() {} } })
  const execute = vi.fn(async (_action: string, _task: TaskRecord) => ({ success: true, taskUpdate: { status: TaskStatus.Completed } }))
  const sync = new SyncManager(db, { get: () => ({ executeAction: execute }) } as unknown as PluginRegistry)
  manager.setSyncManager(sync)
  const service = new TaskGroupService(db, manager, sync)
  const group = await service.create({ title: 'Small related changes', task_ids: members.map(task => task.id) })
  const directory = dirname(dirname(db.getWorkspaceDir(group.execution_task_id)))
  resources.push({ db, manager, sync, directory })
  const internal = manager as unknown as Internals
  const finish = async () => {
    const live = manager.findSessionByTaskId(group.execution_task_id)!
    adapter.setStatus(SessionStatusType.IDLE)
    await internal.transitionToIdle(live.sessionId, live.session)
    return live
  }
  return { db, manager, adapter, service, group, members, agent, project, execute, native, internal, finish, sync }
}

describe('task-group session and review authority', () => {
  it('routes simultaneous member starts through one counted backend and lists every member in its initial prompt', async () => {
    const h = await fixture()
    const [one, two] = await Promise.all(h.members.map(member => h.manager.startTask(member.id)))
    expect(one.sessionId).toBe(two.sessionId)
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(h.internal.countedSessions()).toHaveLength(1)
    const prompt = h.adapter.sendPrompt.mock.calls[0][1][0].text!
    for (const member of h.members) {
      expect(prompt).toContain(member.id); expect(prompt).toContain(member.title); expect(prompt).toContain(member.description)
      expect(h.db.getTask(member.id)).toMatchObject({ status: TaskStatus.AgentWorking, session_id: null })
    }
    expect(prompt).toContain('report_group_task')
    expect(h.db.getTask(h.group.execution_task_id)?.session_id).toBe(one.sessionId)
    expect(h.db.getTasks().some(task => task.id === h.group.execution_task_id)).toBe(false)
    expect(h.native.filter(event => event.channel === 'agent:status' && event.data.status === 'working')
      .map(event => event.data.taskId)).toEqual(expect.arrayContaining([h.group.execution_task_id, ...h.members.map(task => task.id)]))
    const attachments = [{ id: 'new-attachment', filename: 'instructions.txt', size: 12, mime_type: 'text/plain' }]
    await expect(h.manager.sendByTaskId(h.members[0].id, 'New instructions', attachments)).rejects.toThrow('shared group conversation')
    await expect(h.manager.sendMessage(one.sessionId!, 'New instructions', h.members[0].id, h.agent.id, attachments)).rejects.toThrow('shared group conversation')
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
  })

  it('records blocked/done progress without approval and rejects a stopped or foreign reporter', async () => {
    const h = await fixture()
    await h.manager.startTask(h.group.execution_task_id)
    h.service.report(h.group.id, h.members[0].id, 'done', 'Verified first change', h.group.execution_task_id)
    h.service.report(h.group.id, h.members[1].id, 'blocked', 'Needs missing fixture', h.group.execution_task_id)
    expect(h.db.getTask(h.members[0].id)?.status).toBe(TaskStatus.AgentWorking)
    expect(h.service.get(h.group.id).group.progress).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'blocked' })]))
    expect(() => h.service.report(h.group.id, h.members[0].id, 'done', 'forged', h.members[0].id)).toThrow('active group execution')
    await h.manager.stopByTaskId(h.members[0].id)
    expect(() => h.service.report(h.group.id, h.members[1].id, 'done', 'late', h.group.execution_task_id)).toThrow('active group execution')
    expect(h.members.map(member => h.db.getTask(member.id)?.status)).toEqual([TaskStatus.NotStarted, TaskStatus.NotStarted])
    expect(h.adapter.destroySession).toHaveBeenCalledOnce()
  })

  it('leaves running definitions unchanged and preserves shared history when an idle member is removed', async () => {
    const h = await fixture()
    await h.manager.startTask(h.group.execution_task_id)
    await expect(h.service.remove(h.group.id, h.members[1].id)).rejects.toThrow('Stop the group')
    expect(h.adapter.destroySession).not.toHaveBeenCalled()
    const live = await h.finish()
    await h.manager.sendMessage(live.sessionId, 'Retained shared instruction', h.group.execution_task_id, h.agent.id)
    await h.finish()
    const before = h.db.getTranscriptParts(h.group.execution_task_id)
    await h.service.remove(h.group.id, h.members[1].id)
    expect(h.db.getTask(h.members[1].id)?.group_id).toBeNull()
    expect(h.service.history(h.members[1].id)[0].former_task_ids).toContain(h.members[1].id)
    expect(h.db.getTranscriptParts(h.group.execution_task_id)).toEqual(expect.arrayContaining(before))
    expect(h.db.getTranscriptParts(h.group.execution_task_id).some(part => part.partId.startsWith('session-loss-pending-'))).toBe(true)
    expect(h.db.getTask(h.group.execution_task_id)?.session_id).toBeNull()
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
  })

  it('sends back only selected members in the same session and keeps unselected review work available', async () => {
    const h = await fixture()
    await h.manager.startTask(h.group.execution_task_id); const live = await h.finish()
    await h.service.review({ group_id: h.group.id, action: 'send_back', task_ids: [h.members[0].id], message: 'Adjust the first label' })
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.db.getTask(h.group.execution_task_id)?.session_id).toBe(live.sessionId)
    expect(h.db.getTask(h.members[0].id)?.status).toBe(TaskStatus.AgentWorking)
    expect(h.db.getTask(h.members[1].id)?.status).toBe(TaskStatus.ReadyForReview)
    expect(h.adapter.sendPrompt.mock.calls.at(-1)![1][0].text).toContain('Rework only these group tasks: First small change')
    expect(h.adapter.sendPrompt.mock.calls.at(-1)![1][0].text).toContain('Adjust the first label')
  })

  it('uses actual source confirmation per member and leaves a failed source in review', async () => {
    const h = await fixture(true)
    h.execute.mockImplementation(async (_action, member) => member.id === h.members[0].id
      ? { success: true, taskUpdate: { status: TaskStatus.Completed } }
      : { success: false, error: 'Source refused completion' } as never)
    await h.manager.startTask(h.group.execution_task_id); await h.finish()
    const result = await h.service.review({ group_id: h.group.id, action: 'approve', complete_at_source: true })
    expect(h.execute).toHaveBeenCalledTimes(2)
    expect(result.completed_task_ids).toEqual([h.members[0].id])
    expect(result.failures).toEqual([{ task_id: h.members[1].id, message: 'Source refused completion' }])
    expect(h.db.getTask(h.members[0].id)?.status).toBe(TaskStatus.Completed)
    expect(h.db.getTask(h.members[1].id)?.status).toBe(TaskStatus.ReadyForReview)
    expect(result.group.status).toBe(TaskStatus.ReadyForReview)
    const local = await h.service.review({ group_id: h.group.id, action: 'approve', complete_at_source: false })
    expect(h.execute).toHaveBeenCalledTimes(2)
    expect(local.group.status).toBe(TaskStatus.Completed)
    expect(h.db.getTask(h.members[1].id)?.complete_at_source).toBe(false)
  })

  it('refuses an ordinary grouped-member source completion before any external action', async () => {
    const h = await fixture(true)
    const member = h.db.getTask(h.members[0].id)!
    const result = await h.sync.executeAction('complete', member, undefined, member.source_id!)
    expect(result).toMatchObject({ success: false })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('holds the admission fence through delayed source confirmation', async () => {
    const h = await fixture(true)
    await h.manager.startTask(h.group.execution_task_id); await h.finish()
    let resolve!: (value: { success: boolean; taskUpdate: { status: TaskStatus } }) => void
    h.execute.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const approval = h.service.review({ group_id: h.group.id, task_ids: [h.members[0].id], action: 'approve', complete_at_source: true })
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await expect(h.manager.startTask(h.members[1].id)).rejects.toThrow('being updated')
    await expect(h.manager.sendByTaskId(h.group.execution_task_id, 'Race a source completion')).rejects.toThrow('being updated')
    resolve({ success: true, taskUpdate: { status: TaskStatus.Completed } }); await approval
    expect(h.adapter.createSession).toHaveBeenCalledOnce()
    expect(h.db.getTask(h.members[1].id)?.status).toBe(TaskStatus.ReadyForReview)
  })

  it('reconciles a restarted group by its execution anchor instead of inventing member sessions', async () => {
    const h = await fixture()
    await h.manager.startTask(h.members[0].id)
    await h.manager.stopAllSessions()
    const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
      secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => h.adapter, isCodexAppServerAdapter: () => true }
    const restarted = new AgentManager(h.db, host)
    try {
      await restarted.reconcileStartup()
      expect(h.adapter.createSession).toHaveBeenCalledOnce()
      expect(h.members.map(member => h.db.getTask(member.id)?.session_id)).toEqual([null, null])
      expect(restarted.findSessionByTaskId(h.group.execution_task_id)?.sessionId).toBe('group-native-one')
      expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    } finally { await restarted.stopAllSessions() }
  })

  it('preserves equal member attachment filenames in separate shared workspace paths', async () => {
    const h = await fixture()
    for (const [index, member] of h.members.entries()) {
      const attachment = { id: `attachment-${index}`, filename: 'instructions.txt', size: 6, mime_type: 'text/plain', added_at: '2026-10-13' }
      h.db.updateTask(member.id, { attachments: [attachment] })
      writeFileSync(join(h.db.getAttachmentsDir(member.id), `${attachment.id}-${attachment.filename}`), `task-${index}`)
    }
    await h.manager.startTask(h.group.execution_task_id)
    const workspace = h.db.getWorkspaceDir(h.group.execution_task_id)
    for (const [index, member] of h.members.entries()) {
      const relative = `attachments/task-${member.id}/attachment-${index}-instructions.txt`
      expect(readFileSync(join(workspace, relative), 'utf8')).toBe(`task-${index}`)
      expect(h.adapter.sendPrompt.mock.calls[0][1][0].text).toContain(relative)
    }
  })
})
