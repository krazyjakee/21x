import { execFile } from 'child_process'
import { accessSync, constants, existsSync, statSync } from 'fs'
import { delimiter, isAbsolute, join } from 'path'
import { promisify } from 'util'

export const execFileAsync = promisify(execFile)

/**
 * Locates a CLI on PATH with `which`/`where`, then falls back to well-known
 * executable files on PATH and well-known install locations. Packaged hosts
 * need not carry the `which`/`where` utilities themselves.
 * Returns null when nothing is found.
 */
export async function findExecutable(binary: string, fallbackPaths: string[] = []): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [binary], {
      timeout: 10_000,
      windowsHide: true,
    })
    const found = stdout.trim().split(/\r?\n/)[0]
    if (found) return found
  } catch {
    // A restricted packaged PATH may contain the CLI but no lookup utility.
  }
  const suffixes = process.platform === 'win32' && !/\.(?:exe|com|cmd|bat)$/i.test(binary)
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(suffix => /^\.[A-Za-z0-9]+$/.test(suffix))]
    : ['']
  for (const directory of (process.env.PATH || '').split(delimiter).filter(isAbsolute)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, binary + suffix)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch { /* Try the next executable candidate. */ }
    }
  }
  return fallbackPaths.find((path) => existsSync(path)) ?? null
}
