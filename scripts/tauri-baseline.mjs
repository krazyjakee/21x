#!/usr/bin/env node
/** Actual measurements, labeled by scenario. This is not a framework-size or performance-gain claim. */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, resolve, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { scanRepository } from './tauri-inventory.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frameLimit = 1024 * 1024
const redactedFailure = () => new Error('Baseline scenario failed; no child output or command arguments were retained')

async function childMemory(child) {
  if (process.platform !== 'linux' || !child.pid) return null
  try {
    const status = await readFile(`/proc/${child.pid}/status`, 'utf8')
    const rss = /VmRSS:\s+(\d+) kB/.exec(status)
    const highWater = /VmHWM:\s+(\d+) kB/.exec(status)
    return rss ? { rssBytes: Number(rss[1]) * 1024, processHighWaterBytes: highWater ? Number(highWater[1]) * 1024 : null } : null
  } catch { return null }
}

async function measureChild(child, action, timeoutMs) {
  const closed = once(child, 'close')
  void closed.catch(() => {})
  let peak = null
  let sampling = false
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      const current = await childMemory(child)
      if (current) peak = { rssBytes: Math.max(peak?.rssBytes ?? 0, current.rssBytes),
        processHighWaterBytes: Math.max(peak?.processHighWaterBytes ?? 0, current.processHighWaterBytes ?? 0) }
    } finally { sampling = false }
  }
  const interval = setInterval(() => { void sample() }, 250)
  let timer
  const started = performance.now()
  try {
    await sample()
    const result = await Promise.race([
      action(closed, sample),
      new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(redactedFailure()) }, timeoutMs) })
    ])
    return { elapsedMs: performance.now() - started, childMemory: peak,
      memoryScope: 'direct child only; 250ms Linux /proc sampling, not the full process tree', result }
  } catch { throw redactedFailure() }
  finally {
    clearTimeout(timer); clearInterval(interval)
    let forceKill
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2000)
    }
    try { await closed.catch(() => {}) } finally { clearTimeout(forceKill) }
  }
}

async function serviceScenario() {
  const temporary = await mkdtemp(resolve(tmpdir(), '21x-baseline-'))
  const child = spawn(process.execPath, [resolve(root, 'src/service/feasibility.mjs')], {
    env: { TWENTYONEX_PROFILE_ROOT: temporary, TWENTYONEX_RESOURCE_ROOT: root },
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let buffered = Buffer.alloc(0)
  let id = 0
  let epoch = ''
  const pending = new Map()
  const rejectPending = () => { for (const entry of pending.values()) entry.reject(redactedFailure()); pending.clear() }
  child.on('error', rejectPending)
  child.on('close', rejectPending)
  child.stdin.on('error', () => { for (const entry of pending.values()) entry.reject(redactedFailure()); pending.clear() })
  child.stdout.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk])
    if (buffered.length > frameLimit + 1) { child.kill(); return }
    for (;;) {
      const newline = buffered.indexOf(10)
      if (newline < 0) break
      try {
        const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffered.subarray(0, newline)))
        buffered = buffered.subarray(newline + 1)
        if (frame.kind !== 'response' || frame.protocolVersion !== 1 || frame.error || !pending.has(frame.requestId) ||
          typeof frame.engineEpoch !== 'string' || !frame.engineEpoch || epoch && frame.engineEpoch !== epoch) throw redactedFailure()
        const entry = pending.get(frame.requestId)
        pending.delete(frame.requestId)
        entry.resolve(frame)
      } catch { child.kill(); for (const entry of pending.values()) entry.reject(redactedFailure()); pending.clear(); return }
    }
  })
  const request = (operation, payload) => new Promise((resolveReply, reject) => {
    const requestId = `host:${++id}`
    pending.set(requestId, { resolve: resolveReply, reject })
    child.stdin.write(JSON.stringify({ kind: 'request', protocolVersion: 1, engineEpoch: epoch, requestId, operation, payload }) + '\n')
  })
  try {
    return await measureChild(child, async (closed, sample) => {
      const started = performance.now()
      const ready = await request('engine.initialize', { protocolVersion: 1, profileRoot: temporary, resourceRoot: root })
      epoch = ready.engineEpoch
      if (ready.result?.engineEpoch !== epoch || ready.result?.protocolVersion !== 1) throw redactedFailure()
      const initializeMs = performance.now() - started
      await sample()
      const pingStarted = performance.now()
      await request('engine.ping', {})
      const pingMs = performance.now() - pingStarted
      await request('engine.shutdown', {})
      if ((await closed)[0] !== 0) throw redactedFailure()
      return { initializeMs, pingMs, nativeProbeExecuted: false, profileOpened: false,
        scope: 'standalone Node feasibility JSON protocol only; no database, agents, renderer or native addons loaded' }
    }, 10_000)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

async function nativeSmokeScenario(executable) {
  if (!isAbsolute(executable)) throw new Error('Native smoke executable must be an explicit absolute path')
  const temporary = await mkdtemp(resolve(tmpdir(), '21x-native-baseline-'))
  const report = resolve(temporary, 'smoke.json')
  const child = spawn(executable, [], { stdio: 'ignore', env: { ...process.env,
    TWENTYONEX_NATIVE_SMOKE_REPORT: report, PATH: '/nonexistent' } })
  try {
    return await measureChild(child, async closed => {
      if ((await closed)[0] !== 0) throw redactedFailure()
      const evidence = JSON.parse(await readFile(report, 'utf8'))
      if (evidence.schemaVersion !== 1 || evidence.passed !== true || evidence.runtime?.systemNodeHidden !== true) throw redactedFailure()
      return { nativeSmokePassed: true, scope: 'complete debug native smoke duration; startup-only latency and descendant memory are not measured' }
    }, 75_000)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

export async function runBaseline({ scenario = 'inventory', executable } = {}) {
  const environment = { nodeVersion: process.version, platform: process.platform, arch: process.arch, cacheCondition: 'not controlled; no filesystem cache flush' }
  if (scenario === 'inventory') {
    const started = performance.now()
    const before = process.resourceUsage()
    const inventory = scanRepository(root)
    const after = process.resourceUsage()
    return { formatVersion: 1, scenario, environment, elapsedMs: performance.now() - started,
      parserProcess: { maxRssBytes: after.maxRSS * 1024, userCpuMicros: after.userCPUTime - before.userCPUTime,
        systemCpuMicros: after.systemCPUTime - before.systemCPUTime }, summary: inventory.summary,
      scope: 'parse-only inventory process; not Electron or Tauri application performance' }
  }
  if (scenario === 'service') return { formatVersion: 1, scenario, environment, ...await serviceScenario() }
  if (scenario === 'native-smoke') return { formatVersion: 1, scenario, environment, ...await nativeSmokeScenario(executable ?? '') }
  throw new Error('Unknown baseline scenario')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  try {
    const options = {}
    while (args.length) {
      const flag = args.shift()
      if (!['--scenario', '--executable'].includes(flag) || !args.length) throw new Error('Usage: tauri-baseline.mjs [--scenario inventory|service|native-smoke] [--executable ABSOLUTE_PATH]')
      options[flag === '--scenario' ? 'scenario' : 'executable'] = args.shift()
    }
    console.log(JSON.stringify(await runBaseline(options), null, 2))
  } catch { console.error('Baseline measurement failed; no child diagnostics were emitted'); process.exitCode = 1 }
}
