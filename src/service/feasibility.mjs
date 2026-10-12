/** Experimental packaged-Node probe. Never opens the production profile. */
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

function stagedModule(name) {
  const modules = join(dirname(fileURLToPath(import.meta.url)), 'node_modules')
  const details = lstatSync(modules)
  if (!details.isDirectory() || details.isSymbolicLink()) throw fail('INTERNAL_ERROR')
  const base = realpathSync(modules)
  const resolved = realpathSync(fileURLToPath(import.meta.resolve(name)))
  const location = relative(base, resolved)
  if (isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) throw fail('INTERNAL_ERROR')
  return resolved
}
const MAX_FRAME = 1024 * 1024
const MAX_ACTIVE = 128
const MAX_QUEUE_BYTES = 4 * 1024 * 1024
const DEADLINE_MS = 30_000
const epoch = randomUUID()
const active = new Map()
const children = new Set()
const queue = []
let queuedBytes = 0
let writing = false
let initialized = false
let closing = false
let fatalError = false
let probeRunning = false
let cleanupStarted = false
const fixtureMode = process.env.TWENTYONEX_FEASIBILITY_TEST_MODE === '1'
const accumulator = Buffer.allocUnsafe(MAX_FRAME)
let frameBytes = 0
let lastRequestId = 0n

// Dependencies must never contaminate stdout or leak their arguments into logs.
for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
  console[method] = () => process.stderr.write('[feasibility] dependency diagnostic redacted\n')
}

const messages = {
  INVALID_FRAME: 'Invalid protocol frame.',
  FRAME_TOO_LARGE: 'Protocol frame exceeds the size limit.',
  UNSUPPORTED_VERSION: 'Unsupported protocol version.',
  STALE_EPOCH: 'Engine epoch does not match.',
  INVALID_REQUEST: 'Invalid request identifier.',
  UNKNOWN_OPERATION: 'Unknown operation.',
  INVALID_ARGUMENTS: 'Invalid operation arguments.',
  INTERNAL_ERROR: 'Engine operation failed.',
  BACKPRESSURE: 'Engine capacity exceeded.',
  TIMEOUT: 'Engine operation timed out.',
  CANCELLED: 'Engine operation cancelled.',
  DISCONNECTED: 'Engine disconnected.'
}

function fail(code) { return Object.assign(new Error(messages[code]), { code }) }
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function cleanup() {
  if (cleanupStarted) return
  cleanupStarted = true
  closing = true
  for (const { controller } of active.values()) controller.abort()
  // Keep ownership until each exit callback confirms termination. A stopped
  // probe must not remove a still-running PTY/worker from this set.
  for (const child of children) { try { child.kill() } catch {} }
  if (children.size) {
    setTimeout(() => {
      for (const child of children) { try { child.kill('SIGKILL') } catch {} }
    }, 500).unref()
  }
  // Bound exit even if a native addon retains a handle after child cleanup.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
}

function fatal(code) {
  if (fatalError) return
  fatalError = true
  process.stderr.write(`[feasibility] ${messages[code] ?? messages.INTERNAL_ERROR}\n`)
  cleanup()
  process.exitCode = 1
  process.stdin.destroy()
  process.stdout.destroy()
}

function flush() {
  if (writing || queue.length === 0) return
  writing = true
  const entry = queue.shift()
  const stall = setTimeout(() => fatal('TIMEOUT'), DEADLINE_MS)
  process.stdout.write(entry.bytes, error => {
    clearTimeout(stall)
    queuedBytes -= entry.bytes.length
    writing = false
    if (error) return fatal('DISCONNECTED')
    entry.done?.()
    flush()
  })
}

function respond(requestId, result, error, done) {
  if (fatalError) return
  const frame = { protocolVersion: 1, engineEpoch: epoch, kind: 'response', requestId,
    ...(error ? { error: { code: error.code ?? 'INTERNAL_ERROR',
      message: messages[error.code] ?? messages.INTERNAL_ERROR } } : { result }) }
  const bytes = Buffer.from(JSON.stringify(frame) + '\n')
  if (bytes.length - 1 > MAX_FRAME) return fatal('FRAME_TOO_LARGE')
  if (queue.length + Number(writing) >= MAX_ACTIVE || queuedBytes + bytes.length > MAX_QUEUE_BYTES) return fatal('BACKPRESSURE')
  queuedBytes += bytes.length
  queue.push({ bytes, done })
  flush()
}

async function workerProbe(signal) {
  return new Promise((resolve, reject) => {
    const worker = fork(fileURLToPath(import.meta.url), ['--worker'], {
      execPath: process.execPath, execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: workerEnvironment()
    })
    children.add(worker)
    let answer
    const abort = () => { worker.kill(); reject(fail('CANCELLED')) }
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', message => { answer = message })
    worker.once('error', () => reject(fail('INTERNAL_ERROR')))
    worker.once('exit', code => {
      children.delete(worker)
      signal.removeEventListener('abort', abort)
      if (code === 0 && answer?.marker === 'worker-ok') resolve({ ok: true, realFile: true })
      else reject(fail('INTERNAL_ERROR'))
    })
    if (signal.aborted) abort()
  })
}

function workerEnvironment() {
  // No API keys, NODE_OPTIONS, or arbitrary parent environment reaches a worker.
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]))
}

async function ptyProbe(signal) {
  const errno = error => ['EACCES', 'ENOENT', 'ENOEXEC', 'EPERM', 'EAGAIN', 'ENOMEM', 'ENOTDIR', 'EIO',
    'ETIMEDOUT', 'ERR_DLOPEN_FAILED'].includes(error?.code) ? error.code : 'UNKNOWN'
  let pty
  let helper = null
  try {
    const entry = stagedModule('node-pty')
    pty = require(entry)
    if (process.platform === 'darwin') {
      const native = require(join(dirname(entry), 'utils.js')).loadNativeModule('pty')
      const path = join(dirname(entry), native.dir, 'spawn-helper')
      let details
      try { details = statSync(path) } catch (error) {
        return { ok: false, phase: 'helper-lookup', errno: errno(error), helper: { present: false } }
      }
      helper = { present: details.isFile(), mode: (details.mode & 0o777).toString(8),
        executable: Boolean(details.mode & 0o111) }
      if (!helper.present || !helper.executable) return { ok: false, phase: 'helper-permission', helper }
    }
  } catch (error) { return { ok: false, phase: 'module-load', errno: errno(error) } }
  return new Promise(resolve => {
    let terminal
    try {
      terminal = pty.spawn(process.execPath, ['-e',
        "process.stdout.write('pty-ok', () => setTimeout(() => process.exit(0), 100));"], {
        name: 'xterm', cols: 40, rows: 10, cwd: fileURLToPath(new URL('.', import.meta.url)),
        env: workerEnvironment()
      })
    } catch (error) { resolve({ ok: false, phase: 'spawn', errno: errno(error), helper }); return }
    children.add(terminal)
    let output = ''
    let chunks = 0
    let settled = false
    const data = terminal.onData(chunk => {
      output = (output + chunk).slice(-256)
      chunks = Math.min(chunks + 1, 1_000_000)
    })
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      data.dispose()
      if (result.phase === 'cancelled' || result.phase === 'timeout') {
        setTimeout(() => {
          if (children.has(terminal)) { try { terminal.kill('SIGKILL') } catch {} }
        }, 500).unref()
      }
      resolve({ ...result, helper, dataChunks: chunks, markerSeen: output.includes('pty-ok') })
    }
    const abort = () => { try { terminal.kill() } catch {}; finish({ ok: false, phase: 'cancelled' }) }
    signal.addEventListener('abort', abort, { once: true })
    const exit = terminal.onExit(({ exitCode, signal: exitSignal }) => {
      children.delete(terminal)
      exit.dispose()
      finish({ ok: exitCode === 0 && output.includes('pty-ok'), phase: 'exit',
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: Number.isInteger(exitSignal) ? exitSignal : null })
    })
    const timer = setTimeout(() => {
      try { terminal.kill() } catch {}
      finish({ ok: false, phase: 'timeout' })
    }, 10_000)
    if (signal.aborted) abort()
  })
}

async function probe(signal) {
  if (probeRunning) throw fail('BACKPRESSURE')
  probeRunning = true
  const checks = {}
  async function check(name, action) {
    if (signal.aborted) throw fail('CANCELLED')
    try { checks[name] = await action() }
    catch { checks[name] = { ok: false, code: 'INTERNAL_ERROR', message: 'Feasibility check failed; verify staged dependency and Node ABI.' } }
  }
  try {
    await check('sqlite', () => {
      const Database = require(stagedModule('better-sqlite3'))
      const db = new Database(':memory:')
      try {
        db.exec('CREATE TABLE probe (value TEXT NOT NULL)')
        db.prepare('INSERT INTO probe VALUES (?)').run('sqlite-ok')
        if (db.prepare('SELECT value FROM probe').get()?.value !== 'sqlite-ok') throw fail('INTERNAL_ERROR')
        return { ok: true, inMemory: true }
      } finally { db.close() }
    })
    await check('pty', () => ptyProbe(signal))
    await check('worker', () => workerProbe(signal))
    for (const name of ['@anthropic-ai/claude-agent-sdk', '@opencode-ai/sdk']) {
      await check(name, async () => { stagedModule(name); await import(name); return { ok: true, importedOnly: true } })
    }
    if (signal.aborted) throw fail('CANCELLED')
    return { ok: Object.values(checks).every(check => check.ok), checks,
      nodeVersion: process.version, nodeAbi: process.versions.modules,
      platform: process.platform, arch: process.arch }
  } finally { probeRunning = false }
}

async function ownershipFixture(stubborn = true) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [stubborn ? '--ownership-stubborn-worker' : '--ownership-worker'], {
      execPath: process.execPath, execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: workerEnvironment()
    })
    children.add(child)
    child.once('exit', () => children.delete(child))
    child.once('error', () => reject(fail('INTERNAL_ERROR')))
    child.once('message', message => {
      if (Number.isSafeInteger(message?.descendantPid) && message.descendantPid > 0) {
        resolve({ workerPid: child.pid, descendantPid: message.descendantPid })
      } else reject(fail('INTERNAL_ERROR'))
    })
  })
}

async function dispatch(frame, signal) {
  if (frame.operation === 'engine.initialize') {
    const p = frame.payload
    if (initialized || !exact(p, ['protocolVersion', 'profileRoot', 'resourceRoot']) ||
        p.protocolVersion !== 1 || p.profileRoot !== process.env.TWENTYONEX_PROFILE_ROOT ||
        p.resourceRoot !== process.env.TWENTYONEX_RESOURCE_ROOT || !p.profileRoot || !p.resourceRoot) {
      throw fail('INVALID_ARGUMENTS')
    }
    initialized = true
    return { protocolVersion: 1, engineEpoch: epoch, nodeVersion: process.version }
  }
  if (!exact(frame.payload, [])) throw fail('INVALID_ARGUMENTS')
  if (frame.operation === 'engine.ping') return { protocolVersion: 1, engineEpoch: epoch, nodeVersion: process.version }
  if (!initialized) throw fail('INVALID_ARGUMENTS')
  if (fixtureMode && frame.operation === 'engine.fixture.start') return ownershipFixture()
  if (fixtureMode && frame.operation === 'engine.fixture.cooperative') return ownershipFixture(false)
  if (fixtureMode && frame.operation === 'engine.fixture.crash') { process.exit(23) }
  if (fixtureMode && frame.operation === 'engine.fixture.hang') {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(fail('CANCELLED')), { once: true })
    })
  }
  if (frame.operation === 'engine.probe') return probe(signal)
  if (frame.operation === 'engine.shutdown') return { stopped: true }
  throw fail('UNKNOWN_OPERATION')
}

function receive(bytes) {
  let frame
  try {
    let depth = 0
    let quoted = false
    let escaped = false
    for (const byte of bytes) {
      if (quoted) {
        if (escaped) escaped = false
        else if (byte === 92) escaped = true
        else if (byte === 34) quoted = false
      } else if (byte === 34) quoted = true
      else if (byte === 123 || byte === 91) { if (++depth > 64) throw fail('INVALID_FRAME') }
      else if (byte === 125 || byte === 93) depth--
    }
    frame = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  }
  catch { return fatal('INVALID_FRAME') }
  if (frame?.protocolVersion !== 1) return fatal('UNSUPPORTED_VERSION')
  if (typeof frame.engineEpoch !== 'string' || frame.engineEpoch.length > 128 ||
      (frame.engineEpoch !== '' && !/^[a-zA-Z0-9_-]+$/.test(frame.engineEpoch))) return fatal('INVALID_FRAME')
  if (frame?.kind === 'event') {
    if (!exact(frame, ['protocolVersion', 'engineEpoch', 'kind', 'operation', 'payload']) ||
        frame.operation !== 'engine.cancel' || !exact(frame.payload, ['requestId']) ||
        typeof frame.payload.requestId !== 'string' ||
        !/^host:[1-9][0-9]{0,31}$/.test(frame.payload.requestId)) return fatal('INVALID_FRAME')
    if (frame.engineEpoch !== epoch) return
    active.get(frame.payload.requestId)?.controller.abort()
    return
  }
  if (!exact(frame, ['protocolVersion', 'engineEpoch', 'kind', 'requestId', 'operation', 'payload']) ||
      frame.kind !== 'request' || typeof frame.operation !== 'string' || frame.operation.length > 128 ||
      !/^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(frame.operation) ||
      typeof frame.requestId !== 'string' || !/^host:[1-9][0-9]{0,31}$/.test(frame.requestId)) return fatal('INVALID_FRAME')
  const id = BigInt(frame.requestId.slice(5))
  if (id <= lastRequestId) return fatal('INVALID_REQUEST')
  lastRequestId = id
  const bootstrap = !initialized && ['engine.initialize', 'engine.ping'].includes(frame.operation)
  if (frame.engineEpoch !== (bootstrap ? '' : epoch)) {
    return respond(frame.requestId, undefined, fail('STALE_EPOCH'))
  }
  if (closing || active.size >= MAX_ACTIVE) return respond(frame.requestId, undefined, fail('BACKPRESSURE'))
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, DEADLINE_MS)
  let onAbort
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(fail(timedOut ? 'TIMEOUT' : 'CANCELLED'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  active.set(frame.requestId, { controller })
  const operation = dispatch(frame, controller.signal).finally(() => active.delete(frame.requestId))
  Promise.race([operation, cancelled]).then(result => {
    if (controller.signal.aborted) throw fail(timedOut ? 'TIMEOUT' : 'CANCELLED')
    if (frame.operation === 'engine.shutdown') {
      cleanup()
      respond(frame.requestId, result, undefined, () => { process.stdin.destroy(); process.exitCode = 0 })
    } else respond(frame.requestId, result)
  }).catch(error => respond(frame.requestId, undefined, timedOut ? fail('TIMEOUT') : error))
    .finally(() => {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
    })
}

if (process.argv.includes('--ownership-worker')) {
  const child = fork(fileURLToPath(import.meta.url), ['--ownership-descendant'], {
    execPath: process.execPath, execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: workerEnvironment()
  })
  child.once('message', () => process.send?.({ descendantPid: child.pid }))
  child.once('exit', () => process.exit(0))
  const stop = () => {
    child.kill()
    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 500).unref()
  }
  process.on('disconnect', stop)
  process.on('SIGTERM', stop)
} else if (process.argv.includes('--ownership-descendant')) {
  process.on('disconnect', () => process.exit(0))
  process.send?.({ ready: true })
  setInterval(() => {}, 1000)
} else if (process.argv.includes('--ownership-stubborn-worker')) {
  // Reachable only through the explicitly enabled private fixture operation.
  // Deliberately resist cooperative exit to exercise the host's owned tree.
  const child = fork(fileURLToPath(import.meta.url), ['--ownership-stubborn-descendant'], {
    execPath: process.execPath, execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: workerEnvironment()
  })
  child.once('message', () => process.send?.({ descendantPid: child.pid }))
  process.on('disconnect', () => {})
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
} else if (process.argv.includes('--ownership-stubborn-descendant')) {
  process.on('disconnect', () => {})
  process.on('SIGTERM', () => {})
  process.send?.({ ready: true })
  setInterval(() => {}, 1000)
} else if (process.argv.includes('--worker')) {
  process.on('disconnect', () => process.exit(0))
  process.send?.({ marker: 'worker-ok' }, () => process.disconnect())
} else {
  process.stdin.on('data', chunk => {
    for (let offset = 0; offset < chunk.length && !closing;) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      if (frameBytes + part.length > MAX_FRAME) return fatal('FRAME_TOO_LARGE')
      part.copy(accumulator, frameBytes)
      frameBytes += part.length
      offset = end + 1
      if (newline >= 0) {
        receive(accumulator.subarray(0, frameBytes))
        frameBytes = 0
      }
    }
  })
  process.stdin.on('end', () => { cleanup(); if (frameBytes) process.exitCode = 1 })
  process.stdin.on('error', () => fatal('DISCONNECTED'))
  process.stdout.on('error', () => { cleanup(); process.exitCode = 1; process.stdin.destroy() })
  process.on('SIGTERM', () => { cleanup(); process.stdin.destroy() })
  process.on('SIGINT', () => { cleanup(); process.stdin.destroy() })
  process.on('uncaughtException', () => fatal('INTERNAL_ERROR'))
  process.on('unhandledRejection', () => fatal('INTERNAL_ERROR'))
}
