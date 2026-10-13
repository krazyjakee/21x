/** Content configuration through the real staged private-pipe service. */
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { connectDatabaseService } from './database-service-proof.mjs'

export async function runConfigurationServiceProof({ serviceEntry, node = process.env.TAURI_NODE_RUNTIME || 'node' }) {
  const entry = await realpath(serviceEntry)
  const resourceRoot = await realpath(dirname(dirname(entry)))
  const profileRoot = await realpath(await mkdtemp(join(tmpdir(), '21x-database-service-')))
  const clients = []
  const start = () => { const client = connectDatabaseService({ node, entry, resourceRoot, profileRoot }); clients.push(client); return client }
  const report = { reportVersion: 1, passed: false, actualBundledService: true, syntheticOnly: true, phase: 'initialize' }
  const commands = new Set()
  try {
    const client = start()
    await client.initialize()
    const command = (operation, payload, options) => { commands.add(operation); return client.command(operation, payload, options) }
    const project = await client.command('project:create', { data: { name: 'Configuration proof' } })
    const other = await client.command('project:create', { data: { name: 'Foreign reorder proof' } })
    const defaultProject = await client.command('project:getDefault', {})
    report.phase = 'project-content'
    const edited = await command('project:update', { id: project.id, data: { description: 'Persisted project note', git_provider: 'github', git_org: 'fixture' } })
    assert.equal(edited.description, 'Persisted project note')
    assert.equal((await command('project:archive', { id: project.id })).archived, true)
    assert.equal((await command('project:archive', { id: project.id, archived: false })).archived, false)
    const order = (await client.command('project:getAll', { includeArchived: true })).map(row => row.id).reverse()
    assert.equal(await command('project:reorder', { orderedIds: order }), undefined)
    assert.deepEqual((await client.command('project:getAll', { includeArchived: true })).map(row => row.id), order)
    await assert.rejects(command('project:archive', { id: defaultProject.id }), { code: 'INVALID_REQUEST' })
    await assert.rejects(command('project:update', { id: project.id, data: { settings: { max_concurrent_agents: 999 } } }), { code: 'INVALID_ARGUMENTS' })

    report.phase = 'skills-and-conflicts'
    const skill = await command('skills:create', { data: { name: 'Fixture skill', description: 'Synthetic instructions', content: 'Saved instructions', project_id: project.id } })
    const changed = await command('skills:update', { id: skill.id, data: { content: 'Edited instructions', expected_version: skill.version } })
    assert.ok(changed.version > skill.version)
    const beforeConflict = client.events.length
    await assert.rejects(command('skills:update', { id: skill.id, data: { content: 'Rejected stale write', expected_version: skill.version } }), { code: 'SKILL_VERSION_CONFLICT' })
    assert.equal(client.events.length, beforeConflict)
    assert.equal((await command('skills:getAll', {})).find(row => row.id === skill.id).content, changed.content)
    assert.equal((await command('skills:setProject', { id: skill.id, projectId: null })).project_id, null)
    assert.equal((await command('skills:setProject', { id: skill.id, projectId: project.id })).project_id, project.id)
    assert.equal(await command('skills:update', { id: 'missing', data: { content: 'none' } }), undefined)
    assert.equal(await command('skills:delete', { id: 'missing' }), false)
    await assert.rejects(command('skills:update', { id: skill.id, data: { content: 'Cancelled' } }, { cancelImmediately: true }), { code: 'CANCELLED' })

    report.phase = 'repositories-and-resources'
    const retained = {}
    for (const [family, data, update] of [
      ['projectRepo', { name: 'fixture-repo', provider: 'github', org: 'test', default_branch: 'main' }, { default_branch: 'release' }],
      ['projectResource', { label: 'Fixture note', url: null, notes: 'Saved context' }, { notes: 'Edited context' }]
    ]) {
      const first = await command(`${family}:add`, { projectId: project.id, data })
      const second = await command(`${family}:add`, { projectId: project.id, data })
      const foreign = await command(`${family}:add`, { projectId: other.id, data })
      const row = await command(`${family}:update`, { id: first.id, data: update })
      for (const [key, value] of Object.entries(update)) assert.equal(row[key], value)
      const childOrder = [second.id, first.id]
      assert.equal(await command(`${family}:reorder`, { projectId: project.id, orderedIds: childOrder }), undefined)
      assert.deepEqual((await command(`${family}:list`, { projectId: project.id })).map(item => item.id), childOrder)
      await assert.rejects(command(`${family}:reorder`, { projectId: project.id, orderedIds: [foreign.id, first.id] }), { code: 'INVALID_REQUEST' })
      assert.equal(await command(`${family}:remove`, { id: second.id }), true)
      assert.equal(await command(`${family}:remove`, { id: second.id }), false)
      assert.equal(await command(`${family}:update`, { id: 'missing', data: update }), undefined)
      retained[family] = first.id
    }
    await assert.rejects(client.request('agent:create', { data: { name: 'Forbidden owner bypass' } }), { code: 'UNKNOWN_OPERATION' })
    await assert.rejects(client.command('skills:getAll', {}, { epoch: 'stale' }), { code: 'STALE_EPOCH' })
    assert.ok(client.events.some(event => event.operation === 'skills:changed' && event.payload.kind === 'scope'))
    assert.ok(client.events.every(event => event.engineEpoch === client.epoch()))
    const skillEvents = client.events.filter(event => event.operation === 'skills:changed')
    assert.ok(skillEvents.every(event => Object.keys(event.payload).sort().join(',') === 'kind,skillId'))
    report.phase = 'shutdown-and-reopen'
    await client.request('engine.shutdown', {})
    assert.equal((await client.waitClosed()).code, 0)
    const reopened = start()
    await reopened.initialize()
    assert.notEqual(reopened.epoch(), client.epoch())
    assert.equal((await reopened.command('project:get', { id: project.id })).description, edited.description)
    assert.equal((await reopened.command('skills:getAll', {})).find(row => row.id === skill.id).content, changed.content)
    for (const [family, id] of Object.entries(retained)) assert.equal((await reopened.command(`${family}:list`, { projectId: project.id }))[0].id, id)
    assert.equal(await reopened.command('skills:delete', { id: skill.id }), true)
    commands.add('skills:delete')
    await reopened.request('engine.shutdown', {})
    assert.equal((await reopened.waitClosed()).code, 0)
    assert.equal(commands.size, 18)
    Object.assign(report, { passed: true, phase: 'complete', contentCommands: commands.size, commands: [...commands].sort(),
      skillConflictsPreserved: true, invalidReordersRejected: true, lifecycleFieldsRejected: true, publicInvalidationsOnly: true,
      cancellationBeforeEffects: true, newEpochAndDurability: true, acknowledgedServiceExit: true })
  } catch (error) {
    report.errorCode = ['INVALID_ARGUMENTS', 'INVALID_REQUEST', 'INVALID_RESULT', 'INVALID_OUTPUT', 'SKILL_VERSION_CONFLICT', 'DISCONNECTED', 'TIMEOUT'].includes(error.code) ? error.code : 'PROOF_FAILED'
  } finally {
    let stopped = true
    for (const client of clients) { try { await client.stop() } catch { stopped = false } }
    if (stopped) { await rm(profileRoot, { recursive: true, force: true }); report.syntheticProfileRemoved = true }
    else { report.passed = false; report.syntheticProfileRemoved = false }
  }
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runConfigurationServiceProof({ serviceEntry: process.env.TAURI_DATABASE_SERVICE_ENTRY })
    console.log(JSON.stringify(report, null, 2))
    if (!report.passed) process.exitCode = 1
  } catch { console.error('Explicit staged configuration service unavailable.'); process.exitCode = 1 }
}
