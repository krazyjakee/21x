import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

/**
 * Writes a script that fetches a session's secrets from the broker, for a CLI to
 * source, and returns its path. Pass the previous path to update it in place.
 *
 * It holds a session token, never a secret: agents run as the same user with no
 * sandbox, so a file of values left behind by a crash could be read by any later
 * session. The token dies with the session and with the app.
 */
export function writeSessionEnvFile(previousPath: string | undefined, brokerPort: number, sessionToken: string): string {
  const path = previousPath ?? join(mkdtempSync(join(tmpdir(), '21x-session-env-')), 'env.sh')
  const url = `http://127.0.0.1:${brokerPort}/secrets/export?token=${encodeURIComponent(sessionToken)}`
  writeFileSync(path, `eval "$(curl -sf --max-time 5 '${url}' 2>/dev/null)"\n`, { mode: 0o600 })
  return path
}

export function removeSessionEnvFile(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true })
}
