import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, linkSync, renameSync } from 'node:fs'
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
let fileReads: number, refuseClose: boolean, closeAttempts: number
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture'))); attachmentRoot = join(root, 'attachments'); mkdirSync(attachmentRoot); projectId = db.getDefaultProject()!.id
  ownerValid = read = write = true; releases = []; events = []; afterOpen = afterPublish = null; fileReads = closeAttempts = 0; refuseClose = false
  fsOverride = { open: async (path, flags, mode) => { const fd = await open(path, flags, mode); await afterOpen?.(); return { stat: () => fd.stat({ bigint: true }), read: (b,o,l,p) => { fileReads++; return fd.read(b,o,l,p) }, write: (b,o,l,p) => fd.write(b,o,l,p), sync: () => fd.sync(), close: async () => { closeAttempts++; if (refuseClose) throw new Error('Controlled raw close failure'); await fd.close() } } }, link: async (from, to) => { await link(from, to); await afterPublish?.() } }
  files = new TaskAttachmentFileOwner({ attachmentRoot, assertCurrent() { if (!db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, fs: fsOverride })
  manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
  options = { database: db, manager, files, attachmentRoot, engineEpoch: caller.engineEpoch, assertAvailable() { if (!ownerValid || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, assertTaskAttachmentOwners(value) { if (value.database !== db || value.manager !== manager || value.files !== files || value.attachmentRoot !== attachmentRoot) throw new ServiceProtocolError('DISCONNECTED') }, isTrustedDesktop: value => value.origin === caller.origin && value.webviewId === caller.webviewId, canAccessTask: (_id, _caller, access) => access === 'read' ? read : write, canAccessProject: (_id, _caller, access) => access === 'read' ? read : write, canAccessAgent: (_id, _caller, access) => access === 'read' ? read : write, onTaskUpdated: (taskId, attachments) => { events.push({ taskId, attachments: structuredClone(attachments) }) } }
  backend = new TaskAttachmentBackend(options); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe.each([
  { operation: 'attachments:open', capability: 'openAttachment' },
  { operation: 'attachments:download', capability: 'downloadAttachment' }
] as const)('read-only saved $operation with a controlled native acknowledgement', ({ operation, capability }) => {
  const identity: DesktopCallerContext = { ...caller, uiLeaseId: 'ui_attachment_fixture' }
  let native: Array<{ receipt: AttachmentPathReceipt; caller: DesktopCallerContext }>
  async function enableNative(callback?: TaskAttachmentBackendOptions['openAttachment']) {
    await backend.close(); native = []
    options = { ...options, [capability]: callback ?? (async (receipt: AttachmentPathReceipt, caller: DesktopCallerContext) => { native.push({ receipt, caller }) }) }
    backend = new TaskAttachmentBackend(options)
  }
  async function saved() { const value = task(), records = await call('chatImages:saveToTask', [value.id, [image]]); return { value, record: records[0]!, path: join(attachmentRoot, value.id, `${records[0]!.id}-${records[0]!.filename}`) } }
  it('handles an active agent task with only read grants and no lifecycle mutation, byte reads or credential/full-task getters', async () => {
    const { value, record, path } = await saved(), agent = db.createAgent({ name: 'Active attachment owner', config: { coding_agent: 'opencode' } })!
    db.updateTask(value.id, { agent_id: agent.id })
    const started = await manager.requestSession(agent.id, value.id)
    expect(started.status).toBe('started'); if (!('sessionId' in started)) throw new Error('Missing actual live session')
    await enableNative(); write = false; fileReads = 0
    const fullTask = vi.spyOn(db, 'getTask').mockImplementation(() => { throw new Error('Full task getter forbidden') }), fullAgent = vi.spyOn(db, 'getAgent').mockImplementation(() => { throw new Error('Credential getter forbidden') })
    const mutation = vi.spyOn(manager, 'runTaskLifecycleMutation')
    const historical = 'large unrelated private field'.repeat(10000)
    db.db.prepare('UPDATE tasks SET feedback_comment=? WHERE id=?').run(historical, value.id)
    const updatesBefore = events.length
    expect(await call(operation, [value.id, record.id], undefined, identity)).toBeUndefined()
    expect(native).toHaveLength(1); expect(isAttachmentPathReceipt(native[0]!.receipt)).toBe(true)
    expect(native[0]!.receipt).toMatchObject({ taskId: value.id, attachmentId: record.id, filename: record.filename, attachmentRoot, path, target: { kind: 'file', size: String(record.size), nlink: '1' } })
    expect(native[0]!.caller.uiLeaseId).toBe(identity.uiLeaseId)
    expect(fullTask).not.toHaveBeenCalled(); expect(fullAgent).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled(); expect(fileReads).toBe(0)
    expect(manager.getSession(started.sessionId)).toBeDefined(); expect(events).toHaveLength(updatesBefore)
    expect(metadata(value.id)).toEqual([record]); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
    expect((db.db.prepare('SELECT feedback_comment FROM tasks WHERE id=?').get(value.id) as { feedback_comment: string }).feedback_comment).toBe(historical)
  })
  it('rejects a malformed retained owner size receipt before the native callback while closing the actual FD', async () => {
    const { value, record, path } = await saved(); await enableNative()
    const original = files.open.bind(files)
    vi.spyOn(files, 'open').mockImplementation((id, selected, controls, invoke) => original(id, selected, controls, receipt => invoke({ ...receipt, target: { ...receipt.target, size: String(selected.size + 1) } })))
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(native).toEqual([]); expect(files.inflightCount).toBe(0)
    expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64')); expect(metadata(value.id)).toEqual([record])
  })
  it('omits the unsupported native effect before SQL/file effects and rejects missing/malformed document receipts', async () => {
    const { value, record } = await saved(), sql = vi.spyOn(db.db, 'prepare'), file = vi.spyOn(files, 'open')
    expect(backend.operationSchemas(identity)[operation]).toBeUndefined()
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(sql).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled(); sql.mockRestore()
    await enableNative()
    for (const uiLeaseId of [undefined, '', '../forged', '😀', 'x'.repeat(129)]) await expect(call(operation, [value.id, record.id], undefined, { ...identity, uiLeaseId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(file).not.toHaveBeenCalled(); expect(native).toEqual([])
    options.isTrustedDesktop = who => who.uiLeaseId === identity.uiLeaseId && who.origin === caller.origin && who.webviewId === caller.webviewId
    await expect(call(operation, [value.id, record.id], undefined, { ...identity, uiLeaseId: 'ui_retired' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(file).not.toHaveBeenCalled()
  })
  it('keeps literal Captain/member roots and requires former, anchor, project and group-agent read scope', async () => {
    db.ensureCoordinatorTask(projectId); const captain = db.getCoordinatorTask(projectId)!, captainRecord = (await call('chatImages:saveToTask', [captain.id, [image]]))[0]!
    const first = task(), second = task(), former = task(), agent = db.createAgent({ name: 'Shared attachment group', config: { coding_agent: 'opencode' } })!
    const group = db.createTaskGroup({ title: 'Read-only group attachment', task_ids: [first.id, second.id, former.id], agent_id: agent.id }); db.removeTaskFromGroup(group.id, former.id)
    const member = (await call('chatImages:saveToTask', [first.id, [image]]))[0]!
    await enableNative(); write = false
    await call(operation, [captain.id, captainRecord.id], undefined, identity)
    await call(operation, [first.id, member.id], undefined, identity)
    expect(native.map(value => value.receipt.path)).toEqual([join(attachmentRoot, captain.id, `${captainRecord.id}-${captainRecord.filename}`), join(attachmentRoot, first.id, `${member.id}-${member.filename}`)])
    expect(existsSync(join(attachmentRoot, group.execution_task_id))).toBe(false)
    for (const denied of [former.id, group.execution_task_id]) {
      options.canAccessTask = (id, _caller, access) => id !== denied && access === 'read'
      await expect(call(operation, [first.id, member.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    options.canAccessTask = () => true; options.canAccessAgent = id => id !== agent.id
    await expect(call(operation, [first.id, member.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessAgent = () => true; options.canAccessProject = () => false
    await expect(call(operation, [first.id, member.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(native).toHaveLength(2)
  })
  it.each(['metadata', 'agent', 'membership', 'groupAgent', 'grant', 'owner'] as const)('rechecks %s before the actual callback after a raw descriptor wait and preserves bytes', async kind => {
    const { value, record, path } = await saved(), gate = held(), entered = held()
    const member = kind === 'membership' || kind === 'groupAgent' ? task() : null
    const groupAgent = member ? db.createAgent({ name: 'Captured group agent', config: { coding_agent: 'opencode' } })! : null
    const group = member ? db.createTaskGroup({ title: 'Captured membership', task_ids: [value.id, member.id, task().id], agent_id: groupAgent!.id }) : null
    releases.push(gate.release); await enableNative(); afterOpen = async () => { entered.release(); await gate.promise }
    const outcome = call(operation, [value.id, record.id], undefined, identity).catch(error => error)
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
    await enableNative(async (receipt, caller) => { native.push({ receipt, caller }); entered.release(); await gate.promise })
    const controller = new AbortController(), outcome = call(operation, [value.id, record.id], controller.signal, identity).catch(error => error)
    await entered.promise; expect(files.inflightCount).toBeGreaterThan(0)
    await expect(call('attachments:remove', [value.id, record.id])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    controller.abort(); await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); await expect(files.close(5)).rejects.toMatchObject({ code: 'ATTACHMENT_DRAIN_INCOMPLETE' })
    expect(db.db.open).toBe(true); expect(files.inflightCount).toBeGreaterThan(0); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
    gate.release(); expect(await outcome).toMatchObject({ code: 'CANCELLED' }); await backend.close(); await files.close()
    expect(metadata(value.id)).toEqual([record]); expect(files.inflightCount).toBe(0); expect(native).toHaveLength(1)
  })
  it('rejects caller/metadata changes after a real callback wait without manufacturing undo or deleting the attachment', async () => {
    const { value, record, path } = await saved()
    await enableNative(async () => { db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(JSON.stringify([{ ...record, filename: 'current-user-change.png' }]), value.id) })
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(metadata(value.id)[0]!.filename).toBe('current-user-change.png'); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
    expect(files.inflightCount).toBe(0)
  })
  it('refuses hostile/oversized saved metadata before FD/native effects and preserves the original row', async () => {
    const { value, record, path } = await saved(); await enableNative()
    for (const recordValue of [{ ...record, filename: '../foreign' }, { ...record, size: TASK_ATTACHMENT_LIMITS.openBytes + 1 }]) {
      const raw = JSON.stringify([recordValue]); db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(raw, value.id)
      await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: recordValue.size > TASK_ATTACHMENT_LIMITS.openBytes ? 'FRAME_TOO_LARGE' : 'INVALID_REQUEST' })
      expect((db.db.prepare('SELECT attachments FROM tasks WHERE id=?').get(value.id) as { attachments: string }).attachments).toBe(raw)
    }
    expect(native).toEqual([]); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
  })
  it.skipIf(process.platform === 'win32')('refuses symlink substitutions without opening or modifying unrelated user bytes', async () => {
    const { value, record, path } = await saved(), other = join(root, 'unrelated-user-file'); writeFileSync(other, 'keep')
    rmSync(path); symlinkSync(other, path); await enableNative()
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(native).toEqual([]); expect(readFileSync(other, 'utf8')).toBe('keep'); expect(metadata(value.id)).toEqual([record])
  })
  it.skipIf(process.platform === 'win32')('refuses a hardlinked source before native and preserves every existing link', async () => {
    const { value, record, path } = await saved(), other = join(root, 'unrelated-existing-link')
    linkSync(path, other); await enableNative()
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(native).toEqual([]); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64')); expect(readFileSync(other)).toEqual(Buffer.from(image.data, 'base64')); expect(metadata(value.id)).toEqual([record])
  })
  it.skipIf(process.platform === 'win32')('detects pathname substitution after native acknowledgement while preserving the retained source and replacement', async () => {
    const { value, record, path } = await saved(), retained = join(root, 'retained-original'), replacement = Buffer.alloc(record.size, 0x61)
    await enableNative(async (receipt, caller) => { native.push({ receipt, caller }); renameSync(path, retained); writeFileSync(path, replacement) })
    fileReads = 0
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(native).toHaveLength(1); expect(fileReads).toBe(0)
    expect(files.inflightCount).toBe(0); expect(readFileSync(retained)).toEqual(Buffer.from(image.data, 'base64')); expect(readFileSync(path)).toEqual(replacement); expect(metadata(value.id)).toEqual([record])
  })
  it('refuses foreign selectors and missing saved source files without invoking native or changing metadata', async () => {
    const { value, record, path } = await saved(), foreign = task(), foreignRecord = (await call('chatImages:saveToTask', [foreign.id, [image]]))[0]!
    await enableNative()
    await expect(call(operation, [value.id, foreignRecord.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    rmSync(path)
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(native).toEqual([]); expect(metadata(value.id)).toEqual([record]); expect(metadata(foreign.id)).toEqual([foreignRecord])
  })
  it('exports a fixed failure after an uncertain native effect without leaking diagnostics, deleting the source or replaying', async () => {
    const { value, record, path } = await saved()
    await enableNative(async (receipt, caller) => { native.push({ receipt, caller }); throw new Error('private destination /home/private authentication-token') })
    const error = await call(operation, [value.id, record.id], undefined, identity).catch(error => error)
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' }); expect(error.message).not.toContain('private destination'); expect(error.message).not.toContain('authentication-token')
    expect(native).toHaveLength(1); expect(files.inflightCount).toBe(0); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64')); expect(metadata(value.id)).toEqual([record])
  })
  it('accepts saved files larger than the publication ceiling without Source byte transfer or metadata writes', async () => {
    const { value, record, path } = await saved(), bytes = Buffer.alloc(600 * 1024, 0x61), large = { ...record, size: bytes.length }
    writeFileSync(path, bytes); db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(JSON.stringify([large]), value.id)
    await enableNative(); write = false; fileReads = 0
    const updatesBefore = events.length
    expect(await call(operation, [value.id, record.id], undefined, identity)).toBeUndefined()
    expect(native).toHaveLength(1); expect(native[0]!.receipt.target.size).toBe(String(bytes.length)); expect(fileReads).toBe(0)
    expect(events).toHaveLength(updatesBefore); expect(metadata(value.id)).toEqual([large]); expect(readFileSync(path)).toEqual(bytes)
  })
  it.each(['beforeNative', 'afterNative'] as const)('rejects captured callback replacement %s without invoking the replacement or replaying the effect', async when => {
    const { value, record, path } = await saved(), replacement = vi.fn(async () => {})
    await enableNative(async (receipt, caller) => { native.push({ receipt, caller }); if (when === 'afterNative') options[capability] = replacement })
    if (when === 'beforeNative') afterOpen = async () => { options[capability] = replacement }
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(replacement).not.toHaveBeenCalled(); expect(native).toHaveLength(when === 'afterNative' ? 1 : 0)
    expect(files.inflightCount).toBe(0); expect(metadata(value.id)).toEqual([record]); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
  })
  it('retains an exact failed-close descriptor until explicit retry and blocks subsequent file effects', async () => {
    const { value, record, path } = await saved(); await enableNative(); refuseClose = true
    const before = closeAttempts
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(native).toHaveLength(1); expect(files.inflightCount).toBeGreaterThan(0); expect(closeAttempts).toBe(before + 1)
    await expect(call(operation, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    await expect(files.close()).rejects.toMatchObject({ code: 'ATTACHMENT_CLOSE_FAILED' })
    expect(db.db.open).toBe(true); expect(files.inflightCount).toBeGreaterThan(0); expect(native).toHaveLength(1)
    refuseClose = false; await files.close(); expect(files.inflightCount).toBe(0)
    expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64')); expect(metadata(value.id)).toEqual([record])
  })
})
describe('download copy authorization after a controlled native Save dialog', () => {
  it.each(['taskScope', 'readGrant', 'cancelledSignal'] as const)('refuses %s drift before copy and joins raw callback closure before releasing the source FD', async kind => {
    const value = task(), record = (await call('chatImages:saveToTask', [value.id, [image]]))[0]!, path = join(attachmentRoot, value.id, `${record.id}-${record.filename}`)
    const dialog = held(), entered = held(), closing = held(), closure = held(), controller = new AbortController()
    releases.push(dialog.release, closure.release)
    let copies = 0, calls = 0, settled = false, suppliedGuard: (() => void) | undefined
    await backend.close()
    options = { ...options, downloadAttachment: async (_receipt, _caller, _signal, beforeEffect) => {
      calls++; suppliedGuard = beforeEffect; entered.release(); await dialog.promise
      try { beforeEffect(); copies++ } finally { closing.release(); await closure.promise }
    } }
    backend = new TaskAttachmentBackend(options)
    const identity: DesktopCallerContext = { ...caller, uiLeaseId: 'ui_save_dialog_fixture' }
    const pending = call('attachments:download', [value.id, record.id], controller.signal, identity)
    const outcome = pending.then(result => { settled = true; return result }, error => { settled = true; return error })
    await entered.promise
    expect(typeof suppliedGuard).toBe('function'); expect(files.inflightCount).toBeGreaterThan(0)
    if (kind === 'taskScope') { const project = db.createProject({ name: 'Changed project during dialog' })!; db.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(project.id, value.id) }
    if (kind === 'readGrant') read = false
    if (kind === 'cancelledSignal') controller.abort()
    dialog.release(); await closing.promise
    expect(copies).toBe(0); expect(settled).toBe(false); expect(backend.inflightCount).toBe(1); expect(files.inflightCount).toBeGreaterThan(0)
    await expect(call('attachments:remove', [value.id, record.id])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    expect(metadata(value.id)).toEqual([record]); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
    closure.release(); expect(await outcome).toMatchObject({ code: kind === 'cancelledSignal' ? 'CANCELLED' : 'INVALID_REQUEST' })
    expect(calls).toBe(1); expect(copies).toBe(0); expect(files.inflightCount).toBe(0); expect(backend.inflightCount).toBe(0)
    // The captured guard cannot authorize a later inherited callback after its
    // actual raw operation has retired, even if current grants are restored.
    read = true; expect(() => suppliedGuard!()).toThrowError(expect.objectContaining({ code: 'CANCELLED' }))
    expect(metadata(value.id)).toEqual([record]); expect(readFileSync(path)).toEqual(Buffer.from(image.data, 'base64'))
  })
})
afterEach(async () => {
  for (const release of releases) release(); ownerValid = read = write = true; afterOpen = afterPublish = null; refuseClose = false
  await backend.close(); await files.close(); vi.restoreAllMocks(); await manager.stopAllSessions(); await manager.stopServer(); db.close(); rmSync(root, { recursive: true, force: true })
})
async function call<K extends TaskAttachmentOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = TASK_ATTACHMENT_CODECS[operation] as TaskAttachmentCodec<K>, result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal); expect(codec.validateWireResult(result)).toBe(true); return codec.decodeResult((result as { value?: JsonValue }).value)
}
function task() { return db.createTask({ title: 'Actual attachment task', project_id: projectId })! }
function metadata(id: string): FileAttachmentRecord[] { return JSON.parse((db.db.prepare('SELECT attachments FROM tasks WHERE id=?').get(id) as { attachments: string }).attachments) }
describe('actual task attachment bindings and accepted-effect ownership', () => {
  it('registers opening and downloading independently and refuses either missing capability before file or SQL effects', async () => {
    const value = task(), record = (await call('chatImages:saveToTask', [value.id, [image]]))[0]!, identity = { ...caller, uiLeaseId: 'ui_independent_attachment' }
    const opened = vi.fn(async () => {}), downloaded = vi.fn(async () => {})
    for (const capability of ['openAttachment', 'downloadAttachment'] as const) {
      await backend.close(); options = { ...options, openAttachment: undefined, downloadAttachment: undefined, [capability]: capability === 'openAttachment' ? opened : downloaded }; backend = new TaskAttachmentBackend(options)
      const supported = capability === 'openAttachment' ? 'attachments:open' : 'attachments:download', missing = capability === 'openAttachment' ? 'attachments:download' : 'attachments:open'
      const sql = vi.spyOn(db.db, 'prepare'), file = vi.spyOn(files, 'open')
      expect(backend.operationSchemas(identity)[missing]).toBeUndefined(); expect(backend.operationSchemas(identity)[supported]).toBeDefined()
      await expect(call(missing, [value.id, record.id], undefined, identity)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
      expect(sql).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled(); sql.mockRestore(); file.mockRestore()
      expect(await call(supported, [value.id, record.id], undefined, identity)).toBeUndefined()
    }
    expect(opened).toHaveBeenCalledTimes(1); expect(downloaded).toHaveBeenCalledTimes(1)
  })
  it('saves real sanitized images and durable records, emits ordinary task updates, and removes only the exact file', async () => {
    const value = task(), ambient = vi.spyOn(db, 'getAttachmentsDir').mockImplementation(() => { throw new Error('Ambient directory forbidden') })
    expect(Object.keys(backend.operationSchemas(caller))).toEqual(TASK_ATTACHMENT_OPERATIONS.filter(operation => operation !== 'attachments:open' && operation !== 'attachments:download'))
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
