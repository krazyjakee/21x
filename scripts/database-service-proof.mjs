/** Direct private-pipe proof against the actually staged standalone service. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_FRAME = 1_048_576
const eventNames = new Set(['task:created', 'task:updated', 'task:deleted', 'project:changed', 'transcript:changed'])
const errorCodes = new Set(['INVALID_FRAME', 'FRAME_TOO_LARGE', 'UNSUPPORTED_VERSION', 'STALE_EPOCH', 'INVALID_REQUEST', 'UNKNOWN_OPERATION', 'INVALID_ARGUMENTS', 'INVALID_RESULT', 'INTERNAL_ERROR', 'BACKPRESSURE', 'TIMEOUT', 'CANCELLED', 'DISCONNECTED'])
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const failed = code => Object.assign(new Error(code), { code })

function connect({ node, entry, profileRoot, resourceRoot }) {
  const environment = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  Object.assign(environment, { TWENTYONEX_DATABASE_MODE: 'synthetic-only', TWENTYONEX_PROFILE_ROOT: profileRoot, TWENTYONEX_RESOURCE_ROOT: resourceRoot })
  const child = spawn(node, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: environment, windowsHide: true })
  const pending = new Map()
  const events = []
  const buffer = Buffer.allocUnsafe(MAX_FRAME)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let used = 0
  let counter = 0
  let epoch = ''
  let sequence = 0
  let failure
  let diagnostics = ''
  let finished = false
  const fail = code => {
    failure ??= failed(code)
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(failure) }
    pending.clear()
  }
  const closed = new Promise(resolve => child.once('close', (code, signal) => { finished = true; fail('DISCONNECTED'); resolve({ code, signal }) }))
  child.once('error', () => fail('DISCONNECTED'))
  child.stdin.on('error', () => fail('DISCONNECTED'))
  child.stderr.on('data', chunk => { if (diagnostics.length < 16_384) diagnostics += chunk.toString('utf8').slice(0, 16_384 - diagnostics.length) })
  const accept = frame => {
    if (frame.protocolVersion !== 1 || typeof frame.engineEpoch !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(frame.engineEpoch)) throw failed('INVALID_OUTPUT')
    if (frame.kind === 'event') {
      if (!exact(frame, ['kind', 'protocolVersion', 'engineEpoch', 'operation', 'payload', 'sequence']) || frame.engineEpoch !== epoch ||
          !eventNames.has(frame.operation) || frame.sequence !== sequence + 1 || events.length >= 128) throw failed('INVALID_OUTPUT')
      sequence = frame.sequence
      events.push(frame)
      return
    }
    if (frame.kind !== 'response' || !/^host:[1-9][0-9]{0,31}$/.test(frame.requestId)) throw failed('INVALID_OUTPUT')
    const call = pending.get(frame.requestId)
    if (!call || !exact(frame, ['kind', 'protocolVersion', 'engineEpoch', 'requestId', Object.hasOwn(frame, 'result') ? 'result' : 'error'])) throw failed('INVALID_OUTPUT')
    if (epoch && frame.engineEpoch !== epoch) throw failed('INVALID_OUTPUT')
    if (Object.hasOwn(frame, 'error')) {
      if (!exact(frame.error, ['code', 'message']) || !errorCodes.has(frame.error.code) || typeof frame.error.message !== 'string' || frame.error.message.length > 256) throw failed('INVALID_OUTPUT')
      pending.delete(frame.requestId)
      clearTimeout(call.timer)
      call.reject(Object.assign(failed(frame.error.code), { remoteMessage: frame.error.message }))
    } else {
      if (!epoch) {
        if (!exact(frame.result, ['protocolVersion', 'engineEpoch', 'nodeVersion']) || frame.result.protocolVersion !== 1 || frame.result.engineEpoch !== frame.engineEpoch) throw failed('INVALID_OUTPUT')
        epoch = frame.engineEpoch
      }
      pending.delete(frame.requestId)
      clearTimeout(call.timer)
      call.resolve(frame.result)
    }
  }
  child.stdout.on('data', chunk => {
    if (failure) return
    try {
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        if (used + end - offset > MAX_FRAME) throw failed('INVALID_OUTPUT')
        chunk.copy(buffer, used, offset, end)
        used += end - offset
        if (newline < 0) break
        if (!used) throw failed('INVALID_OUTPUT')
        accept(JSON.parse(decoder.decode(buffer.subarray(0, used))))
        used = 0
        offset = newline + 1
      }
    } catch { fail('INVALID_OUTPUT') }
  })
  child.stdout.on('end', () => { if (used) fail('INVALID_OUTPUT') })
  function request(operation, payload, options = {}) {
    if (failure) return Promise.reject(failure)
    const requestId = `host:${++counter}`
    const frame = { kind: 'request', protocolVersion: 1, engineEpoch: options.epoch ?? epoch, requestId, operation, payload }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(failed('TIMEOUT')) }, 10_000)
      pending.set(requestId, { resolve, reject, timer })
      let bytes = JSON.stringify(frame) + '\n'
      if (options.cancelImmediately) bytes += JSON.stringify({ kind: 'event', protocolVersion: 1, engineEpoch: epoch, operation: 'engine.cancel', payload: { requestId } }) + '\n'
      child.stdin.write(bytes, error => { if (error) fail('DISCONNECTED') })
    })
  }
  const command = async (operation, payload, options) => {
    const result = await request(operation, payload, options)
    if (exact(result, ['defined']) && result.defined === false) return undefined
    if (!exact(result, ['defined', 'value']) || result.defined !== true) throw failed('INVALID_OUTPUT')
    return result.value
  }
  return {
    child, closed, events, request, command,
    initialize: () => request('engine.initialize', { protocolVersion: 1, profileRoot, resourceRoot }),
    epoch: () => epoch, diagnostics: () => diagnostics,
    async waitClosed() {
      let timer
      try { return await Promise.race([closed, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(failed('CHILD_STOP_FAILED')), 5000) })]) }
      finally { clearTimeout(timer) }
    },
    async stop() {
      if (!finished) {
        child.kill()
        const force = setTimeout(() => { if (!finished) child.kill('SIGKILL') }, 2000)
        let deadline
        try {
          await Promise.race([closed, new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(failed('CHILD_STOP_FAILED')), 5000) })])
        } finally { clearTimeout(force); clearTimeout(deadline) }
      }
      if (!finished) throw failed('CHILD_STOP_FAILED')
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
  }
}

/** No build/install here: select the staged checked entry explicitly. */
export async function runDatabaseServiceProof({ serviceEntry, node = process.env.TAURI_NODE_RUNTIME || 'node' }) {
  if (process.versions.electron || !serviceEntry || !isAbsolute(serviceEntry)) throw failed('INVALID_CONFIGURATION')
  const entry = await realpath(serviceEntry)
  const resourceRoot = await realpath(dirname(dirname(entry)))
  const profileRoot = await realpath(await mkdtemp(join(tmpdir(), '21x-database-service-')))
  const clients = []
  const report = { reportVersion: 1, passed: false, runtime: 'standalone-node', syntheticOnly: true }
  const start = () => { const client = connect({ node, entry, profileRoot, resourceRoot }); clients.push(client); return client }
  try {
    report.phase = 'initialize'
    const first = start()
    const ready = await first.initialize()
    assert.match(ready.nodeVersion, /^v22\./)
    report.handshake = true
    report.phase = 'profile-contention-rejection'
    const competing = start()
    await assert.rejects(competing.initialize(), { code: 'INTERNAL_ERROR' })
    report.phase = 'profile-contention-exit'
    assert.equal((await competing.waitClosed()).code, 1)
    report.profileContentionRejected = true
    report.phase = 'task-project-commands'
    const project = await first.command('project:create', { data: { name: 'Synthetic service proof' } })
    const task = await first.command('db:createTask', { data: { title: 'Service task', project_id: project.id } })
    assert.equal(task.status, 'not_started')
    assert.equal(Object.hasOwn(task, 'mcp_scope_nonce'), false)
    assert.equal((await first.command('db:getTasks', { projectId: project.id })).length, 1)
    assert.equal(await first.command('db:getTask', { id: 'missing-task' }), undefined)
    const changed = await first.command('db:updateTask', { id: task.id, data: { title: 'Updated service task' } })
    assert.equal(changed.title, 'Updated service task')
    report.phase = 'denied-commands'
    await assert.rejects(first.command('db:updateTask', { id: task.id, data: { status: 'agent_working' } }), { code: 'INVALID_ARGUMENTS' })
    await assert.rejects(first.request('agentSession:approve', { password: 'fixture-must-not-echo' }), { code: 'UNKNOWN_OPERATION' })
    await assert.rejects(first.command('settings:set', { key: 'anthropic_api_key', value: 'fixture-must-not-echo' }), { code: 'INVALID_ARGUMENTS' })
    report.phase = 'cancellation'
    await assert.rejects(first.command('db:updateTask', { id: task.id, data: { title: 'Cancelled mutation' } }, { cancelImmediately: true }), { code: 'CANCELLED' })
    assert.equal((await first.command('db:getTask', { id: task.id })).title, changed.title)
    report.phase = 'settings-and-stale-epoch'
    await assert.rejects(first.command('db:getTasks', {}, { epoch: 'old-engine' }), { code: 'STALE_EPOCH' })
    assert.equal(await first.command('settings:set', { key: 'synthetic_ui_value', value: 'persisted-ui' }), undefined)
    assert.equal(await first.command('settings:get', { key: 'synthetic_ui_value' }), 'persisted-ui')
    assert.deepEqual(await first.command('settings:getAll', {}), { synthetic_ui_value: 'persisted-ui' })
    report.taskSettingsProjectCommands = true
    report.lifecycleAndCredentialCommandsRejected = true
    report.cancelBeforeEffects = true

    report.phase = 'durable-projection'
    const initial = await first.request('fixture.transcriptUpsert', { taskId: task.id, parts: [{ id: 'adapter:part/1', role: 'assistant', content: 'partial' }] })
    const snapshot = await first.command('agentSession:getTranscriptSnapshot', { taskId: task.id })
    assert.equal(snapshot[0].content, 'partial')
    const updated = await first.request('fixture.transcriptUpsert', { taskId: task.id, parts: [{ id: 'adapter:part/1', role: 'assistant', content: 'complete' }] })
    const delta = await first.command('agentSession:getTranscriptDelta', { taskId: task.id, sinceRev: initial.maxRev })
    assert.equal(delta.maxRev, updated.maxRev)
    assert.equal(delta.parts[0].content, 'complete')
    assert.equal(delta.parts[0].seq, snapshot[0].seq)
    const duplicate = await first.request('fixture.transcriptUpsert', { taskId: task.id, parts: [{ id: 'adapter:part/1', role: 'assistant', content: 'complete' }] })
    assert.deepEqual(duplicate.changedPartIds, [])
    // A renderer reload rehydrates from durable data while this same engine lives.
    assert.deepEqual(await first.command('agentSession:getTranscriptSnapshot', { taskId: task.id }), delta.parts)
    assert.deepEqual((await first.command('agentSession:getTranscriptDelta', { taskId: task.id, sinceRev: updated.maxRev })).parts, [])
    assert.ok(first.events.some(event => event.operation === 'transcript:changed' && event.payload.maxRev === updated.maxRev))
    assert.ok(first.events.every(event => event.engineEpoch === first.epoch()))
    assert.equal(first.diagnostics().includes('fixture-must-not-echo'), false)
    report.durableProjectionAndReloadQueries = true
    report.eventCount = first.events.length
    report.phase = 'shutdown'
    assert.deepEqual(await first.request('engine.shutdown', {}), { stopped: true })
    assert.equal((await first.waitClosed()).code, 0)
    report.gracefulDrainAndExit = true

    report.phase = 'reopen'
    const reopened = start()
    await reopened.initialize()
    assert.notEqual(reopened.epoch(), first.epoch())
    assert.equal((await reopened.command('db:getTask', { id: task.id })).title, changed.title)
    assert.deepEqual(await reopened.command('agentSession:getTranscriptSnapshot', { taskId: task.id }), delta.parts)
    assert.equal(await reopened.command('settings:get', { key: 'synthetic_ui_value' }), 'persisted-ui')
    await assert.rejects(reopened.command('db:updateTask', { id: task.id, data: { title: 'stale' } }, { epoch: first.epoch() }), { code: 'STALE_EPOCH' })
    assert.equal(await reopened.command('db:deleteTask', { id: task.id }), true)
    assert.equal(await reopened.command('db:deleteTask', { id: task.id }), false)
    assert.equal(await reopened.command('db:getTask', { id: task.id }), undefined)
    assert.deepEqual(await reopened.request('engine.shutdown', {}), { stopped: true })
    assert.equal((await reopened.waitClosed()).code, 0)
    report.reopenAndNewEpoch = true
    report.passed = true
    report.phase = 'complete'
  } catch (error) { report.errorCode = errorCodes.has(error.code) || ['CHILD_STOP_FAILED', 'INVALID_OUTPUT'].includes(error.code) ? error.code : 'PROOF_FAILED' }
  finally {
    let stopped = true
    for (const client of clients) { try { await client.stop() } catch { stopped = false } }
    if (stopped) { await rm(profileRoot, { recursive: true, force: true }); report.syntheticProfileRemoved = true }
    else { report.syntheticProfileRemoved = false; report.passed = false; report.errorCode = 'CHILD_STOP_FAILED' }
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
  try {
    const report = await runDatabaseServiceProof({ serviceEntry: option('--service-entry') || process.env.TAURI_DATABASE_SERVICE_ENTRY, node: option('--node') || process.env.TAURI_NODE_RUNTIME || 'node' })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.passed ? 0 : 1
  } catch { console.error('Standalone database service proof requires an explicitly staged entry.'); process.exitCode = 1 }
}
