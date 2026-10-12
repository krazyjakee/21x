import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageAgentLifecycleProof } from './agent-lifecycle-proof.mjs'

const events = new Set(['none', 'unreviewed', 'agent:status', 'task:updated', 'transcript:changed', 'agent:startQueueChanged', 'project:statusChanged', 'concurrency:changed', 'agent:recoveryStateChanged'])

export async function runAgentDesktopProof({ sqliteModule = process.env.TAURI_SQLITE_MODULE } = {}) {
  if (process.versions.electron) throw new Error('Standalone Node required')
  const directory = await mkdtemp(join(tmpdir(), '21x-agent-desktop-proof-'))
  const methods = ['log', 'info', 'debug', 'warn', 'error']
  const original = new Map(methods.map(method => [method, console[method]]))
  const diagnosticCounts = Object.fromEntries(methods.map(method => [method, 0]))
  for (const method of methods) console[method] = () => { diagnosticCounts[method]++ }
  try {
    const staged = await stageAgentLifecycleProof(directory, { sqliteModule, fixture: 'desktop' })
    const { runAgentDesktopFixture } = await import(staged.fixture)
    return { ...await runAgentDesktopFixture(directory), portableModuleCount: staged.moduleCount,
      sqliteVersion: staged.sqliteVersion, nodeVersion: process.version, diagnosticCounts }
  } finally {
    for (const [method, callback] of original) console[method] = callback
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runAgentDesktopProof()) + '\n') }
  catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'FIXTURE_FAILED',
      phase: typeof error?.phase === 'string' && /^[a-z-]{1,64}$/.test(error.phase) ? error.phase : 'staging',
      boundaryCode: typeof error?.boundaryCode === 'string' && /^[A-Z_]{1,64}$/.test(error.boundaryCode) ? error.boundaryCode : 'STAGING_FAILED',
      criticalEvent: events.has(error?.criticalEvent) ? error.criticalEvent : 'none' }) + '\n')
    process.exitCode = 1
  }
}
