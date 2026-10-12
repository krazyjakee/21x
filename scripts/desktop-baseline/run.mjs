#!/usr/bin/env node
/** Linux application baseline; raw child logs, process arguments and data are never retained. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import electron from 'electron'

const directory = dirname(fileURLToPath(import.meta.url))
const fail = () => new Error('Desktop baseline failed; child diagnostics were not retained')
const failurePhases = new Set(['profile', 'application-bootstrap', 'interactive', 'task-workload', 'reload', 'idle'])
async function processes() {
  const result = new Map()
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const text = await readFile(`/proc/${name}/stat`, 'utf8')
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
      const rss = /VmRSS:\s+(\d+) kB/.exec(await readFile(`/proc/${name}/status`, 'utf8'))
      result.set(Number(name), { parent: Number(fields[1]), start: fields[19], rss: rss ? Number(rss[1]) * 1024 : 0 })
    } catch { /* A process can exit between snapshots. */ }
  }
  return result
}
async function measure(profile, token) {
  const environment = { ...process.env, TWENTYONEX_BASELINE_PROFILE: profile, TWENTYONEX_BASELINE_TOKEN: token }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  const started = performance.now()
  const child = spawn(electron, [resolve(directory, 'electron.cjs')], {
    env: environment, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe']
  })
  let buffer = Buffer.alloc(0)
  let report
  let malformed = false
  child.stdio[3].on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 65536) { malformed = true; buffer = Buffer.alloc(0); return }
    if (buffer.at(-1) === 10) {
      try { if (report) throw fail(); report = JSON.parse(buffer.toString('utf8')); buffer = Buffer.alloc(0) }
      catch { malformed = true }
    }
  })
  const closed = new Promise((done, reject) => { child.once('close', code => done(code)); child.once('error', reject) })
  const observed = new Map()
  let peakTreeRssBytes = 0
  let samples = 0
  let sampling = false
  async function sample() {
    if (sampling) return
    sampling = true
    try {
      const table = await processes()
      const parent = table.get(child.pid)
      if (parent && (!observed.has(child.pid) || observed.get(child.pid) === parent.start)) observed.set(child.pid, parent.start)
      let found = true
      while (found) {
        found = false
        for (const [pid, row] of table) {
          const owner = table.get(row.parent)
          if (!observed.has(pid) && owner && observed.get(row.parent) === owner.start) { observed.set(pid, row.start); found = true }
        }
      }
      let total = 0
      for (const [pid, start] of observed) if (table.get(pid)?.start === start) total += table.get(pid).rss
      peakTreeRssBytes = Math.max(total, peakTreeRssBytes)
      samples++
    } finally { sampling = false }
  }
  const interval = setInterval(() => { void sample().catch(() => {}) }, 250)
  let force
  const timeout = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already exited. */ }
    force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ } }, 2000)
  }, 90000)
  try {
    const code = await closed
    const elapsedMs = performance.now() - started
    if (code !== 0 || malformed || buffer.length || report?.schemaVersion !== 1 || report?.passed !== true || !samples) {
      throw Object.assign(fail(), { phase: failurePhases.has(report?.failurePhase) ? report.failurePhase : 'process-or-report' })
    }
    return { ...report, elapsedMs, peakTreeRssBytes, memorySamples: samples,
      shutdownUpperBoundMs: Math.max(0, elapsedMs - report.quitRequestedMs),
      memoryMethod: '250ms Linux /proc descendant snapshots; summed RSS double-counts shared pages; short-lived or escaping descendants can be missed' }
  } finally { clearInterval(interval); clearTimeout(timeout); clearTimeout(force) }
}
export async function runDesktopBaseline(repetitions = 3) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'linux' || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw fail()
  await readFile(resolve(directory, '../../out/main/index.js'))
  const profile = await mkdtemp(resolve(tmpdir(), '21x-desktop-baseline-'))
  const token = randomUUID()
  await writeFile(resolve(profile, '.baseline-owned'), token, { mode: 0o600, flag: 'wx' })
  await writeFile(resolve(profile, '.21x-identity-migration.json'), JSON.stringify({ outcome: 'fresh-install', renamedInPlace: false, copied: [], failed: [] }), { mode: 0o600, flag: 'wx' })
  try {
    const runs = []
    for (let index = 0; index < repetitions; index++) runs.push(await measure(profile, token))
    return { schemaVersion: 1, scenario: 'actual-electron-renderer-task-reload', runs,
      cacheCondition: 'first fresh profile then reused profile; OS/code caches uncontrolled; no cold-start claim',
      scope: 'production Electron build through a test-only bootstrap, remote renderer requests blocked, one fixture task; no agents, approvals, terminal throughput or matched Tauri comparison' }
  } finally { await rm(profile, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runDesktopBaseline(), null, 2)) }
  catch (error) { console.error(fail().message + '; phase=' + (failurePhases.has(error?.phase) ? error.phase : 'process-or-report')); process.exitCode = 1 }
}
