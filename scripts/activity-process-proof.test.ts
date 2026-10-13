import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
describe('actual main-process activity liveness', () => {
  it.skipIf(!process.env.TAURI_SQLITE_MODULE)('proves silent owned-child polling, desktop-only heartbeats, disconnect and scoped teardown', async () => {
    const { stdout } = await promisify(execFile)(process.env.TAURI_NODE_RUNTIME || 'node', ['scripts/activity-process-proof.mjs'], {
      cwd: root, timeout: 60000, maxBuffer: 1048576, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
    const report = JSON.parse(stdout)
    expect(report).toMatchObject({ ok: true, actualLifecycleOwner: true, realSqlite: true, standaloneNode: true,
      canonicalLockedProfile: true, controlledBackend: true, noSdkParityClaim: true, realChildRpc: true,
      nativeWindowOnlyHeartbeats: true, externalHeartbeatCount: 0, mobileHeartbeatCount: 0,
      freshWorkingHeartbeatsStoppedAfterDeath: true, healthyBridgeDidNotBlessDeadOwner: true,
      completedCaptainTurnObserved: true, manualAbortCancelled: true, stopCleansOwnedChild: true,
      shutdownCleansOwnedChild: true, unregisteredChildSurvivedManagerTeardown: true, capturedMetadata: { epochCount: 1 } })
    expect(report.quietOperationMs).toBeGreaterThan(15000)
    expect(report.minimumHeartbeatIntervalMs).toBeGreaterThanOrEqual(5000)
    expect(report.heartbeatCount).toBeGreaterThanOrEqual(3)
    expect(report.disconnectLatencyMs).toBeLessThanOrEqual(4000)
    expect(report.ownedProcessCounts.exited).toBe(report.ownedProcessCounts.created)
    expect(report.capturedMetadata.heartbeatSequences).toHaveLength(report.heartbeatCount)
    expect(report.sourcePollCountDuringSilence).toBeGreaterThanOrEqual(5)
    expect(report.sourceStatusCountDuringSilence).toBeGreaterThanOrEqual(5)
  }, 65000)
})
