import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { link, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { TaskAttachmentFileOwner, type TaskAttachmentFilePrimitives } from '../main/task-attachment-file-owner'
import type { FileAttachmentRecord } from '../main/database/types'
import { TASK_ATTACHMENT_CODECS, TASK_ATTACHMENT_OPERATIONS, TASK_ATTACHMENT_LIMITS, type TaskAttachmentCodec, type TaskAttachmentOperation } from '../shared/task-attachment-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { TaskAttachmentBackend, type TaskAttachmentBackendOptions } from './task-attachment-backend'
import { isAttachmentPathReceipt, type AttachmentPathReceipt } from '../shared/attachment-native-callbacks'

const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'task-attachment-fixture', webviewId: 'main', origin: 'app://task-attachments' }
const image = { name: '../写真.png', mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAQID' }
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, files: TaskAttachmentFileOwner, backend: TaskAttachmentBackend, options: TaskAttachmentBackendOptions
let root: string, attachmentRoot: string, projectId: string, ownerValid: boolean, read: boolean, write: boolean, releases: Array<() => void>, events: Array<{ taskId: string; attachments: FileAttachmentRecord[] }>
let afterOpen: (() => Promise<void>) | null, afterPublish: (() => Promise<void>) | null, fsOverride: Partial<TaskAttachmentFilePrimitives>
let fileReads: number
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture'))); attachmentRoot = join(root, 'attachments'); mkdirSync(attachmentRoot); projectId = db.getDefaultProject()!.id
  ownerValid = read = write = true; releases = []; events = []; afterOpen = afterPublish = null; fileReads = 0
  fsOverride = { open: async (path, flags, mode) => { const fd = await open(path, flags, mode); await afterOpen?.(); return { stat: () => fd.stat({ bigint: true }), read: (b,o,l,p) => { fileReads++; return fd.read(b,o,l,p) }, write: (b,o,l,p) => fd.write(b,o,l,p), sync: () => fd.sync(), close: () => fd.close() } }, link: async (from, to) => { await link(from, to); await afterPublish?.() } }
  files = new TaskAttachmentFileOwner({ attachmentRoot, assertCurrent() { if (!db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, fs: fsOverride })
  manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
  options = { database: db, manager, files, attachmentRoot, engineEpoch: caller.engineEpoch, assertAvailable() { if (!ownerValid || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, assertTaskAttachmentOwners(value) { if (value.database !== db || value.manager !== manager || value.files !== files || value.attachmentRoot !== attachmentRoot) throw new ServiceProtocolError('DISCONNECTED') }, isTrustedDesktop: value => value.origin === caller.origin && value.webviewId === caller.webviewId, canAccessTask: (_id, _caller, access) => access === 'read' ? read : write, canAccessProject: (_id, _caller, access) => access === 'read' ? read : write, canAccessAgent: (_id, _caller, access) => access === 'read' ? read : write, onTaskUpdated: (taskId, attachments) => { events.push({ taskId, attachments: structuredClone(attachments) }) } }
  backend = new TaskAttachmentBackend(options); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('read-only saved attachment open with a controlled native acknowledgement', () => {
  const identity: DesktopCallerContext = { ...caller, uiLeaseId: 'ui_attachment_fixture' }
  let native: Array<{ receipt: AttachmentPathReceipt; caller: DesktopCallerContext }>
  async function enableOpen(callback?: TaskAttachmentBackendOptions['openAttachment']) {
    await backend.close(); native = []
    options = { ...options, openAttachment: callback ?? (async (receipt, caller) => { native.push({ receipt, caller }) }) }
    backend = new TaskAttachmentBackend(options)
  }
  async function saved() { const value = task(), records = await call('chatImages:saveToTask', [value.id, [image]]); return { value, record: records[0]!, path: join(attachmentRoot, value.id, `${records[0]!.id}-${records[0]!.filename}`) } }
  it('opens an active agent task with only read grants and no lifecycle mutation, byte reads or credential/full-task getters', async () => {
    const { value, record, path } = await saved(), agent = db.createAgent({ name: 'Active attachment owner', config: { coding_agent: 'opencode' } })!
    db.updateTask(value.id, { agent_id: agent.id })
    const started = await manager.requestSession(agent.id, value.id)
    expect(started.status).toBe('started'); if (!('sessionId' in started)) throw new Error('Missing actual live session')
    await enableOpen(); write = false; fileReads = 0
    const fullTask = vi.spyOn(db, 'getTask').mockImplementation(() => { throw new Error('Full task getter forbidden') }), fullAgent = vi.spyOn(db, 'getAgent').mockImplementation(() => { throw new Error('Credential getter forbidden') })
    const mutation = vi.spyOn(manager, 'runTaskLifecycleMutation')
    const historical = 'large unrelated private field'.repeat(10000)
    db.db.prepare('UPDATE tasks SET feedback_comment=? WHERE id=?').run(historical, value.id)
    const updatesBefore = events.length
    expect(await call('attachments:open', [value.id, record.id], undefined, identity)).toBeUndefined()
    expect(native).toHaveLength(1); expect(isAttachmentPathReceipt(native[0]!.receipt)).toBe(true)
    expect(native[0]!.receipt).toMatchObject({ taskId: value.id, attachmentId: record.id, filename: record.filename, attachmentRoot, path, target: { kind: 'file', size: String(record.size), nlink: '1' } })
    expect(native[0]!.caller.uiLeaseId).toBe(identity.uiLeaseId)
    expect(fullTask).not.toHaveBeenCalled(); expect(fullAgent).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled(); expect(fileReads).toBe(0)
    expect(manager.getSession(started.sessionId)).toBeDefined(); expect(events).toHaveLength(updatesBefore)
    expect(metadata(value.id)).toEqual([record]); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
    expect((db.db.prepare('SELECT feedback_comment FROM tasks WHERE id=?').get(value.id) as { feedback_comment: string }).feedback_comment).toBe(historical)
  })
  it('rejects a malformed retained owner size receipt before the native callback while closing the actual FD', async () => {
    const { value, record, path } = await saved(); await enableOpen()
    const original = files.open.bind(files)
    vi.spyOn(files, 'open').mockImplementation((id, selected, controls, invoke) => original(id, selected, controls, receipt => invoke({ ...receipt, target: { ...receipt.target, size: String(selected.size + 1) } })))
    await expect(call('attachments:open', [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(native).toEqual([]); expect(files.inflightCount).toBe(0)
    expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64')); expect(metadata(value.id)).toEqual([record])
  })
  it('omits unsupported open before SQL/file effects and rejects missing/malformed document receipts', async () => {
    const { value, record } = await saved(), sql = vi.spyOn(db.db, 'prepare'), file = vi.spyOn(files, 'open')
    expect(backend.operationSchemas(identity)['attachments:open']).toBeUndefined()
    await expect(call('attachments:open', [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(sql).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled(); sql.mockRestore()
    await enableOpen()
    for (const uiLeaseId of [undefined, '', '../forged', '😀', 'x'.repeat(129)]) await expect(call('attachments:open', [value.id, record.id], undefined, { ...identity, uiLeaseId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(file).not.toHaveBeenCalled(); expect(native).toEqual([])
    options.isTrustedDesktop = who => who.uiLeaseId === identity.uiLeaseId && who.origin === caller.origin && who.webviewId === caller.webviewId
    await expect(call('attachments:open', [value.id, record.id], undefined, { ...identity, uiLeaseId: 'ui_retired' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(file).not.toHaveBeenCalled()
  })
  it('keeps literal Captain/member roots and requires former, anchor, project and group-agent read scope', async () => {
    db.ensureCoordinatorTask(projectId); const captain = db.getCoordinatorTask(projectId)!, captainRecord = (await call('chatImages:saveToTask', [captain.id, [image]]))[0]!
    const first = task(), second = task(), former = task(), agent = db.createAgent({ name: 'Shared attachment group', config: { coding_agent: 'opencode' } })!
    const group = db.createTaskGroup({ title: 'Read-only group attachment', task_ids: [first.id, second.id, former.id], agent_id: agent.id }); db.removeTaskFromGroup(group.id, former.id)
    const member = (await call('chatImages:saveToTask', [first.id, [image]]))[0]!
    await enableOpen(); write = false
    await call('attachments:open', [captain.id, captainRecord.id], undefined, identity)
    await call('attachments:open', [first.id, member.id], undefined, identity)
    expect(native.map(value => value.receipt.path)).toEqual([join(attachmentRoot, captain.id, `${captainRecord.id}-${captainRecord.filename}`), join(attachmentRoot, first.id, `${member.id}-${member.filename}`)])
    expect(existsSync(join(attachmentRoot, group.execution_task_id))).toBe(false)
    for (const denied of [former.id, group.execution_task_id]) {
      options.canAccessTask = (id, _caller, access) => id !== denied && access === 'read'
      await expect(call('attachments:open', [first.id, member.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    options.canAccessTask = () => true; options.canAccessAgent = id => id !== agent.id
    await expect(call('attachments:open', [first.id, member.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessAgent = () => true; options.canAccessProject = () => false
    await expect(call('attachments:open', [first.id, member.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(native).toHaveLength(2)
  })
  it.each(['metadata', 'agent', 'membership', 'groupAgent', 'grant', 'owner'] as const)('rechecks %s before the actual callback after a raw descriptor wait and preserves bytes', async kind => {
    const { value, record, path } = await saved(), gate = held(), entered = held()
    const member = kind === 'membership' || kind === 'groupAgent' ? task() : null
    const groupAgent = member ? db.createAgent({ name: 'Captured group agent', config: { coding_agent: 'opencode' } })! : null
    const group = member ? db.createTaskGroup({ title: 'Captured membership', task_ids: [value.id, member.id, task().id], agent_id: groupAgent!.id }) : null
    releases.push(gate.release); await enableOpen(); afterOpen = async () => { entered.release(); await gate.promise }
    const outcome = call('attachments:open', [value.id, record.id], undefined, identity).catch(error => error)
    await entered.promise
    if (kind === 'metadata') db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(JSON.stringify([{ ...record, filename: 'changed.png' }]), value.id)
    if (kind === 'agent') { const replacement = db.createAgent({ name: 'Replacement' })!; db.db.prepare('UPDATE tasks SET agent_id=? WHERE id=?').run(replacement.id, value.id) }
    if (kind === 'membership') db.removeTaskFromGroup(group!.id, member!.id)
    if (kind === 'groupAgent') { const replacement = db.createAgent({ name: 'Replacement group agent' })!; db.db.prepare('UPDATE task_groups SET agent_id=? WHERE id=?').run(replacement.id, group!.id) }
    if (kind === 'grant') read = false
    if (kind === 'owner') ownerValid = false
    gate.release(); expect(await outcome).toMatchObject({ code: kind === 'owner' ? 'DISCONNECTED' : 'INVALID_REQUEST' })
    expect(native).toEqual([]); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64')); expect(files.inflightCount).toBe(0)
  })
  it('joins ignored-cancellation native work and blocks competing removal until actual acknowledgement and descriptor close', async () => {
    const { value, record, path } = await saved(), gate = held(), entered = held(); releases.push(gate.release)
    await enableOpen(async (receipt, caller) => { native.push({ receipt, caller }); entered.release(); await gate.promise })
    const controller = new AbortController(), outcome = call('attachments:open', [value.id, record.id], controller.signal, identity).catch(error => error)
    await entered.promise; expect(files.inflightCount).toBeGreaterThan(0)
    await expect(call('attachments:remove', [value.id, record.id])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    controller.abort(); await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); await expect(files.close(5)).rejects.toMatchObject({ code: 'ATTACHMENT_DRAIN_INCOMPLETE' })
    expect(db.db.open).toBe(true); expect(files.inflightCount).toBeGreaterThan(0); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
    gate.release(); expect(await outcome).toMatchObject({ code: 'CANCELLED' }); await backend.close(); await files.close()
    expect(metadata(value.id)).toEqual([record]); expect(files.inflightCount).toBe(0); expect(native).toHaveLength(1)
  })
  it('rejects caller/metadata changes after a real callback wait without manufacturing undo or deleting the attachment', async () => {
    const { value, record, path } = await saved()
    await enableOpen(async () => { db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(JSON.stringify([{ ...record, filename: 'current-user-change.png' }]), value.id) })
    await expect(call('attachments:open', [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(metadata(value.id)[0]!.filename).toBe('current-user-change.png'); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
    expect(files.inflightCount).toBe(0)
  })
  it('refuses hostile/oversized saved metadata before FD/native effects and preserves the original row', async () => {
    const { value, record, path } = await saved(); await enableOpen()
    for (const recordValue of [{ ...record, filename: '../foreign' }, { ...record, size: TASK_ATTACHMENT_LIMITS.openBytes + 1 }]) {
      const raw = JSON.stringify([recordValue]); db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(raw, value.id)
      await expect(call('attachments:open', [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: recordValue.size > TASK_ATTACHMENT_LIMITS.openBytes ? 'FRAME_TOO_LARGE' : 'INVALID_REQUEST' })
      expect((db.db.prepare('SELECT attachments FROM tasks WHERE id=?').get(value.id) as { attachments: string }).attachments).toBe(raw)
    }
    expect(native).toEqual([]); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
  })
  it.skipIf(process.platform === 'win32')('refuses symlink substitutions without opening or modifying unrelated user bytes', async () => {
    const { value, record, path } = await saved(), other = join(root, 'unrelated-user-file'); writeFileSync(other, 'keep')
    rmSync(path); symlinkSync(other, path); await enableOpen()
    await expect(call('attachments:open', [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(native).toEqual([]); expect(readFileSync(other, 'utf8')).toBe('keep'); expect(metadata(value.id)).toEqual([record])
  })
})
afterEach(async () => {
  for (const release of releases) release(); ownerValid = read = write = true; afterOpen = afterPublish = null
  await backend.close(); await files.close(); vi.restoreAllMocks(); await manager.stopAllSessions(); await manager.stopServer(); db.close(); rmSync(root, { recursive: true, force: true })
})
async function call<K extends TaskAttachmentOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = TASK_ATTACHMENT_CODECS[operation] as TaskAttachmentCodec<K>, result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal); expect(codec.validateWireResult(result)).toBe(true); return codec.decodeResult((result as { value?: JsonValue }).value)
}
function task() { return db.createTask({ title: 'Actual attachment task', project_id: projectId })! }
function metadata(id: string): FileAttachmentRecord[] { return JSON.parse((db.db.prepare('SELECT attachments FROM tasks WHERE id=?').get(id) as { attachments: string }).attachments) }
describe('actual task attachment bindings and accepted-effect ownership', () => {
  it('saves real sanitized images and durable records, emits ordinary task updates, and removes only the exact file', async () => {
    const value = task(), ambient = vi.spyOn(db, 'getAttachmentsDir').mockImplementation(() => { throw new Error('Ambient directory forbidden') })
    expect(Object.keys(backend.operationSchemas(caller))).toEqual(TASK_ATTACHMENT_OPERATIONS.filter(operation => operation !== 'attachments:open'))
    const first = await call('chatImages:saveToTask', [value.id, [image]]), second = await call('chatImages:saveToTask', [value.id, [image]])
    expect(first[0]?.filename).toBe('写真.png'); expect(second[0]?.filename).toBe('写真-2.png'); expect(metadata(value.id)).toEqual([...first, ...second]); expect(events).toEqual([{ taskId: value.id, attachments: first }, { taskId: value.id, attachments: [...first, ...second] }])
    const selected = first[0]!, path = join(attachmentRoot, value.id, `${selected.id}-${selected.filename}`); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
    const other = join(attachmentRoot, value.id, `${selected.id}-personal.txt`); writeFileSync(other, 'personal')
    expect(await call('attachments:remove', [value.id, selected.id])).toBeUndefined(); expect(existsSync(path)).toBe(false); expect(readFileSync(other, 'utf8')).toBe('personal'); expect(metadata(value.id)).toEqual([...first, ...second]); expect(ambient).not.toHaveBeenCalled()
  })
  it('preserves genuine Captain and literal member storage while requiring current and former group grants', async () => {
    db.ensureCoordinatorTask(projectId); const captain = db.getCoordinatorTask(projectId)!, captainSaved = await call('chatImages:saveToTask', [captain.id, [image]])
    expect(existsSync(join(attachmentRoot, captain.id, `${captainSaved[0]!.id}-${captainSaved[0]!.filename}`))).toBe(true)
    const first = task(), second = task(), former = task(), agent = db.createAgent({ name: 'Actual group attachment owner', config: { coding_agent: 'opencode' } })!, group = db.createTaskGroup({ title: 'Actual group', task_ids: [first.id, second.id, former.id], agent_id: agent.id }); db.removeTaskFromGroup(group.id, former.id)
    const member = await call('chatImages:saveToTask', [first.id, [image]])
    expect(existsSync(join(attachmentRoot, first.id, `${member[0]!.id}-${member[0]!.filename}`))).toBe(true); expect(existsSync(join(attachmentRoot, group.execution_task_id))).toBe(false)
    options.canAccessTask = (id, _caller, access) => id !== former.id && (access === 'read' ? read : write)
    await expect(call('chatImages:saveToTask', [first.id, [image]])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(metadata(first.id)).toEqual(member)
  })
  it.each(['deleted','reassigned','metadata','grant','owner'] as const)('refuses %s changes after publication and rolls back only the exact new image bytes', async kind => {
    const value = task(), concurrent = { id: 'e058a491-254b-4678-8fb2-f7d226fe6213', filename: 'ordinary.txt', size: 4, mime_type: 'text/plain', added_at: '2026-10-14T00:00:00.000Z' }
    afterPublish = async () => {
      afterPublish = null
      if (kind === 'deleted') db.db.prepare('DELETE FROM tasks WHERE id=?').run(value.id)
      if (kind === 'reassigned') { const agent = db.createAgent({ name: 'Replacement agent' })!; db.db.prepare('UPDATE tasks SET agent_id=? WHERE id=?').run(agent.id, value.id) }
      if (kind === 'metadata') { db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(JSON.stringify([concurrent]), value.id); writeFileSync(join(attachmentRoot, value.id, `${concurrent.id}-${concurrent.filename}`), 'keep') }
      if (kind === 'grant') write = false
      if (kind === 'owner') ownerValid = false
    }
    await expect(call('chatImages:saveToTask', [value.id, [image]])).rejects.toMatchObject({ code: kind === 'owner' ? 'DISCONNECTED' : 'INVALID_REQUEST' })
    expect(events).toEqual([]); expect(readdirSync(join(attachmentRoot, value.id))).toEqual(kind === 'metadata' ? [`${concurrent.id}-${concurrent.filename}`] : [])
    if (kind === 'metadata') { expect(metadata(value.id)).toEqual([concurrent]); expect(readFileSync(join(attachmentRoot, value.id, `${concurrent.id}-${concurrent.filename}`), 'utf8')).toBe('keep') }
    else if (kind !== 'deleted') expect(metadata(value.id)).toEqual([])
  })
  it('preserves an accepted durable append when authority is withdrawn after the actual transaction commits', async () => {
    const value = task(), actual = db.db.transaction.bind(db.db), transaction = vi.spyOn(db.db, 'transaction')
    transaction.mockImplementation(((effect: (...args: unknown[]) => unknown) => {
      const wrapped = actual(effect); return Object.assign((...args: unknown[]) => { const result = wrapped(...args); if (metadata(value.id).length) write = false; return result }, wrapped)
    }) as typeof db.db.transaction)
    await expect(call('chatImages:saveToTask', [value.id, [image]])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); transaction.mockRestore()
    const accepted = metadata(value.id); expect(accepted).toHaveLength(1); expect(readFileSync(join(attachmentRoot, value.id, `${accepted[0]!.id}-${accepted[0]!.filename}`))).toEqual(Buffer.from(image.data, 'base64')); expect(files.inflightCount).toBe(0); expect(events).toEqual([])
  })
  it('retains real raw writes through cancellation/shutdown and joins the borrowed file owner before release', async () => {
    const value = task(), gate = held(), entered = held(); releases.push(gate.release); afterOpen = async () => { entered.release(); await gate.promise }
    const pending = call('chatImages:saveToTask', [value.id, [image]]), failed = pending.catch(error => error); await entered.promise
    await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); await expect(files.close(5)).rejects.toMatchObject({ code: 'ATTACHMENT_DRAIN_INCOMPLETE' }); expect(db.db.open).toBe(true)
    gate.release(); expect((await failed).code).toBe('CANCELLED'); await backend.close(); await files.close(); expect(metadata(value.id)).toEqual([]); expect(readdirSync(join(attachmentRoot, value.id))).toEqual([])
  })
  it('refuses oversized saved metadata and unrelated whole-row fields before any legacy getters or filesystem effects', async () => {
    const value = task(), raw = ' '.repeat(TASK_ATTACHMENT_LIMITS.metadataBytes + 1); db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(raw, value.id)
    const getter = vi.spyOn(db, 'getTask').mockImplementation(() => { throw new Error('Full getter forbidden') })
    await expect(call('chatImages:saveToTask', [value.id, [image]])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' }); expect(getter).not.toHaveBeenCalled(); expect(existsSync(join(attachmentRoot, value.id))).toBe(false); expect((db.db.prepare('SELECT attachments FROM tasks WHERE id=?').get(value.id) as { attachments: string }).attachments).toBe(raw)
    db.db.prepare("UPDATE tasks SET attachments='[]',feedback_comment=? WHERE id=?").run('private legacy field'.repeat(10000), value.id)
    await expect(call('chatImages:saveToTask', [value.id, [image]])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' }); expect(getter).not.toHaveBeenCalled(); getter.mockRestore(); db.db.prepare("UPDATE tasks SET feedback_comment='' WHERE id=?").run(value.id)
  })
  it('refuses missing/foreign selectors and stale callers before actual file effects', async () => {
    const value = task(), id = '61f07006-c85b-438e-83a7-497c77b0dcae'
    await expect(call('attachments:remove', [value.id, id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(existsSync(join(attachmentRoot, value.id))).toBe(false)
    await expect(call('chatImages:saveToTask', [value.id, [image]], undefined, { ...caller, engineEpoch: 'old' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    read = false; await expect(call('chatImages:saveToTask', [value.id, [image]])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(metadata(value.id)).toEqual([])
  })
})
