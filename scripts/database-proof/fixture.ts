import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseManager, type DatabaseRuntimeOptions } from '../../src/main/database/manager'
import { seedTaskManagementMcpServer, AmbiguousManagedMcpServerError } from '../../src/main/database/seed-core'
import { configureSecretStorage } from '../../src/main/platform/secret-storage'
import { AuthenticatedSecretStorage } from '../../src/main/platform/authenticated-secret-storage'

/** Runs in a real standalone Node process, with no Electron shim or production profile. */
export function runDatabaseFixture(directory: string) {
  assert.equal(process.versions.electron, undefined, 'Standalone Node is required')
  const paths = {
    profileRoot: join(directory, 'profile'),
    workspaceRoot: join(directory, 'workspaces'),
    attachmentRoot: join(directory, 'attachments')
  }
  mkdirSync(paths.profileRoot)
  const key = randomBytes(32)
  const storage = new AuthenticatedSecretStorage(key, 'database-proof')
  key.fill(0)
  configureSecretStorage(storage)
  const options: DatabaseRuntimeOptions = {
    paths,
    managedTaskMcp: {
      command: process.execPath,
      args: [join(directory, 'fixture-task-management.js')],
      environment: {},
      tools: [{ name: 'fixture_task_list', description: 'Synthetic metadata; no real MCP server is started' }]
    },
    logger: { log() {}, error() {} }
  }
  let manager: DatabaseManager | undefined
  try {
    assert.throws(() => new DatabaseManager({ ...options, paths: { ...paths, profileRoot: 'relative' } }))
    assert.throws(() => new DatabaseManager({ ...options, managedTaskMcp: { ...options.managedTaskMcp, command: 'node' } }))
    assert.throws(() => new DatabaseManager({ ...options, managedTaskMcp: undefined as never }))
    manager = new DatabaseManager(options)
    // The manager takes an immutable configuration snapshot.
    const originalCommand = options.managedTaskMcp.command
    options.managedTaskMcp.command = join(directory, 'mutated-executable')
    manager.initialize()
    const db = manager
    assert.equal(db.getSetting('__schema_version'), '32')
    assert.equal(db.db.pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(db.db.pragma('foreign_keys', { simple: true }), 1)
    assert.equal(db.db.pragma('busy_timeout', { simple: true }), 5000)
    const defaultAgent = db.getAgents().find((agent) => agent.is_default)!
    assert.ok(defaultAgent)
    const initialCaptains = db.getTasks({ includeCoordinators: true }).filter((task) => task.role === 'captain')
    assert.equal(initialCaptains.length, db.getProjects().length)
    assert.equal(db.getTasks().length, 0)
    const managed = db.getMcpServers().find((server) => server.name === 'task-management')!
    assert.equal(managed.command, originalCommand)
    assert.deepEqual(managed.tools, options.managedTaskMcp.tools)
    assert.deepEqual(managed.environment, {})
    assert.ok(defaultAgent.config.mcp_servers?.some((entry) => (typeof entry === 'string' ? entry : entry.serverId) === managed.id))

    const task = db.createTask({ title: 'Portable fixture task', description: 'Synthetic durable data' })!
    assert.equal(db.getTask(task.id)?.title, task.title)
    const project = db.createProject({ name: 'Synthetic second project' })!
    assert.equal(db.getCoordinatorTask(project.id)?.project_id, project.id)
    const otherTask = db.createTask({ title: 'Other project task', project_id: project.id })!
    db.upsertTranscriptParts(task.id, [
      { id: 'user-1', role: 'user', content: 'hello' },
      { id: 'assistant-1', role: 'assistant', content: 'partial' }
    ], 'live')
    const snapshot = db.getTranscriptParts(task.id)
    const cursor = db.getTranscriptMaxRev(task.id)
    assert.deepEqual(snapshot.map((part) => part.partId), ['user-1', 'assistant-1'])
    db.upsertTranscriptParts(otherTask.id, [{ id: 'assistant-1', role: 'assistant', content: 'isolated' }])
    const update = db.upsertTranscriptParts(task.id, [{ id: 'assistant-1', role: 'assistant', content: 'complete', tool: { name: 'fixture' } }], 'live')
    const delta = db.getTranscriptDelta(task.id, cursor)
    assert.equal(delta.maxRev, update.maxRev)
    assert.deepEqual(delta.parts.map((part) => [part.partId, part.seq, part.content]), [['assistant-1', snapshot[1].seq, 'complete']])
    assert.deepEqual(db.getTranscriptDelta(task.id, delta.maxRev).parts, [])
    assert.deepEqual(db.getTranscriptParts(task.id, snapshot[0].seq).map((part) => part.partId), ['assistant-1'])
    assert.deepEqual(db.upsertTranscriptParts(task.id, [{ id: 'assistant-1', role: 'assistant', content: 'complete', tool: { name: 'fixture' } }]).changedPartIds, [])

    assert.equal(db.getWorkspaceDir(task.id), join(paths.workspaceRoot, task.id))
    const attachments = db.getAttachmentsDir(task.id)
    const retainedAttachments = db.getAttachmentsDir(otherTask.id)
    writeFileSync(join(attachments, 'fixture.txt'), 'synthetic attachment')
    writeFileSync(join(retainedAttachments, 'keep.txt'), 'retained')
    db.deleteTaskAttachments(task.id)
    assert.equal(existsSync(attachments), false)
    assert.equal(existsSync(join(retainedAttachments, 'keep.txt')), true)

    db.setSetting('synthetic_api_key', '\uFEFFfixture-secret-你好')
    assert.equal(db.getSetting('synthetic_api_key'), '\uFEFFfixture-secret-你好')
    assert.equal(db.getAllSettings().synthetic_api_key, '\uFEFFfixture-secret-你好')
    const rawKey = (db.db.prepare('SELECT value FROM settings WHERE key = ?').get('synthetic_api_key') as { value: string }).value
    assert.ok(rawKey.startsWith('safeStorage:v1:')) // Preserve existing settings storage semantics.
    assert.equal(rawKey.includes('fixture-secret'), false)
    const originalManaged = db.getMcpServer(managed.id)!
    assert.throws(() => seedTaskManagementMcpServer(db.db, { ...options.managedTaskMcp, command: originalCommand }), AmbiguousManagedMcpServerError)
    assert.deepEqual(db.getMcpServer(managed.id), originalManaged)
    assert.throws(() => seedTaskManagementMcpServer(db.db, {
      ...options.managedTaskMcp, command: originalCommand, existingServer: { policy: 'verified-id', id: 'wrong-id' }
    }), AmbiguousManagedMcpServerError)
    db.close()
    assert.equal(db.db.open, false)
    const reopenOptions: DatabaseRuntimeOptions = {
      ...options,
      managedTaskMcp: { ...options.managedTaskMcp, command: originalCommand, existingServer: { policy: 'verified-id', id: managed.id } }
    }
    manager = new DatabaseManager(reopenOptions)
    manager.initialize()
    assert.equal(manager.getTask(task.id)?.title, task.title)
    assert.equal(manager.getTranscriptParts(task.id)[1].content, 'complete')
    assert.deepEqual(manager.getTranscriptDelta(task.id, cursor).parts, delta.parts)
    assert.equal(manager.getTranscriptMaxRev(task.id), delta.maxRev)
    assert.equal(manager.getSetting('synthetic_api_key'), '\uFEFFfixture-secret-你好')
    assert.equal(manager.getAgents().filter((agent) => agent.is_default).length, 1)
    assert.equal(manager.getMcpServers().filter((server) => server.name === 'task-management').length, 1)
    assert.equal(manager.getTasks({ includeCoordinators: true }).filter((row) => row.role === 'captain').length, manager.getProjects().length)
    manager.close()
    // Reopening without proven ownership fails closed and releases the connection.
    manager = new DatabaseManager({ ...options, managedTaskMcp: { ...options.managedTaskMcp, command: originalCommand } })
    assert.throws(() => manager!.initialize(), AmbiguousManagedMcpServerError)
    assert.equal(manager.db.open, false)
    return {
      reportVersion: 1,
      passed: true,
      runtime: 'standalone-node',
      schemaVersion: 32,
      proofs: ['task-crud', 'durable-transcript-snapshot-delta-reopen', 'project-captain-seeds', 'explicit-paths', 'encrypted-settings-provider', 'managed-mcp-idempotency-ownership']
    }
  } finally {
    manager?.close()
    storage.dispose()
  }
}
