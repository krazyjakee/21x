import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

describe('actual staged content configuration service', () => {
  it.skipIf(!process.env.TAURI_DATABASE_SERVICE_ENTRY)('preserves all 18 command effects, conflicts, invalidations and restart durability', async () => {
    const { stdout } = await promisify(execFile)(process.env.TAURI_NODE_RUNTIME || 'node', ['scripts/configuration-service-proof.mjs'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, timeout: 60_000, maxBuffer: 65_536
    })
    expect(JSON.parse(stdout)).toMatchObject({ passed: true, actualBundledService: true, syntheticOnly: true,
      contentCommands: 18, skillConflictsPreserved: true, invalidReordersRejected: true, lifecycleFieldsRejected: true,
      publicInvalidationsOnly: true, cancellationBeforeEffects: true, newEpochAndDurability: true, acknowledgedServiceExit: true, syntheticProfileRemoved: true })
  }, 65_000)
})
