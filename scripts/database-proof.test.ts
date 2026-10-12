import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('portable database standalone Node proof', () => {
  it('uses real SQLite and durable projections without Electron or a production profile', async () => {
    const executable = process.env.TAURI_NODE_RUNTIME || process.execPath
    const { stdout } = await promisify(execFile)(executable, ['scripts/database-proof.mjs'], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 1_048_576,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
    const report = JSON.parse(stdout)
    expect(report.passed).toBe(true)
    expect(report.runtime).toBe('standalone-node')
    expect(report.schemaVersion).toBe(32)
    expect(report.portableModuleCount).toBeGreaterThan(10)
    expect(report.proofs).toContain('durable-transcript-snapshot-delta-reopen')
    expect(report.proofs).toContain('managed-mcp-idempotency-ownership')
  }, 35_000)
})
