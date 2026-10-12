import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const entry = process.env.TAURI_DATABASE_SERVICE_ENTRY
describe('actual bundled transcript pagination', () => {
  it.skipIf(!entry)('recovers hundreds of durable parts across snapshot races without losing stored oversized fields', () => {
    const result = spawnSync(process.env.TAURI_NODE_RUNTIME || 'node', [join(__dirname, 'transcript-page-proof.mjs')], {
      env: process.env, encoding: 'utf8', timeout: 30_000, maxBuffer: 32_768
    })
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ passed: true, actualBundledService: true, parts: 642, racingUpdatesRecovered: true,
      oversizedFieldPreviewOnly: true, widePayloadsBounded: true, missingTaskAndMalformedRequestsDenied: true, acknowledgedServiceExit: true, syntheticProfileRemoved: true })
    expect(report.snapshotPages).toBeGreaterThan(1)
    expect(report.deltaPages).toBe(3)
    expect(report.largestPageBytes).toBeLessThanOrEqual(report.pageByteLimit)
    expect(report.largestPageBytes).toBeGreaterThan(128 * 1024)
  })
})
