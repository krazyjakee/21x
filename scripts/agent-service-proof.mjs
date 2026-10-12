/** Actual staged bundled service over owned anonymous pipes; no build/install. */
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { connectDatabaseService } from './database-service-proof.mjs'

export async function runAgentServiceProof({ serviceEntry, node = process.env.TAURI_NODE_RUNTIME || 'node' }) {
  const entry = await realpath(serviceEntry)
  const resourceRoot = await realpath(dirname(dirname(entry)))
  const profileRoot = await realpath(await mkdtemp(join(tmpdir(), '21x-database-service-')))
  const client = connectDatabaseService({ node, entry, profileRoot, resourceRoot, agentMode: true })
  const report = { reportVersion: 1, passed: false, actualBundledService: true, phase: 'initialize' }
  const wait = async ready => {
    const deadline = Date.now() + 15000
    while (!await ready()) { if (Date.now() >= deadline) throw new Error(); await delay(25) }
  }
  try {
    await client.initialize()
    const agents = await client.command('agent:getAll', {})
    const task = (await client.command('db:getTasks', {})).find(row => row.title === 'Synthetic approval task')
    assert.equal(agents.length, 1)
    assert.ok(task && !Object.hasOwn(agents[0].config, 'api_keys'))
    report.publicFixtureIdentity = true
    report.phase = 'actual-start-and-projection'
    const start = await client.command('agentSession:start', { agentId: agents[0].id, taskId: task.id })
    assert.ok(start.sessionId && !start.queued)
    await wait(() => client.events.some(event => event.operation === 'agent:status' && event.payload.status === 'waiting_approval'))
    let snapshot
    await wait(async () => {
      snapshot = await client.command('agentSession:getTranscriptSnapshot', { taskId: task.id })
      return snapshot.some(part => part.tool?.requestId === 'fixture-approval-1' && part.tool.status === 'running')
    })
    report.actualApprovalProjection = true
    report.phase = 'owner-scope-and-approval'
    await assert.rejects(client.command('db:deleteTask', { id: task.id }), { code: 'INVALID_REQUEST' })
    await assert.rejects(client.command('agentSession:approve', { sessionId: start.sessionId, approved: true }), { code: 'INVALID_ARGUMENTS' })
    await assert.rejects(client.command('agentSession:approve', { sessionId: start.sessionId, approved: true, requestId: 'stale-request' }), { code: 'INVALID_REQUEST' })
    const before = client.events.length
    await client.command('agentSession:resume', { agentId: agents[0].id, taskId: task.id, sessionId: start.sessionId })
    await wait(() => client.events.slice(before).some(event => event.operation === 'agent:status' && event.payload.status === 'waiting_approval'))
    report.pendingOwnerSnapshot = true
    await client.command('agentSession:approve', { sessionId: start.sessionId, approved: true, requestId: 'fixture-approval-1', responseType: 'permission' })
    await wait(async () => {
      const current = await client.command('db:getTask', { id: task.id })
      return current.status === 'ready_for_review' && client.events.some(event => event.operation === 'transcript:changed' && event.payload.parts.some(part => part.content === 'Applied the approved synthetic change.'))
    })
    report.approvalAcceptedAndCompleted = true
    report.staleApprovalAndActiveDeleteDenied = true
    report.phase = 'stop-owner'
    await client.command('agentSession:stop', { sessionId: start.sessionId })
    report.phase = 'delete-stopped-task'
    // Managed task mutations remain outside the database-only slice even after Stop.
    await assert.rejects(client.command('db:deleteTask', { id: task.id }), { code: 'INVALID_REQUEST' })
    report.managedTaskDeletionRemainsUnbound = true
    report.phase = 'shutdown'
    await client.request('engine.shutdown', {})
    assert.equal((await client.waitClosed()).code, 0)
    report.eventCount = client.events.length
    report.passed = true
    report.phase = 'complete'
  } catch (error) {
    report.errorCode = ['INVALID_OUTPUT', 'CHILD_STOP_FAILED', 'INVALID_FRAME', 'DISCONNECTED', 'TIMEOUT', 'INVALID_REQUEST', 'INVALID_ARGUMENTS', 'INTERNAL_ERROR'].includes(error.code) ? error.code : 'PROOF_FAILED'
  } finally {
    try { await client.stop(); await rm(profileRoot, { recursive: true, force: true }); report.syntheticProfileRemoved = true }
    catch { report.syntheticProfileRemoved = false; report.passed = false }
  }
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runAgentServiceProof({ serviceEntry: process.env.TAURI_DATABASE_SERVICE_ENTRY })
    console.log(JSON.stringify(report, null, 2))
    if (!report.passed) process.exitCode = 1
  } catch { console.error('Explicit staged agent service unavailable.'); process.exitCode = 1 }
}
