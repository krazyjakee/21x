import { randomUUID } from 'node:crypto'
import { TaskAttachmentFileOwner } from '../main/task-attachment-file-owner'
import { TaskAttachmentBackend } from './task-attachment-backend'
import { AttachmentSelectionOwner } from './attachment-selection-owner'
import { TASK_ATTACHMENT_CODECS } from '../shared/task-attachment-codecs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { RecurrenceSchedulerCore } from '../main/recurrence-scheduler-core'
import { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import { TaskAutomationScheduler } from '../main/task-automation-scheduler'
import { SyncManager } from '../main/sync-manager'
import { PluginRegistry } from '../main/plugins/registry'
import { setTaskAutomationTrigger, setTaskSchedulers } from '../main/task-updates'
import { TaskLifecycleBackend, type TaskLifecycleBackendOptions } from './task-lifecycle-backend'
import { TASK_LIFECYCLE_CODECS, type TaskLifecycleCodec, type TaskLifecycleOperation } from '../shared/task-lifecycle-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'
import type { FileAttachmentRecord } from '../main/database/types'
import { TaskStatus } from '../shared/constants'

let attachments: TaskAttachmentBackend, files: TaskAttachmentFileOwner, selections: AttachmentSelectionOwner, attachmentRoot: string
let releases: Array<() => void>

let db: ReturnType<typeof createPortableTestDb>
let manager: AgentManager
let adapter: FakeAdapter
let recurrence: RecurrenceSchedulerCore
let heartbeat: HeartbeatSchedulerCore
let automation: TaskAutomationScheduler
let sync: SyncManager
let backend: TaskLifecycleBackend
let options: TaskLifecycleBackendOptions
let events: Array<{ operation: string; payload: JsonValue }>
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'task-epoch', webviewId: 'main', origin: 'app://tasks' }
beforeEach(() => {
  releases = []; db = createPortableTestDb(); adapter = new FakeAdapter(); events = []
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  manager = new AgentManager(db, host)
  recurrence = new RecurrenceSchedulerCore(db, 'UTC'); heartbeat = new HeartbeatSchedulerCore(db, manager); automation = new TaskAutomationScheduler(db, manager)
  setTaskSchedulers({ recurrence, heartbeat }); setTaskAutomationTrigger(() => { void automation.runNow() }, automation)
  const registry = new PluginRegistry()
  sync = new SyncManager(db, registry)
  options = { database: db, manager, sync, registry, recurrence, heartbeat, automation, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed profile') }, isTrustedDesktop: value => value.webviewId === 'main' && value.origin === caller.origin,
    canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true, canAccessSource: () => true,
    emit(operation, payload) { events.push({ operation, payload }) }, onFatalEvent: vi.fn() }
  backend = new TaskLifecycleBackend(options)
  const root = dirname(dirname(db.getWorkspaceDir('fixture')))
  attachmentRoot = join(root, 'attachments'); mkdirSync(attachmentRoot)
  files = new TaskAttachmentFileOwner({ attachmentRoot, assertCurrent: options.assertAvailable })
  selections = new AttachmentSelectionOwner({
    read: async request => ({ data: Buffer.alloc(request.length, 7).toString('base64') }),
    finish: async () => ({ verified: true }), retire: async () => ({ retired: true })
  }, options.assertAvailable)
  attachments = new TaskAttachmentBackend({ ...options, files, selections, attachmentRoot, onTaskUpdated() {},
    assertTaskAttachmentOwners(value) { expect(value.database).toBe(db); expect(value.manager).toBe(manager); expect(value.files).toBe(files); expect(value.attachmentRoot).toBe(attachmentRoot) } })
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const release of releases) release()
  await attachments?.close(); await selections.close(); await files.close(); await backend.close(); await automation.close(); await recurrence.close(); await heartbeat.close(); await sync.close(); await manager.stopAllSessions()
  setTaskSchedulers({ recurrence: null, heartbeat: null }); setTaskAutomationTrigger(null)
  const root = dirname(dirname(db.getWorkspaceDir('cleanup-fixture')))
  db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends TaskLifecycleOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = TASK_LIFECYCLE_CODECS[operation] as TaskLifecycleCodec<K>
  const result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(result)).toBe(true)
  return codec.decodeResult((result as { defined: boolean; value?: JsonValue }).value)
}
function record(filename = 'kept.txt'): FileAttachmentRecord {
  return { id: randomUUID(), filename, size: 3, mime_type: 'text/plain', added_at: '2026-10-18T00:00:00.000Z' }
}
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); releases.push(release); return { promise, release } }
async function live() {
  const first = db.createAgent({ name: 'Original attachment task owner', config: { coding_agent: 'opencode' } })!
  const next = db.createAgent({ name: 'Replacement attachment task owner', config: { coding_agent: 'opencode' } })!
  const task = await call('db:createTask', [{ title: 'Actual live attachment task' }])
  db.updateTask(task.id, { agent_id: first.id })
  expect((await manager.requestSession(first.id, task.id)).status).toBe('started')
  return { task: db.getTask(task.id)!, next }
}
describe('actual Source attachment metadata conflict', () => {
  it('does not overwrite a separately accepted append with a stale full-array append', async () => {
    const task = await call('db:createTask', [{ title: 'Two independent attachment editors' }])
    const identity = { ...caller, uiLeaseId: 'ui_attachment_metadata_conflict' }
    const firstSnapshot = await call('db:getTask', [task.id])
    const secondSnapshot = await call('db:getTask', [task.id])
    expect(firstSnapshot?.attachments).toEqual([])
    expect(secondSnapshot?.attachments).toEqual([])
    async function copy(filename: string) {
      const path = `/controlled-selection/${filename}`
      expect(selections.offer({ leaseId: identity.uiLeaseId, selections: [{ selectionId: randomUUID(), path, filename, size: 3 }] })).toEqual({ accepted: true })
      const codec = TASK_ATTACHMENT_CODECS['attachments:save']
      const wire = await attachments.registry.invoke('attachments:save', codec.encodeArguments([task.id, path]), identity, new AbortController().signal)
      expect(codec.validateWireResult(wire)).toBe(true)
      const record = codec.decodeResult((wire as { value: JsonValue }).value)
      expect(readFileSync(join(attachmentRoot, task.id, `${record.id}-${record.filename}`))).toEqual(Buffer.alloc(3, 7))
      return record
    }
    const first = await copy('first.txt'), second = await copy('second.txt')
    // Real native-selection imports acknowledge protected copies and leave task metadata unchanged.
    expect((await call('db:getTask', [task.id]))?.attachments).toEqual([])
    const accepted = await call('db:updateTask', [task.id, { attachments: [...firstSnapshot!.attachments, first] }, { attachmentsBaseline: firstSnapshot!.attachments }])
    expect(accepted?.attachments).toEqual([first])
    const beforeEvents = events.length
    await expect(call('db:updateTask', [task.id, { attachments: [...secondSnapshot!.attachments, second] }, { attachmentsBaseline: secondSnapshot!.attachments }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await call('db:getTask', [task.id]))?.attachments).toEqual([first])
    expect(events).toHaveLength(beforeEvents)
    // Both accepted destination copies survive the refused metadata write.
    for (const record of [first, second]) expect(readFileSync(join(attachmentRoot, task.id, `${record.id}-${record.filename}`))).toEqual(Buffer.alloc(3, 7))
  })
  it('preserves explicit removal and order changes, with property-order-independent canonical equality', async () => {
    const first = record('first.txt'), second = record('second.txt')
    const task = await call('db:createTask', [{ title: 'Explicit metadata replacement', attachments: [first, second] }])
    const reordered = Object.fromEntries(Object.entries(first).reverse()) as unknown as FileAttachmentRecord
    const result = await call('db:updateTask', [task.id, { attachments: [second, first] }, { attachmentsBaseline: [reordered, second] }])
    expect(result?.attachments).toEqual([second, first])
    expect((await call('db:updateTask', [task.id, { attachments: [first] }, { attachmentsBaseline: [second, first] }]))?.attachments).toEqual([first])
    expect((await call('db:updateTask', [task.id, { attachments: [] }, { attachmentsBaseline: [first] }]))?.attachments).toEqual([])
    expect(db.db.prepare('PRAGMA table_info(tasks)').all()).not.toContainEqual(expect.objectContaining({ name: 'precondition' }))
    expect(JSON.stringify(events)).not.toMatch(/attachmentsBaseline|precondition/)
  })

  it('compares all canonical fields and order before stopping or writing to an actual live owner', async () => {
    const { task, next } = await live(), first = record(), second = record('other.txt')
    db.updateTask(task.id, { attachments: [first, second] })
    const stop = vi.spyOn(manager, 'stopByTaskId'), write = vi.spyOn(db, 'updateTask'), before = events.length
    const heartbeatChange = vi.spyOn(heartbeat, 'enableHeartbeat'), recurrenceChange = vi.spyOn(recurrence, 'initializeRecurringTask'), automationChange = vi.spyOn(automation, 'runNow')
    const variants = [
      [{ ...first, id: randomUUID() }, second], [{ ...first, filename: 'renamed.txt' }, second],
      [{ ...first, size: 4 }, second], [{ ...first, mime_type: 'application/octet-stream' }, second],
      [{ ...first, added_at: '2026-10-17T00:00:00.000Z' }, second], [second, first], [first]
    ]
    for (const attachmentsBaseline of variants)
      await expect(call('db:updateTask', [task.id, { attachments: [], agent_id: next.id, heartbeat_enabled: true }, { attachmentsBaseline }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(stop).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(events).toHaveLength(before)
    expect(heartbeatChange).not.toHaveBeenCalled(); expect(recurrenceChange).not.toHaveBeenCalled(); expect(automationChange).not.toHaveBeenCalled()
    expect(adapter.destroySession).not.toHaveBeenCalled(); expect(manager.findSessionByTaskId(task.id)).toBeDefined()
  })

  it('requires a baseline before any actual Stop and keeps ordinary field-only writes available', async () => {
    const { task, next } = await live(), stop = vi.spyOn(manager, 'stopByTaskId')
    await expect(backend.registry.invoke('db:updateTask', { id: task.id, data: { attachments: [], agent_id: next.id } }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(stop).not.toHaveBeenCalled(); expect(adapter.destroySession).not.toHaveBeenCalled()
    expect((await call('db:updateTask', [task.id, { description: 'A field-only edit' }]))?.description).toBe('A field-only edit')
    expect(manager.findSessionByTaskId(task.id)).toBeDefined()
  })

  it('preserves the real task mutation exclusion and rejects stale baseline after its owner completes', async () => {
    const { task } = await live(), gate = held(), first = record('first.txt'), second = record('second.txt')
    adapter.destroySession.mockImplementationOnce(async () => { await gate.promise })
    const a = call('db:updateTask', [task.id, { attachments: [first], status: TaskStatus.NotStarted }, { attachmentsBaseline: [] }])
    await vi.waitFor(() => expect(adapter.destroySession).toHaveBeenCalledOnce())
    // The existing manager rejects overlapping mutations; it does not queue them.
    await expect(call('db:updateTask', [task.id, { attachments: [second] }, { attachmentsBaseline: [] }])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(db.getTask(task.id)?.attachments).toEqual([])
    gate.release(); expect((await a)?.attachments).toEqual([first])
    await expect(call('db:updateTask', [task.id, { attachments: [second] }, { attachmentsBaseline: [] }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTask(task.id)?.attachments).toEqual([first])
    expect(events.filter(event => event.operation === 'task:updated')).toHaveLength(1)
  })

  it('rechecks metadata immediately before write after an acknowledged raw Stop', async () => {
    const { task } = await live(), gate = held(), changed = record('concurrent.txt')
    adapter.destroySession.mockImplementationOnce(async () => { await gate.promise })
    const update = call('db:updateTask', [task.id, { attachments: [], status: TaskStatus.NotStarted }, { attachmentsBaseline: [] }]).catch(error => error)
    await vi.waitFor(() => expect(adapter.destroySession).toHaveBeenCalledOnce())
    // A trusted separate writer bypasses this task lock while raw Stop is held.
    db.updateTask(task.id, { attachments: [changed] })
    const before = events.length
    gate.release(); expect(await update).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getTask(task.id)?.attachments).toEqual([changed]); expect(events).toHaveLength(before)
    expect(adapter.destroySession).toHaveBeenCalledOnce()
  })

  it.each(['cancel', 'scope'] as const)('retains request %s fences across raw Stop before metadata persistence', async mode => {
    const { task } = await live(), gate = held(), abort = new AbortController()
    adapter.destroySession.mockImplementationOnce(async () => { await gate.promise })
    const update = call('db:updateTask', [task.id, { attachments: [record()], status: TaskStatus.NotStarted }, { attachmentsBaseline: [] }], abort.signal).catch(error => error)
    await vi.waitFor(() => expect(adapter.destroySession).toHaveBeenCalledOnce())
    if (mode === 'cancel') abort.abort()
    else options.canAccessTask = () => false
    gate.release()
    expect(await update).toMatchObject({ code: mode === 'cancel' ? 'CANCELLED' : 'INVALID_REQUEST' })
    expect(db.getTask(task.id)?.attachments).toEqual([])
    expect(events.filter(event => event.operation === 'task:updated')).toHaveLength(0)
  })

  it('rejects old-epoch metadata admission before stopping or persisting', async () => {
    const { task } = await live()
    await expect(call('db:updateTask', [task.id, { attachments: [], status: TaskStatus.NotStarted }, { attachmentsBaseline: [] }], undefined, { ...caller, engineEpoch: 'retired-epoch' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    expect(adapter.destroySession).not.toHaveBeenCalled()
    expect(events.filter(event => event.operation === 'task:updated')).toHaveLength(0)
  })
})
