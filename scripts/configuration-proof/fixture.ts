import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseManager, type DatabaseRuntimeOptions } from '../../src/main/database/manager'
import type { SkillRecord, ProjectRepoRecord, ProjectResourceRecord } from '../../src/main/database/types'
import { acquireProfileLock } from '../../src/main/platform/profile-lock'
import { AuthenticatedSecretStorage } from '../../src/main/platform/authenticated-secret-storage'
import { configureSecretStorage } from '../../src/main/platform/secret-storage'
import { ConfigurationBackend, CONFIGURATION_BOUND_OPERATIONS } from '../../src/service/configuration-backend'
import { CONFIGURATION_COMMAND_CODECS, type ConfigurationDesktopOperation } from '../../src/shared/configuration-desktop-codecs'
import { ServiceProtocolError, isRecord, type JsonValue } from '../../src/shared/service-protocol'
import type { DesktopCallerContext } from '../../src/service/transport/desktop-registry'
import { DEFAULT_PROJECT_ID } from '../../src/shared/projects'

export class ConfigurationProofError extends Error {
  constructor(readonly phase: string) { super('Configuration proof failed') }
}

/** Real private SQLite, no profile reuse, AgentManager simulation or Electron shim. */
export async function runConfigurationFixture(directory: string) {
  assert.equal(process.versions.electron, undefined)
  const profileRoot = join(directory, 'profile')
  mkdirSync(profileRoot)
  const lock = acquireProfileLock(profileRoot)
  const key = randomBytes(32)
  const storage = new AuthenticatedSecretStorage(key, 'configuration-proof')
  key.fill(0)
  configureSecretStorage(storage)
  const runtime: DatabaseRuntimeOptions = {
    paths: { profileRoot: lock.profileRoot, workspaceRoot: join(directory, 'workspaces'), attachmentRoot: join(directory, 'attachments') },
    managedTaskMcp: { disabled: true }, logger: { log() {}, error() {} }
  }
  let db = new DatabaseManager(runtime)
  let phase = 'initialize'
  try {
    db.initialize()
    const a = db.createProject({ name: 'Fixture A' })!
    const b = db.createProject({ name: 'Fixture B' })!
    const allProjects = new Set([DEFAULT_PROJECT_ID, a.id, b.id])
    const ownA = new Set([a.id])
    const admin: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'fixture:1', webviewId: 'admin', origin: 'app://fixture' }
    const user: DesktopCallerContext = { ...admin, webviewId: 'user' }
    const mover: DesktopCallerContext = { ...admin, webviewId: 'mover' }
    const events: Array<{ operation: string; payload: JsonValue }> = []
    let available = true
    let accessHook: (() => void) | undefined
    const backend = new ConfigurationBackend({
      database: db, engineEpoch: admin.engineEpoch,
      assertAvailable() { lock.assertHeld(); if (!available || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') },
      isTrustedDesktop: caller => caller.origin === admin.origin && ['admin', 'user', 'mover'].includes(caller.webviewId ?? ''),
      canAccessProject(id, caller) { accessHook?.(); return (caller.webviewId === 'admin' ? allProjects : ownA).has(id) },
      canAccessGlobalSkills: (caller, access) => access === 'read' || ['admin', 'mover'].includes(caller.webviewId ?? ''),
      canChangeSkillScope: caller => ['admin', 'mover'].includes(caller.webviewId ?? ''),
      canReorderProjects: caller => caller.webviewId === 'admin',
      emit: (operation, payload) => events.push({ operation, payload })
    })
    const signal = new AbortController().signal
    async function call(operation: ConfigurationDesktopOperation, args: unknown[], caller = admin, abortSignal = signal): Promise<JsonValue | undefined> {
      const payload = CONFIGURATION_COMMAND_CODECS[operation].encodeArguments(args as never)
      const result = await backend.registry.invoke(operation, payload, caller, abortSignal)
      assert.ok(isRecord(result))
      return result.defined ? result.value as JsonValue : undefined
    }
    const rejected = (action: Promise<unknown>, code: string) => assert.rejects(action, error => error instanceof ServiceProtocolError && error.code === code)
    assert.equal(CONFIGURATION_BOUND_OPERATIONS.length, 18)
    assert.equal(Object.keys(backend.operationSchemas(admin)).length, 18)
    for (const operation of ['agent:getAll', 'agent:create', 'agent:update', 'agent:delete'] as const) {
      await rejected(backend.registry.invoke(operation, {}, admin, signal), 'UNKNOWN_OPERATION')
    }
    phase = 'skill-create-and-scope'
    const global = await call('skills:create', [{ name: 'fixture-global', description: '', content: '\uFEFFglobal 你好' }]) as unknown as SkillRecord
    const skillA = await call('skills:create', [{ name: 'fixture-a', description: '', content: 'A', project_id: a.id }], user) as unknown as SkillRecord
    const skillB = await call('skills:create', [{ name: 'fixture-b', description: '', content: 'B', project_id: b.id }]) as unknown as SkillRecord
    assert.ok((await call('skills:getAll', [], user) as unknown as SkillRecord[]).some(skill => skill.id === global.id))
    assert.ok(!(await call('skills:getAll', [], user) as unknown as SkillRecord[]).some(skill => skill.id === skillB.id))
    const unchangedEvents = events.length
    await rejected(call('skills:create', [{ name: 'denied-global', description: '', content: '' }], user), 'INVALID_REQUEST')
    await rejected(call('skills:update', [global.id, { content: 'denied' }], user), 'INVALID_REQUEST')
    await rejected(call('skills:delete', [skillB.id], user), 'INVALID_REQUEST')
    await rejected(call('skills:setProject', [skillB.id, a.id], mover), 'INVALID_REQUEST')
    await rejected(call('skills:setProject', [skillA.id, b.id], mover), 'INVALID_REQUEST')
    await rejected(call('skills:setProject', [skillA.id, null], user), 'INVALID_REQUEST')
    assert.equal(events.length, unchangedEvents)
    phase = 'skill-version-conflict'
    const updated = await call('skills:update', [skillA.id, { content: 'updated', expected_version: 1 }], user) as unknown as SkillRecord
    assert.equal(updated.version, 2)
    const beforeConflict = events.length
    await rejected(call('skills:update', [skillA.id, { content: 'stale', expected_version: 1 }], user), 'SKILL_VERSION_CONFLICT')
    assert.equal(db.getSkill(skillA.id)?.content, 'updated')
    assert.equal(events.length, beforeConflict)
    assert.equal(await call('skills:update', ['missing', {}], user), undefined)
    assert.equal(await call('skills:delete', ['missing'], user), false)
    phase = 'skill-reassignment'
    await call('skills:setProject', [skillA.id, null], admin)
    assert.equal(db.getSkill(skillA.id)?.project_id, null)
    await call('skills:setProject', [skillA.id, a.id], admin)
    const foreignTask = db.createTask({ title: 'Reference fixture', project_id: b.id })!
    // Assignment is an update API; CreateTaskData does not accept skill_ids.
    db.updateTask(foreignTask.id, { skill_ids: [global.id] })
    await rejected(call('skills:setProject', [global.id, a.id]), 'INVALID_REQUEST')
    db.updateTask(foreignTask.id, { skill_ids: [] })
    const agent = db.getAgents()[0]
    const previousConfig = agent.config
    db.updateAgent(agent.id, { config: { ...previousConfig, skill_ids: [global.id] } })
    await rejected(call('skills:setProject', [global.id, a.id]), 'INVALID_REQUEST')
    db.updateAgent(agent.id, { config: previousConfig })
    await call('skills:setProject', [global.id, a.id])
    assert.equal(db.getSkill(global.id)?.project_id, a.id)

    phase = 'child-crud-and-association'
    const repoA = await call('projectRepo:add', [a.id, { name: 'first', org: 'group/subgroup' }], user) as unknown as ProjectRepoRecord
    const repoA2 = await call('projectRepo:add', [a.id, { name: 'second' }], user) as unknown as ProjectRepoRecord
    const repoB = await call('projectRepo:add', [b.id, { name: 'foreign' }]) as unknown as ProjectRepoRecord
    const resourceA = await call('projectResource:add', [a.id, { label: 'Context', url: 'file:///context', notes: 'metadata only' }], user) as unknown as ProjectResourceRecord
    const resourceB = await call('projectResource:add', [b.id, { label: 'Foreign context' }]) as unknown as ProjectResourceRecord
    for (const operation of ['projectRepo:update', 'projectRepo:remove'] as const) {
      await rejected(call(operation, operation.endsWith('update') ? [repoB.id, { name: 'denied' }] : [repoB.id], user), 'INVALID_REQUEST')
    }
    for (const operation of ['projectResource:update', 'projectResource:remove'] as const) {
      await rejected(call(operation, operation.endsWith('update') ? [resourceB.id, { label: 'denied' }] : [resourceB.id], user), 'INVALID_REQUEST')
    }
    await rejected(call('projectRepo:list', [b.id], user), 'INVALID_REQUEST')
    await rejected(call('projectResource:add', [b.id, { label: 'denied' }], user), 'INVALID_REQUEST')
    await rejected(call('projectRepo:reorder', [a.id, [repoA.id]], user), 'INVALID_REQUEST')
    await rejected(call('projectRepo:reorder', [a.id, [repoA.id, repoB.id]], user), 'INVALID_REQUEST')
    assert.deepEqual(db.getProjectRepos(a.id).map(repo => repo.id), [repoA.id, repoA2.id])
    await call('projectRepo:reorder', [a.id, [repoA2.id, repoA.id]], user)
    assert.deepEqual(db.getProjectRepos(a.id).map(repo => repo.id), [repoA2.id, repoA.id])
    await rejected(call('projectResource:reorder', [a.id, [resourceB.id]], user), 'INVALID_REQUEST')
    await call('projectResource:reorder', [a.id, [resourceA.id]], user)
    await call('projectRepo:update', [repoA.id, { default_branch: 'fixture' }], user)
    await call('projectResource:update', [resourceA.id, { notes: '\uFEFFnotes 你好' }], user)

    // Inject a malformed return after an actual INSERT, verifying that output
    // validation rolls back SQLite rather than leaving an unacknowledged row.
    phase = 'result-rollback'
    const addRepo = db.addProjectRepo
    const repoCount = db.getProjectRepos(a.id).length
    const eventsBeforeInvalidResult = events.length
    db.addProjectRepo = function (id, data) {
      const created = addRepo.call(this, id, data)
      return created ? { ...created, name: '\0invalid' } : created
    }
    try {
      await rejected(call('projectRepo:add', [a.id, { name: 'rollback fixture' }], user), 'INVALID_RESULT')
    } finally { db.addProjectRepo = addRepo }
    assert.equal(db.getProjectRepos(a.id).length, repoCount)
    assert.equal(events.length, eventsBeforeInvalidResult)

    // Authorization must be checked after registry's await, not cached by ID.
    phase = 'revocation-and-cancellation'
    let accessCalls = 0
    accessHook = () => { if (++accessCalls === 2) ownA.delete(a.id) }
    await rejected(call('projectRepo:update', [repoA.id, { name: 'revoked' }], user), 'INVALID_REQUEST')
    accessHook = undefined
    ownA.add(a.id)
    assert.equal(db.getProjectRepo(repoA.id)?.name, 'first')
    const aborted = new AbortController()
    aborted.abort()
    await rejected(call('projectResource:remove', [resourceA.id], user, aborted.signal), 'CANCELLED')
    assert.ok(db.getProjectResource(resourceA.id))
    phase = 'project-protection-and-reorder'
    await rejected(call('project:archive', [DEFAULT_PROJECT_ID]), 'INVALID_REQUEST')
    await rejected(call('project:update', [b.id, { description: 'denied' }], user), 'INVALID_REQUEST')
    await rejected(call('project:update', [a.id, { settings: { api_keys: 'denied' } }]), 'INVALID_ARGUMENTS')
    await rejected(call('project:update', [a.id, { default_agent_id: agent.id }]), 'INVALID_ARGUMENTS')
    await call('project:update', [a.id, { description: 'durable brief' }], user)
    await call('project:archive', [b.id])
    await rejected(call('project:reorder', [[DEFAULT_PROJECT_ID, a.id]]), 'INVALID_REQUEST')
    await rejected(call('project:reorder', [[b.id, a.id, DEFAULT_PROJECT_ID]], user), 'INVALID_REQUEST')
    await call('project:reorder', [[b.id, a.id, DEFAULT_PROJECT_ID]])
    assert.deepEqual(db.getProjects({ includeArchived: true }).map(project => project.id), [b.id, a.id, DEFAULT_PROJECT_ID])
    await call('project:archive', [b.id, false])

    // Result projection fails inside the transaction: no durable write/event.
    phase = 'private-fields-and-events'
    db.updateProject(a.id, { settings: { nested: { mcp_scope_nonce: 'private-fixture' } } })
    const beforeRollback = events.length
    await rejected(call('project:update', [a.id, { description: 'rolled back' }]), 'INVALID_RESULT')
    assert.equal(db.getProject(a.id)?.description, 'durable brief')
    assert.equal(events.length, beforeRollback)
    db.updateProject(a.id, { settings: {} })
    await call('projectRepo:remove', [repoA2.id], user)
    await call('projectResource:remove', [resourceB.id])
    await call('skills:delete', [skillB.id])
    assert.ok(events.some(event => event.operation === 'skills:changed' && isRecord(event.payload) && event.payload.kind === 'scope'))
    assert.equal(JSON.stringify(events).includes('private-fixture'), false)
    await rejected(backend.registry.invoke('skills:getAll', {}, { ...admin, principal: 'service' }, signal), 'INVALID_REQUEST')
    await rejected(backend.registry.invoke('skills:getAll', {}, { ...admin, engineEpoch: 'old:1' }, signal), 'STALE_EPOCH')
    phase = 'durable-reopen'
    available = false
    await rejected(call('skills:update', [skillA.id, { content: 'closed' }]), 'INVALID_REQUEST')
    available = true
    db.close()
    db = new DatabaseManager(runtime)
    db.initialize()
    assert.equal(db.getProject(a.id)?.description, 'durable brief')
    assert.equal(db.getSkill(skillA.id)?.content, 'updated')
    assert.equal(db.getSkill(skillB.id), undefined)
    assert.equal(db.getProjectRepo(repoA.id)?.default_branch, 'fixture')
    assert.equal(db.getProjectRepo(repoA2.id), undefined)
    assert.equal(db.getProjectResource(resourceA.id)?.notes, '\uFEFFnotes 你好')
    assert.equal(db.getProjectResource(resourceB.id), undefined)
    assert.equal(db.getProject(DEFAULT_PROJECT_ID)?.archived, false)
    return {
      reportVersion: 1, passed: true, runtime: 'standalone-node', boundCommands: 18,
      proofs: ['caller-project-association', 'skill-current-destination-authority', 'skill-version-conflict', 'complete-reorder-sets', 'transaction-rollback', 'durable-reopen', 'agent-crud-unbound', 'reference-safe-scope-move', 'cancel-before-effects', 'epoch-identity-checks']
    }
  } catch { throw new ConfigurationProofError(phase) }
  finally {
    db.close()
    storage.dispose()
    lock.release()
  }
}
