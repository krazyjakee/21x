import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'

export const execFileAsync = promisify(execFile)

/**
 * Locates a CLI on PATH with `which`/`where`, then falls back to well-known
 * install locations (packaged GUI apps on macOS often start with a minimal PATH).
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
    // Not on PATH.
  }
  return fallbackPaths.find((path) => existsSync(path)) ?? null
}
