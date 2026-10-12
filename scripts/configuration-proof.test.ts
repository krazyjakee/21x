import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
describe('configuration bindings with actual standalone SQLite', () => {
  it.skipIf(!process.env.TAURI_SQLITE_MODULE)('enforces scoped content CRUD and durable reopen on synthetic profiles', async () => {
    const { stdout } = await promisify(execFile)(process.env.TAURI_NODE_RUNTIME || 'node', ['scripts/configuration-proof.mjs'], {
      cwd: root, timeout: 30_000, maxBuffer: 1_048_576,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
    const report = JSON.parse(stdout)
    expect(report.passed).toBe(true)
    expect(report.runtime).toBe('standalone-node')
    expect(report.boundCommands).toBe(18)
    expect(report.proofs).toEqual(expect.arrayContaining(['caller-project-association', 'skill-current-destination-authority', 'skill-version-conflict', 'complete-reorder-sets', 'transaction-rollback', 'durable-reopen', 'agent-crud-unbound']))
  }, 35_000)
})
