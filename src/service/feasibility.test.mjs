import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const entry = fileURLToPath(new URL('./feasibility.mjs', import.meta.url))
const profileRoot = '/isolated-fixture/profile'
const resourceRoot = '/isolated-fixture/resources'

function fixture(t, privateFixture = false) {
  const child = spawn(process.execPath, [entry], {
    env: { TWENTYONEX_PROFILE_ROOT: profileRoot, TWENTYONEX_RESOURCE_ROOT: resourceRoot,
      ...(privateFixture ? { TWENTYONEX_FEASIBILITY_TEST_MODE: '1' } : {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  child.stdin.on('error', () => {})
  let epoch = ''
  let counter = 0
  let buffered = ''
  let stderr = ''
  const waiting = new Map()
  const observed = []
  child.stderr.on('data', bytes => { stderr += bytes })
  child.stdout.on('data', bytes => {
    buffered += bytes
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const frame = JSON.parse(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      observed.push(frame)
      waiting.get(frame.requestId)?.(frame)
      waiting.delete(frame.requestId)
    }
  })
  const closed = once(child, 'close')
  function request(operation, payload = {}, options = {}) {
    const requestId = `host:${++counter}`
    const frame = { protocolVersion: 1, engineEpoch: epoch, kind: 'request', requestId, operation, payload, ...options }
    const reply = new Promise(resolve => waiting.set(requestId, resolve))
    child.stdin.write(JSON.stringify(frame) + '\n')
    return reply
  }
  async function initialize() {
    const response = await request('engine.initialize', { protocolVersion: 1, profileRoot, resourceRoot })
    assert.equal(response.result.protocolVersion, 1)
    assert.equal(response.engineEpoch, response.result.engineEpoch)
    epoch = response.engineEpoch
    return response
  }
  return { child, request, initialize, closed, observed, stderr: () => stderr }
}

test('initialize, ping, unknown operation and graceful shutdown keep stdout framed', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.initialize()
  assert.equal((await f.request('engine.ping')).result.nodeVersion, process.version)
  const error = await f.request('engine.read-secret', { password: 'do-not-echo' })
  assert.deepEqual(error.error, { code: 'INVALID_ARGUMENTS', message: 'Invalid operation arguments.' })
  assert.equal((await f.request('engine.read-secret')).error.code, 'UNKNOWN_OPERATION')
  assert.equal((await f.request('engine.shutdown')).result.stopped, true)
  assert.equal((await f.closed)[0], 0)
  assert.equal(f.stderr().includes('do-not-echo'), false)
})

test('partial input and several frames in one write preserve framing', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const base = { protocolVersion: 1, engineEpoch: '', kind: 'request', operation: 'engine.ping', payload: {} }
  const bytes = JSON.stringify({ ...base, requestId: 'host:1' }) + '\n' + JSON.stringify({ ...base, requestId: 'host:2' }) + '\n'
  f.child.stdin.write(bytes.slice(0, 19))
  f.child.stdin.write(bytes.slice(19))
  f.child.stdin.end()
  assert.equal((await f.closed)[0], 0)
  assert.deepEqual(f.observed.map(frame => frame.requestId), ['host:1', 'host:2'])
})

test('stale epoch cannot reach an operation', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.initialize()
  assert.equal((await f.request('engine.probe', {}, { engineEpoch: 'stale' })).error.code, 'STALE_EPOCH')
  await f.request('engine.shutdown')
  assert.equal((await f.closed)[0], 0)
})

test('initialization rejects roots different from the host environment', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const response = await f.request('engine.initialize', { protocolVersion: 1, profileRoot: '/live/profile', resourceRoot })
  assert.equal(response.error.code, 'INVALID_ARGUMENTS')
  f.child.stdin.end()
  assert.equal((await f.closed)[0], 0)
})

for (const [name, bytes] of [
  ['malformed JSON', '{secret:do-not-echo}\n'],
  ['unsupported version', '{"protocolVersion":99}\n'],
  ['oversized unterminated frame', 'x'.repeat(1024 * 1024 + 1)],
  ['truncated frame at EOF', '{"protocolVersion":1'],
  ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
  ['UTF-8 byte-order mark', Buffer.from('\uFEFF{"protocolVersion":1}\n')],
  ['excessive JSON nesting', '['.repeat(65) + '0' + ']'.repeat(65) + '\n']
]) {
  test(`${name} exits safely without reflecting input`, { timeout: 5000 }, async t => {
    const f = fixture(t)
    f.child.stdin.end(bytes)
    assert.equal((await f.closed)[0], 1)
    assert.equal(f.observed.length, 0)
    assert.equal(f.stderr().includes('do-not-echo'), false)
  })
}

test('duplicate IDs are rejected rather than executing twice', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.initialize()
  const frame = { protocolVersion: 1, engineEpoch: f.observed[0].engineEpoch, kind: 'request',
    requestId: 'host:1', operation: 'engine.ping', payload: {} }
  f.child.stdin.end(JSON.stringify(frame) + '\n')
  assert.equal((await f.closed)[0], 1)
})

test('wrong-direction cancellation cannot target a host request', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.initialize()
  f.child.stdin.end(JSON.stringify({ protocolVersion: 1, engineEpoch: f.observed[0].engineEpoch,
    kind: 'event', operation: 'engine.cancel', payload: { requestId: 'service:1' } }) + '\n')
  assert.equal((await f.closed)[0], 1)
})

test('stale cancellation is ignored without disconnecting the current engine', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.initialize()
  f.child.stdin.write(JSON.stringify({ protocolVersion: 1, engineEpoch: 'previous-epoch',
    kind: 'event', operation: 'engine.cancel', payload: { requestId: 'host:1' } }) + '\n')
  assert.equal((await f.request('engine.ping')).result.nodeVersion, process.version)
  await f.request('engine.shutdown')
  assert.equal((await f.closed)[0], 0)
})

test('real-file worker uses IPC and exits without a system Node lookup', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, [entry, '--worker'], {
    env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  t.after(() => child.kill())
  const closed = once(child, 'close')
  const [message] = await once(child, 'message')
  assert.deepEqual(message, { marker: 'worker-ok' })
  assert.equal((await closed)[0], 0)
})

test('an unstaged service cannot borrow native modules or SDKs from the repository', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.initialize()
  const report = (await f.request('engine.probe')).result
  assert.equal(report.ok, false)
  for (const name of ['sqlite', 'pty', '@anthropic-ai/claude-agent-sdk', '@opencode-ai/sdk']) {
    assert.equal(report.checks[name].ok, false)
  }
  assert.equal(report.checks.worker.ok, true)
  await f.request('engine.shutdown')
  assert.equal((await f.closed)[0], 0)
})


test('private ownership operations are absent from the ordinary engine', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.initialize()
  assert.equal((await f.request('engine.fixture.start')).error.code, 'UNKNOWN_OPERATION')
  await f.request('engine.shutdown')
  assert.equal((await f.closed)[0], 0)
})

test('stdin loss drains the known worker and its cooperative descendant', { timeout: 7000 }, async t => {
  const f = fixture(t, true)
  await f.initialize()
  const response = await f.request('engine.fixture.cooperative')
  assert.equal(response.error, undefined)
  const pids = [response.result.workerPid, response.result.descendantPid]
  f.child.stdin.end()
  assert.equal((await f.closed)[0], 0)
  const until = Date.now() + 3000
  for (;;) {
    const running = pids.filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
    if (!running.length) break
    assert.ok(Date.now() < until, 'known cooperative child survived stdin loss')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
})
