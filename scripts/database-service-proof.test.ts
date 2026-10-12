import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('packaged synthetic database service proof', () => {
  it.skipIf(!process.env.TAURI_DATABASE_SERVICE_ENTRY)('runs real command/event/projection/reopen/lock checks in standalone Node', async () => {
    const executable = process.env.TAURI_NODE_RUNTIME || 'node'
    const { stdout } = await promisify(execFile)(executable, ['scripts/database-service-proof.mjs'], {
      cwd: root, timeout: 60_000, maxBuffer: 1_048_576,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
    const report = JSON.parse(stdout)
    expect(report.passed).toBe(true)
    expect(report.profileContentionRejected).toBe(true)
    expect(report.durableProjectionAndReloadQueries).toBe(true)
    expect(report.cancelBeforeEffects).toBe(true)
    expect(report.reopenAndNewEpoch).toBe(true)
    expect(report.syntheticProfileRemoved).toBe(true)
  }, 65_000)
})
