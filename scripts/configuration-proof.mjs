import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageDatabaseProof } from './database-proof.mjs'

/** Reuse explicitly selected Node-ABI SQLite; never fall back to Verify's addon. */
export async function runConfigurationProof({ sqliteModule = process.env.TAURI_SQLITE_MODULE } = {}) {
  if (process.versions.electron) throw new Error('Standalone Node is required')
  const directory = await mkdtemp(join(tmpdir(), '21x-configuration-proof-'))
  const diagnostics = new Map(['log', 'info', 'debug', 'warn', 'error'].map(method => [method, console[method]]))
  for (const method of diagnostics.keys()) console[method] = () => process.stderr.write('[configuration-proof] dependency diagnostic redacted\n')
  try {
    const staged = await stageDatabaseProof(directory, { sqliteModule, fixture: 'configuration' })
    const { runConfigurationFixture } = await import(staged.fixture)
    return { ...await runConfigurationFixture(directory), portableModuleCount: staged.moduleCount }
  } finally {
    for (const [method, original] of diagnostics) console[method] = original
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runConfigurationProof()) + '\n') }
  catch { process.stderr.write('[configuration-proof] proof failed\n'); process.exitCode = 1 }
}
