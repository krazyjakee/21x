import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

/**
 * The script a CLI sources to load a session's secrets from the broker.
 *
 * `-q --noproxy '*'` keep a proxy variable or a ~/.curlrc from sending the request,
 * and the token with it, anywhere but the broker. `-q` has to come first. The token
 * sits in the curl config file so that it never appears in a process's arguments.
 *
 * The response is parsed, never evaluated: whatever answers can set a variable but
 * cannot run a command. Agents run as the same user with no sandbox, so a file of
 * values left behind by a crash could be read by any later session, which is why
 * only a token is written. It dies with the session and with the app.
 */
function brokerScript(curlConfigPath: string): string {
  return `_21x_secrets="$(curl -q --noproxy '*' -sf --max-time 5 -K ${shellQuote(curlConfigPath)} 2>/dev/null)" || echo '21x: secrets could not be loaded for this command' >&2
while IFS= read -r _21x_line; do
  case "$_21x_line" in *=*) ;; *) continue ;; esac
  _21x_name="\${_21x_line%%=*}"
  _21x_value="\${_21x_line#*=}"
  case "$_21x_name" in [0-9]*|*[!A-Za-z0-9_]*|'') continue ;; esac
  case "$_21x_value" in *[!A-Za-z0-9+/=]*) continue ;; esac
  export "$_21x_name=$(printf %s "$_21x_value" | base64 --decode)"
done <<_21X_SECRETS
$_21x_secrets
_21X_SECRETS
unset _21x_secrets _21x_line _21x_name _21x_value
`
}

/**
 * Writes the files that load a session's secrets from the broker, and returns the
 * path of the script for the CLI to source. Pass the previous path to update it in
 * place. Both files hold a session token at most, never a secret.
 */
export function writeSessionEnvFile(previousPath: string | undefined, brokerPort: number, sessionToken: string): string {
  const path = previousPath ?? join(mkdtempSync(join(tmpdir(), '21x-session-env-')), 'env.sh')
  const curlConfigPath = join(dirname(path), 'curl.conf')
  const url = `http://127.0.0.1:${brokerPort}/secrets/export?format=base64&token=${encodeURIComponent(sessionToken)}`
  writeFileSync(curlConfigPath, `url = "${url}"\n`, { mode: 0o600 })
  writeFileSync(path, brokerScript(curlConfigPath), { mode: 0o600 })
  return path
}

export function removeSessionEnvFile(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true })
}
