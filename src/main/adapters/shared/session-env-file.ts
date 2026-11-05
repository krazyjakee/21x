import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { buildShellExports } from './shell-exports'

/**
 * Writes `export` lines to an owner-only file for a CLI to source, and returns
 * its path. Pass the previous path to update the file in place.
 */
export function writeSessionEnvFile(previousPath: string | undefined, vars: Record<string, string>): string {
  const path = previousPath ?? join(mkdtempSync(join(tmpdir(), '21x-session-env-')), 'env.sh')
  writeFileSync(path, `${buildShellExports(vars)}\n`, { mode: 0o600 })
  return path
}

export function removeSessionEnvFile(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true })
}
