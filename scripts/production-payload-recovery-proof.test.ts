import { describe, expect, it, vi } from 'vitest'
import { PAYLOAD_RECOVERY_FIXTURE, assertProofCounter } from './production-payload-recovery-proof'

describe('production payload acceptance evidence', () => {
  it('rejects failed or nonfinite actual evidence with an actionable counter', () => {
    expect(() => assertProofCounter({ name: 'duplicate parts', expected: 0, actual: 1, comparison: 'equal' })).toThrow('duplicate parts: expected equal 0, actual 1')
    expect(() => assertProofCounter({ name: 'queue bytes', expected: 4, actual: 5, comparison: 'atMost' })).toThrow('queue bytes')
    expect(() => assertProofCounter({ name: 'native exits', expected: 4, actual: 3, comparison: 'atLeast' })).toThrow('native exits')
    expect(() => assertProofCounter({ name: 'missing measurement', expected: 4, actual: NaN, comparison: 'atMost' })).toThrow('missing measurement')
  })

  it('keeps the workload finite and large enough to require bounded pagination', () => {
    expect(PAYLOAD_RECOVERY_FIXTURE.transcriptParts * PAYLOAD_RECOVERY_FIXTURE.partChars).toBeGreaterThan(4_000_000)
    expect(PAYLOAD_RECOVERY_FIXTURE.terminals).toBe(4)
    expect(PAYLOAD_RECOVERY_FIXTURE.attachmentBytes).toBe(512 * 1024)
  })

  it.skipIf(process.env.TAURI_TERMINAL_PROOFS !== '1' || process.platform !== 'linux')('loads actual production owners under staged Node and emits measured recovery evidence', async () => {
    // ProductionOwner owns its process-global storage registration. As in the
    // existing production-service fixture, isolate it from portable test setup.
    vi.resetModules()
    const { runProductionPayloadRecoveryProof } = await import('./production-payload-recovery-proof')
    const report = await runProductionPayloadRecoveryProof()
    expect(report.cleanup).toEqual({ ownerClosed: true, nativeExits: 4, profileRemoved: true })
    expect(report.epochs).toHaveLength(2)
    expect(report.epochs[0]).not.toBe(report.epochs[1])
    expect(report.counters.length).toBeGreaterThan(35)
    for (const counter of report.counters) assertProofCounter(counter)
    expect(report.provenance.electron).toBeNull()
    expect(report.provenance.webview).toBeNull()
    expect(report.remaining.some(value => value.includes('#202'))).toBe(true)
    // One complete machine-readable receipt, with no profile path, raw payload,
    // provider credentials or environment values. Primary retains the log/hash.
    console.info(`PRODUCTION_PAYLOAD_RECOVERY_REPORT ${JSON.stringify(report)}`)
  }, 120_000)
})
