import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'

/** Only trusted host PATH selects npm; renderer arguments never reach this
 * selector. npm stays external to the verified bundled runtime closure. */
export function resolveProductionNpmCli(environment: Readonly<NodeJS.ProcessEnv>): string | null {
  if (process.platform === 'win32') return null
  const paths = (environment.PATH ?? '').split(delimiter).filter(path => isAbsolute(path) && path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(path))
  for (const directory of paths.slice(0, 128)) {
    try {
      const entry = realpathSync(join(directory, 'npm'))
      if (basename(entry) !== 'npm-cli.js' || entry.length > 4096 || !lstatSync(entry).isFile()) continue
      const manifest = join(dirname(dirname(entry)), 'package.json'), info = lstatSync(manifest)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) continue
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Reflect.get(parsed, 'name') !== 'npm') continue
      return entry
    } catch { /* Missing or unreviewed PATH entries provide no capability. */ }
  }
  return null
}
