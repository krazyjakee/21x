import { describe, expect, it, vi } from 'vitest'

// The existing standalone service wildcard discovers this wrapper. Its actual
// production-owner case requires the existing explicitly staged PTY flag.
describe('actual production workspace cleanup acceptance', () => {
  it.skipIf(process.env.TAURI_TERMINAL_PROOFS !== '1' || process.platform !== 'linux')('retains actual owner/process/descriptor authority through manual and scheduled cleanup', async () => {
    vi.resetModules()
    const { runProductionWorkspaceCleanupProof } = await import('../../scripts/production-workspace-cleanup-proof')
    const report = await runProductionWorkspaceCleanupProof()
    expect(report.cleanup).toEqual({ ownerStopped: true, profileRemoved: true, childExits: 2, ptyExits: 1 })
    expect(report.observation.openDirectoryFds).toBe(0)
    expect(report.observation.scope).toContain('not-full-host-procfs')
    expect(report.counters.length).toBeGreaterThan(45)
    expect(report.provenance.webview).toBeNull()
    expect(report.remaining.some(value => value.includes('#202'))).toBe(true)
    console.info(`PRODUCTION_WORKSPACE_CLEANUP_REPORT ${JSON.stringify(report)}`)
  }, 120_000)
})
