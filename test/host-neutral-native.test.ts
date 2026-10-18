import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertHostNeutralRuntime, inspectHostNeutralAbi } from '../scripts/host-neutral-runtime.mjs'

describe('actual additive standalone launcher', () => {
  it('owns the pinned runtime and loads both staged native addons without changing root addons', async () => {
    const resources = assertHostNeutralRuntime(process.cwd())
    const require = createRequire(join(process.cwd(), 'package.json'))
    const rootPackages = ['better-sqlite3', 'node-pty'].map(name => dirname(require.resolve(`${name}/package.json`)))
    const snapshot = async () => {
      const entries: Array<{ file: string; sha256: string }> = []
      for (const directory of rootPackages) {
        for (const file of (await readdir(directory, { recursive: true })).filter(file => file.endsWith('.node')).sort()) {
          const full = join(directory, file)
          entries.push({ file: full, sha256: createHash('sha256').update(await readFile(full)).digest('hex') })
        }
      }
      return entries
    }
    // --ignore-scripts CI need not have any root PTY binary. Absence is part
    // of this snapshot too; the runner must neither create nor rebuild one.
    const before = await snapshot(), result = inspectHostNeutralAbi(resources)
    expect(result).toMatchObject({ node: 'v22.23.2', modules: '127', platform: process.platform, arch: process.arch })
    expect(result.native.length).toBeGreaterThanOrEqual(2)
    expect(await snapshot()).toEqual(before)
    for (const { file } of before) expect(result.native).not.toContain(file)
  })

  it('rejects config overrides before running any caller-selected test or process', async () => {
    await expect(promisify(execFile)(process.execPath, ['scripts/test-host-neutral.mjs', '--config=foreign.config.ts'], { cwd: process.cwd(), timeout: 15_000 }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('does not accept config/root/workspace overrides') })
  })

  it.skipIf(process.env.TAURI_HOST_NEUTRAL_REPORT_PROBE === '1')('forwards pnpm filters and reporters to the exact new project', async () => {
    const root = await mkdtemp(join(tmpdir(), '21x-neutral-report-')), reportPath = join(root, 'report.json'), receiptPath = join(root, 'receipt.json')
    try {
      await promisify(execFile)(process.execPath, ['scripts/test-host-neutral.mjs', '--', '--project=main', 'test/host-neutral-native.test.ts',
        '--testNamePattern=owns the pinned runtime', '--reporter=json', `--outputFile=${reportPath}`, `--run-receipt=${receiptPath}`], {
        cwd: process.cwd(), env: { ...process.env, TAURI_HOST_NEUTRAL_REPORT_PROBE: '1', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--no-warnings' }, timeout: 60_000, maxBuffer: 65536
      })
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      expect(report.success).toBe(true); expect(report.numPassedTests).toBe(1); expect(report.numFailedTests).toBe(0)
      expect(report.testResults).toHaveLength(1)
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      expect(receipt).toMatchObject({ kind: 'host-neutral-test-run', status: 'passed', exitCode: 0, callerFiltered: true, runtime: { node: 'v22.23.2', modules: '127' } })
      expect(receipt.historicalElectronFiles).toBeGreaterThan(0)
      expect(receipt.exclusions.length).toBeGreaterThan(0)
      expect(receipt.artifacts.every((artifact: { sha256: string }) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 65_000)
})
