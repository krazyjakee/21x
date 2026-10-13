import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('portable database standalone Node proof', () => {
  it.skipIf(!process.env.TAURI_SQLITE_MODULE)('uses explicitly staged SQLite in standalone Node without a production profile', async () => {
    // Verify executes Vitest under Electron and rebuilds its root SQLite addon
    // for Electron. Select Node independently and require an explicit Node ABI
    // addon; the native workflow enables this after tauri:prepare:native.
    const executable = process.env.TAURI_NODE_RUNTIME || 'node'
    const { stdout } = await promisify(execFile)(executable, ['scripts/database-proof.mjs'], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 1_048_576,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
    const report = JSON.parse(stdout)
    expect(report.passed).toBe(true)
    expect(report.runtime).toBe('standalone-node')
    expect(report.schemaVersion).toBe(36)
    expect(report.portableModuleCount).toBeGreaterThan(10)
    expect(report.proofs).toContain('durable-transcript-snapshot-delta-reopen')
    expect(report.proofs).toContain('managed-mcp-idempotency-ownership')
    expect(report.proofs).toContain('authenticated-settings-envelope-tamper')
  }, 35_000)
})
