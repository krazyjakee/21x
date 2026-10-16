import { describe, expect, it, vi } from 'vitest'

describe('actual production task feedback acceptance', () => {
  it.skipIf(process.env.TAURI_TERMINAL_PROOFS !== '1' || process.platform !== 'linux')('delivers real scoped owner notices after acknowledged checkpoint/source effects', async () => {
    vi.resetModules()
    const { runProductionTaskFeedbackProof, TASK_FEEDBACK_EVENTS } = await import('../../scripts/production-task-feedback-proof')
    const report = await runProductionTaskFeedbackProof()
    expect(report.cleanup).toEqual({ ownerStopped: true, profileRemoved: true })
    expect(report.notices.map(notice => notice.operation)).toEqual([...TASK_FEEDBACK_EVENTS])
    expect(report.notices.find(notice => notice.operation === 'task:checkpointAnswered')?.payload).toMatchObject({ approved: false })
    expect(report.notices.every(notice => Number.isSafeInteger(notice.sequence) && notice.sequence > 0)).toBe(true)
    expect(report.raw).toMatchObject({ sourceCommands: 1, sourceCallbacks: 1, sourceChildren: 1, sourceStdio: 2, nativeDrainAcks: 1 })
    expect(report.counters.length).toBeGreaterThan(60)
    expect(report.counters.every(counter => Number.isFinite(counter.actual) && counter.actual === counter.expected)).toBe(true)
    expect(report.provenance.webview).toBeNull()
    expect(report.remaining.some(gate => gate.includes('#202'))).toBe(true)
    console.info(`PRODUCTION_TASK_FEEDBACK_REPORT ${JSON.stringify(report)}`)
  }, 120_000)
})
