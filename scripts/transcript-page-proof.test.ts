import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdtempSync, openSync, closeSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const entry = process.env.TAURI_DATABASE_SERVICE_ENTRY
describe('actual bundled transcript pagination', () => {
  it.skipIf(!entry).each(['runtime', 'stdio', 'profile', 'resources'] as const)('reports only a fixed %s startup classification on unavailable prerequisites', stage => {
    const root = mkdtempSync(join(tmpdir(), '21x-database-service-'))
    const resourceRoot = dirname(dirname(entry!))
    const sensitive = 'fixture-sensitive-path-must-not-echo'
    const environment = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]))
    Object.assign(environment, { TWENTYONEX_DATABASE_MODE: stage === 'runtime' ? sensitive : 'synthetic-only',
      TWENTYONEX_PROFILE_ROOT: stage === 'profile' ? sensitive : root,
      TWENTYONEX_RESOURCE_ROOT: stage === 'resources' ? sensitive : resourceRoot })
    const outputFile = stage === 'stdio' ? openSync(join(root, 'redirected-output'), 'w') : undefined
    try {
      const result = spawnSync(process.env.TAURI_NODE_RUNTIME || 'node', [entry!], {
        env: environment, encoding: 'utf8', input: '', timeout: 10_000, maxBuffer: 32_768,
        stdio: ['pipe', outputFile ?? 'pipe', 'pipe']
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(stage === 'runtime' ? '[database-service] trusted bootstrap runtime unavailable\n'
        : `[database-service] startup ${stage} unavailable\n`)
      expect(result.stderr).not.toContain(sensitive)
      expect(result.stdout ?? '').toBe('')
    } finally {
      if (outputFile !== undefined) closeSync(outputFile)
      rmSync(root, { recursive: true, force: true })
    }
  })

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
