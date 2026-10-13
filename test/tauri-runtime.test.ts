import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('standalone portable test runtime', () => {
  it('runs under pinned Node without an Electron runtime', () => {
    expect(process.versions.electron).toBeUndefined()
    expect(process.version).toBe('v22.23.2')
    expect(process.versions.modules).toBe('127')
  })

  it('fails when a portable test imports Electron instead of supplying a mock host', async () => {
    await expect(import('electron')).rejects.toThrow('Electron runtime imports are forbidden in the standalone Tauri suite')
  })

  it('keeps scanner shebangs loadable when Git enables Windows line endings', async () => {
    for (const file of ['scripts/tauri-inventory.mjs', 'scripts/tauri-contracts.mjs']) {
      const { stdout } = await promisify(execFile)('git', ['-c', 'core.autocrlf=true', 'cat-file',
        '--filters', `--path=${file}`, `HEAD:${file}`], { cwd: process.cwd(), windowsHide: true })
      expect(stdout).toMatch(/^#!\/usr\/bin\/env node\n/)
      expect(stdout).not.toContain('\r\n')
      expect(await readFile(file, 'utf8')).not.toContain('\r\n')
    }
  })

  it.skipIf(process.env.TAURI_RUNNER_REPORT_PROBE === '1')('preserves pnpm-style filters and writes the requested report', async () => {
    const directory = await mkdtemp(join(tmpdir(), '21x-runner-report-'))
    const reportPath = join(directory, 'report.json')
    try {
      await promisify(execFile)(process.execPath, ['scripts/tauri-test.mjs', '--', 'test/tauri-runtime.test.ts',
        '--testNamePattern=runs under pinned Node', '--reporter=json', `--outputFile=${reportPath}`], {
        cwd: process.cwd(), timeout: 60_000, maxBuffer: 65_536,
        env: { ...process.env, TAURI_RUNNER_REPORT_PROBE: '1' }
      })
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      expect(report.success).toBe(true)
      expect(report.testResults).toHaveLength(1)
      expect(report.numPassedTests).toBe(1)
      expect(report.numFailedTests).toBe(0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 65_000)
})
