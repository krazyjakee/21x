import { describe, expect, it, vi } from 'vitest'

// The existing standalone service wildcard discovers this wrapper. Its actual
// production-owner case requires the existing explicitly staged PTY flag.
describe('actual production workspace cleanup acceptance', () => {
  it.skipIf(process.env.TAURI_TERMINAL_PROOFS !== '1' || process.platform !== 'linux')('retains actual owner/process/descriptor authority through manual and scheduled cleanup', async () => {
    vi.resetModules()
    const { runProductionWorkspaceCleanupProof } = await import('../../scripts/production-workspace-cleanup-proof')
    const report = await runProductionWorkspaceCleanupProof()
    expect(report.cleanup).toEqual({ ownerStopped: true, profileRemoved: true, childExits: 3, ptyExits: 1 })
    expect(report.git.removal).toMatchObject({ worktrees: 2, successfulProductionRemovals: 2, metadataEntriesRemoved: 2, pathsRemoved: 2, rawPending: 0 })
    expect(report.git.final?.rawPending).toBe(0)
    expect(report.git.final?.failedProductionRemovals).toBe(0)
    expect(report.git.final?.commands.every(command => command.callbackReceived && command.callbackDelivered && command.childClosed && command.stdoutClosed && command.stderrClosed)).toBe(true)
    expect(report.observation.openDirectoryFds).toBe(0)
    expect(report.observation.scope).toContain('not-full-host-procfs')
    expect(report.counters.length).toBeGreaterThan(94)
    expect(report.provenance.webview).toBeNull()
    expect(report.remaining.some(value => value.includes('#202'))).toBe(true)
    for (const name of ['manual eligible idle workspace removed', 'actual durable start queue owns second task',
      'stale-start refusal causes zero fatal transport disconnects', 'profile writer retained through raw observer release',
      'absent-row manual orphan counted once', 'independent scheduled dependency setting removes nested modules',
      'two successful production Git removals']) {
      expect(report.counters.find(counter => counter.name === name), `missing retained acceptance: ${name}`).toBeDefined()
    }
    console.info(`PRODUCTION_WORKSPACE_CLEANUP_REPORT ${JSON.stringify(report)}`)
  }, 120_000)
})
