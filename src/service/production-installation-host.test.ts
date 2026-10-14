import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProductionNpmCli } from './production-installation-host'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it.skipIf(process.platform === 'win32')('selects an actual fixed npm CLI entry from trusted PATH, ignoring wrapper names and oversized or foreign manifests', () => {
  const root = mkdtempSync(join(tmpdir(), '21x-npm-capability-')); roots.push(root)
  const bin = join(root, 'bin'), packageRoot = join(root, 'packages', 'npm'), entry = join(packageRoot, 'bin', 'npm-cli.js')
  mkdirSync(bin); mkdirSync(join(packageRoot, 'bin'), { recursive: true }); writeFileSync(entry, '// trusted fixture')
  symlinkSync(entry, join(bin, 'npm')); writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'npm', version: '1.0.0' }))
  expect(resolveProductionNpmCli({ PATH: bin, API_KEY: 'private' })).toBe(entry)
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'other' })); expect(resolveProductionNpmCli({ PATH: bin })).toBeNull()
  writeFileSync(join(packageRoot, 'package.json'), 'x'.repeat(65537)); expect(resolveProductionNpmCli({ PATH: bin })).toBeNull()
  expect(resolveProductionNpmCli({ PATH: '.' })).toBeNull()
})
