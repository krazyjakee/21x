import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProductionOwner, ProductionOwnerBootstrap } from './production-owner'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import type { FileAttachmentRecord } from '../main/database/types'
import type { ProductionAgentBackend } from './production-agent-backend'

const fixtures: Array<{ owner: ProductionOwner; root: string }> = []
const backends: ProductionAgentBackend[] = [], finishers: Array<() => void> = []
beforeEach(() => { vi.resetModules() })
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish()
  for (const backend of backends.splice(0)) await backend.close()
  for (const fixture of fixtures.splice(0)) { await fixture.owner.close(); rmSync(fixture.root, { recursive: true, force: true }) }
  vi.restoreAllMocks()
})
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); finishers.push(release); return { promise, release } }
async function fixture(readGate?: { promise: Promise<void>; opened(): void }) {
  const { ProductionOwner } = await import('./production-owner')
  const { TaskAttachmentFileOwner } = await import('../main/task-attachment-file-owner')
  const root = mkdtempSync(join(tmpdir(), '21x-production-attachment-execution-'))
  const resourceRoot = join(root, 'resources'); mkdirSync(resourceRoot)
  const keys = new Map<string, Buffer>(), adapter = new FakeAdapter()
  const bootstrap: ProductionOwnerBootstrap = {
    profileId: 'synthetic-attachment-execution',
    paths: { profileRoot: join(root, 'profile'), resourceRoot, workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), tempRoot: join(root, 'temp') },
    credentials: { mode: 'create', store: { create: async (id, key) => { if (keys.has(id)) throw new Error('Fixture key exists'); keys.set(id, Buffer.from(key)) }, load: async id => { const key = keys.get(id); if (!key) throw new Error('Fixture key missing'); return Buffer.from(key) } } },
    managedTaskMcp: { disabled: true }, connectors: { kind: 'disabled', reason: 'No fixture connector bundle' },
    native: { agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: 'disabled' },
      prepareRuntime: async () => {}, openExternal: async () => {}, notify() {}, emit() {},
      sendUiCommand: () => ({ ok: false, detail: 'No fixture document' }), drainOwnedProcesses: async () => ({ acknowledged: true }) }
  }
  const owner = new ProductionOwner(bootstrap, { cliMcp: { homeDir: root, environment: {} }, createAdapter: () => adapter,
    ...(readGate ? { taskAttachmentFiles: options => new TaskAttachmentFileOwner({ ...options, fs: { open: async (path, flags, mode) => {
      const fd = await open(path, flags, mode)
      return { stat: () => fd.stat({ bigint: true }), write: (buffer, offset, length, position) => fd.write(buffer, offset, length, position), sync: () => fd.sync(), close: () => fd.close(),
        read: async (buffer, offset, length, position) => { const result = await fd.read(buffer, offset, length, position); if (!path.endsWith('.tmp')) { readGate.opened(); await readGate.promise } return result } }
    } } }) } : {}) })
  fixtures.push({ owner, root })
  const services = await owner.start(), agent = services.db.getAgents()[0]
  services.db.updateAgent(agent.id, { config: { coding_agent: 'pi' } })
  const task = services.db.createTask({ title: 'Protected attachment execution proof' })!
  services.db.updateTask(task.id, { agent_id: agent.id })
  const bytes = Buffer.from('owned bytes'), attachment: FileAttachmentRecord = { id: randomUUID(), filename: 'owned.txt', size: bytes.length, mime_type: 'text/plain', added_at: '2026-10-18T00:00:00.000Z' }
  const receipt = await services.taskAttachmentFiles.write(task.id, attachment, bytes, { beforeEffect() {}, signal: new AbortController().signal })
  services.db.updateTask(task.id, { attachments: [attachment] }); services.taskAttachmentFiles.commit(receipt)
  return { root, owner, services, adapter, agent, task, attachment, bytes, bootstrap,
    saved: join(bootstrap.paths.attachmentRoot, task.id, `${attachment.id}-${attachment.filename}`), workspace: services.db.getWorkspaceDir(task.id) }
}

describe.runIf(process.platform === 'linux')('actual production attachment execution authority (Linux)', () => {
  it('refuses raw task API attachment arrays before a stale full-array intent can erase an accepted copy', async () => {
    const f = await fixture(), second = { ...f.attachment, id: randomUUID(), filename: 'second.txt' }
    const receipt = await f.services.taskAttachmentFiles.write(f.task.id, second, f.bytes, { beforeEffect() {}, signal: new AbortController().signal })
    f.services.db.updateTask(f.task.id, { attachments: [f.attachment, second] }); f.services.taskAttachmentFiles.commit(receipt)
    const { getTaskApiPort, getTaskApiToken } = await import('../main/task-api-server-core')
    const response = await fetch(`http://127.0.0.1:${getTaskApiPort()}/update_task`, {
      method: 'POST', headers: { authorization: `Bearer ${getTaskApiToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ task_id: f.task.id, title: 'Stale writer', attachments: [f.attachment] })
    })
    const result = await response.json()
    expect({ rejected: !!(result as { error?: unknown }).error, attachments: f.services.db.getTask(f.task.id)?.attachments,
      title: f.services.db.getTask(f.task.id)?.title }).toEqual({ rejected: true, attachments: [f.attachment, second], title: f.task.title })
    expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
    const fields = await fetch(`http://127.0.0.1:${getTaskApiPort()}/update_task`, {
      method: 'POST', headers: { authorization: `Bearer ${getTaskApiToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ task_id: f.task.id, title: 'Field-only update' })
    })
    expect(await fields.json()).not.toHaveProperty('error')
    expect(f.services.db.getTask(f.task.id)?.title).toBe('Field-only update')
    expect(f.services.db.getTask(f.task.id)?.attachments).toEqual([f.attachment, second])
  })
  it('retains a durable owner for an accepted metadata-only copy across profile restart', async () => {
    const f = await fixture(), orphanTask = f.services.db.createTask({ title: 'An accepted copy with no metadata write' })!
    const record = { ...f.attachment, id: randomUUID(), filename: 'pending-draft.txt' }
    const receipt = await f.services.taskAttachmentFiles.write(orphanTask.id, record, f.bytes, { beforeEffect() {}, signal: new AbortController().signal })
    f.services.taskAttachmentFiles.commit(receipt)
    expect(f.services.db.getTask(orphanTask.id)?.attachments).toEqual([])
    const saved = join(f.bootstrap.paths.attachmentRoot, orphanTask.id, `${record.id}-${record.filename}`)
    await f.owner.close()
    vi.resetModules()
    const { ProductionOwner } = await import('./production-owner')
    const reopened = new ProductionOwner({ ...f.bootstrap, credentials: { ...f.bootstrap.credentials, mode: 'load' } }, {
      cliMcp: { homeDir: f.root, environment: {} }, createAdapter: () => new FakeAdapter()
    })
    fixtures.find(item => item.owner === f.owner)!.owner = reopened
    const services = await reopened.start()
    expect(services.db.getTask(orphanTask.id)?.attachments).toEqual([])
    expect(readFileSync(saved)).toEqual(f.bytes)
    const rows = services.db.db.prepare('SELECT value FROM settings WHERE key GLOB ?').all('__attachment_journal_v1:*') as Array<{ value: string }>
    const ownership = rows.map(row => JSON.parse(row.value)).filter(row => row.taskId === orphanTask.id)
    expect(ownership).toHaveLength(1)
    expect(ownership[0]).toMatchObject({ version: 1, kind: 'publication', phase: 'published', taskId: orphanTask.id, attachment: record })
  })
  it('refuses a saved-file symlink before an actual adapter receives attachment references', async () => {
    const f = await fixture(), outside = join(f.root, 'foreign-private.txt')
    writeFileSync(outside, 'foreign private bytes'); unlinkSync(f.saved); symlinkSync(outside, f.saved)
    await expect(f.services.agents.requestSession(f.agent.id, f.task.id)).rejects.toThrow()
    expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(readFileSync(outside, 'utf8')).toBe('foreign private bytes')
  })
  it('never overwrites an outside file through a workspace attachments directory symlink', async () => {
    const f = await fixture(), outside = join(f.root, 'outside-workspace')
    mkdirSync(outside); writeFileSync(join(outside, f.attachment.filename), 'outside remains')
    mkdirSync(f.workspace, { recursive: true }); symlinkSync(outside, join(f.workspace, 'attachments'))
    await expect(f.services.agents.requestSession(f.agent.id, f.task.id)).rejects.toThrow()
    expect(readFileSync(join(outside, f.attachment.filename), 'utf8')).toBe('outside remains')
    expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
  })
  it('does not read a foreign workspace symlink into an attachment preview', async () => {
    const f = await fixture(), outside = join(f.root, 'outside-preview.txt')
    const started = await f.services.agents.requestSession(f.agent.id, f.task.id)
    expect(started.status).toBe('started')
    f.adapter.sendPrompt.mockClear()
    writeFileSync(outside, 'foreign-preview-canary')
    unlinkSync(join(f.workspace, 'attachments', f.attachment.filename)); symlinkSync(outside, join(f.workspace, 'attachments', f.attachment.filename))
    await f.services.agents.sendByTaskId(f.task.id, 'inspect the saved file', [f.attachment])
    await vi.waitFor(() => expect(f.adapter.sendPrompt).toHaveBeenCalledOnce())
    const prompt = JSON.stringify(f.adapter.sendPrompt.mock.calls)
    expect(prompt).not.toContain('foreign-preview-canary'); expect(prompt).toContain('owned bytes')
    expect(readFileSync(outside, 'utf8')).toBe('foreign-preview-canary')
  })
  it.each(['task', 'project', 'agent'] as const)('withdraws the original retained %s grant before a held file read can publish or prompt', async kind => {
    const gate = held(), reading = held(), f = await fixture({ promise: gate.promise, opened: reading.release })
    const { ProductionAgentBackend } = await import('./production-agent-backend')
    const { PRODUCTION_AGENT_CODECS } = await import('../shared/production-agent-codecs')
    const allowed = { task: true, project: true, agent: true }
    const identity = { principal: 'trusted-desktop-main' as const, engineEpoch: f.owner.snapshot().epoch, webviewId: 'main', origin: 'app://attachment-execution' }
    const backend = new ProductionAgentBackend({ database: f.services.db, manager: f.services.agents, engineEpoch: identity.engineEpoch,
      assertAvailable: () => { f.owner.getDatabaseBindingLease() }, isTrustedDesktop: () => true,
      canAccessTask: () => allowed.task, canAccessProject: () => allowed.project, canAccessAgent: () => allowed.agent })
    backends.push(backend)
    const pending = backend.registry.invoke('agentSession:start', PRODUCTION_AGENT_CODECS['agentSession:start'].encodeArguments([f.agent.id, f.task.id]), identity, new AbortController().signal)
    const rejected = expect(pending).rejects.toBeDefined()
    await reading.promise; allowed[kind] = false; gate.release(); await rejected
    expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(readFileSync(f.saved)).toEqual(f.bytes)
  })
  it('joins a cancelled retained file read and profile shutdown before releasing the original owner', async () => {
    const gate = held(), reading = held(), f = await fixture({ promise: gate.promise, opened: reading.release })
    const cancel = new AbortController()
    const pending = f.services.agents.withTaskGroupRequestGuard(() => f.services.agents.requestSession(f.agent.id, f.task.id), () => {}, cancel.signal)
    const rejected = expect(pending).rejects.toBeDefined()
    await reading.promise; cancel.abort()
    await expect(f.owner.close(20)).rejects.toMatchObject({ code: 'OWNER_DRAIN_BLOCKED' })
    expect(f.services.db.db.open).toBe(true); expect(f.services.taskAttachmentFiles.inflightCount).toBeGreaterThan(0)
    gate.release(); await rejected; await f.owner.close()
    expect(f.services.db.db.open).toBe(false); expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(readFileSync(f.saved)).toEqual(f.bytes)
  })
  it('uses the same protected copy authority for a real retained session resume', async () => {
    const f = await fixture(), started = await f.services.agents.requestSession(f.agent.id, f.task.id)
    if (started.status !== 'started') throw new Error('Fixture start was not admitted')
    await f.services.agents.stopSession(started.sessionId, false)
    const resumed = await f.services.agents.resumeSession(f.agent.id, f.task.id, started.sessionId)
    expect(resumed).toBe(started.sessionId); expect(f.adapter.resumeSession).toHaveBeenCalledOnce()
    expect(readFileSync(join(f.workspace, 'attachments', f.attachment.filename))).toEqual(f.bytes)
    await f.services.agents.stopSession(started.sessionId, false)
    f.adapter.resumeSession.mockClear()
    const outside = join(f.root, 'outside-resume.txt'); writeFileSync(outside, 'outside resume bytes')
    unlinkSync(f.saved); symlinkSync(outside, f.saved)
    await expect(f.services.agents.resumeSession(f.agent.id, f.task.id, started.sessionId)).rejects.toThrow()
    expect(f.adapter.resumeSession).not.toHaveBeenCalled(); expect(readFileSync(outside, 'utf8')).toBe('outside resume bytes')
  })
  it.each(['metadata', 'parent'] as const)('keeps the retained request original %s before raw adapter initialization settles', async field => {
    const f = await fixture(), gate = held(), initializing = held()
    f.adapter.initialize.mockImplementationOnce(async () => { initializing.release(); await gate.promise })
    const { ProductionAgentBackend } = await import('./production-agent-backend')
    const { PRODUCTION_AGENT_CODECS } = await import('../shared/production-agent-codecs')
    const identity = { principal: 'trusted-desktop-main' as const, engineEpoch: f.owner.snapshot().epoch, webviewId: 'main', origin: 'app://attachment-execution' }
    const backend = new ProductionAgentBackend({ database: f.services.db, manager: f.services.agents, engineEpoch: identity.engineEpoch,
      assertAvailable: () => { f.owner.getDatabaseBindingLease() }, isTrustedDesktop: () => true,
      canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true })
    backends.push(backend)
    const pending = backend.registry.invoke('agentSession:start', PRODUCTION_AGENT_CODECS['agentSession:start'].encodeArguments([f.agent.id, f.task.id]), identity, new AbortController().signal), rejected = expect(pending).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await initializing.promise
    if (field === 'metadata') f.services.db.updateTask(f.task.id, { attachments: [] })
    else f.services.db.updateTask(f.task.id, { parent_task_id: f.services.db.createTask({ title: 'Replacement parent' })!.id })
    gate.release(); await rejected
    expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(readFileSync(f.saved)).toEqual(f.bytes)
  })
})
if (process.platform !== 'linux') it('refuses real saved-attachment dispatch on this unsupported platform without an ambient fallback', async () => {
  const f = await fixture()
  await expect(f.services.agents.requestSession(f.agent.id, f.task.id)).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_UNAVAILABLE' })
  expect(f.adapter.sendPrompt).not.toHaveBeenCalled(); expect(readFileSync(f.saved)).toEqual(f.bytes)
})
