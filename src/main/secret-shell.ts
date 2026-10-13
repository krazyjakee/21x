import { writeFileSync, chmodSync } from 'fs'
import { join } from 'path'

/**
 * Writes the secret shell wrapper script to the explicitly owned profile.
 * This script is set as $SHELL for agent processes — it transparently fetches
 * secrets from the broker before executing the real shell.
 *
 * Returns the absolute path to the wrapper script.
 */
export function writeSecretShellWrapper(profileRoot: string, platform: NodeJS.Platform = process.platform): string {
  const isWin = platform === 'win32'

  if (isWin) {
    return writeWindowsSecretShellWrapper(profileRoot)
  }

  const shellPath = join(profileRoot, 'secret-shell.sh')

  const debugLog = "'" + join(profileRoot, 'secret-shell-debug.log').replace(/'/g, "'\\''") + "'"

  const script = `#!/bin/bash
# 21x Secret Shell Wrapper
# Fetches secrets from the local broker and injects them into the command environment.
# The agent process has _20X_SB_PORT and _20X_SB_TOKEN but NOT the actual secret values.

_real_shell="\${_20X_REAL_SHELL:-/bin/bash}"

# Fetch secrets from broker and export them
if [ -n "\$_20X_SB_PORT" ] && [ -n "\$_20X_SB_TOKEN" ]; then
  # Keep the response in memory: a shared temp file would be readable by other
  # users and would race between concurrent agent sessions.
  _20x_secrets=\$(curl -sf --max-time 5 "http://127.0.0.1:\${_20X_SB_PORT}/secrets/export?token=\${_20X_SB_TOKEN}" 2>/dev/null)
  _20x_curl_exit=\$?

  # Command arguments are not logged; they can contain secrets.
  echo "[secret-shell \$(date '+%H:%M:%S')] port=\$_20X_SB_PORT curl_exit=\$_20x_curl_exit body_len=\${#_20x_secrets}" >> ${debugLog}

  if [ -n "\$_20x_secrets" ]; then
    eval "\$_20x_secrets"
  fi
fi
# Clean up broker vars even when credentials were incomplete.
unset _20X_SB_PORT _20X_SB_TOKEN _20X_REAL_SHELL _20x_secrets _20x_curl_exit

# Execute the real shell with original arguments
exec "\$_real_shell" "\$@"
`

  writeFileSync(shellPath, script, 'utf-8')
  chmodSync(shellPath, 0o755)
  console.log(`[SecretBroker] Wrote shell wrapper to ${shellPath}`)
  return shellPath
}

/**
 * Windows PowerShell secret shell wrapper script body.
 * Exported for unit tests.
 */
export function buildWindowsSecretShellScript(debugLogPath: string): string {
  const debugLog = "'" + debugLogPath.replace(/'/g, "''") + "'"

  return `# 21x Secret Shell Wrapper (Windows PowerShell)
# Fetches secrets from the local broker and injects them into the command environment.

$ErrorActionPreference = "SilentlyContinue"

if ($env:_20X_SB_PORT -and $env:_20X_SB_TOKEN) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($env:_20X_SB_PORT)/secrets/export?token=$($env:_20X_SB_TOKEN)&format=base64" -UseBasicParsing -TimeoutSec 5
        $secrets = $response.Content

        $timestamp = Get-Date -Format "HH:mm:ss"
        Add-Content -LiteralPath ${debugLog} -Value "[secret-shell $timestamp] port=$($env:_20X_SB_PORT) status=$($response.StatusCode) body_len=$($secrets.Length)"

        if ($secrets) {
            # Parse NAME=<base64 utf-8> lines; base64 keeps multi-line values intact
            $secrets -split "\\r?\\n" | ForEach-Object {
                if ($_ -match "^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9+/=]*)$") {
                    $key = $Matches[1]
                    $val = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Matches[2]))
                    [Environment]::SetEnvironmentVariable($key, $val, "Process")
                }
            }
        }
    } catch {
        # Exception text can contain the credential-bearing request URI.
        Add-Content -LiteralPath ${debugLog} -Value "[secret-shell $(Get-Date -Format 'HH:mm:ss')] broker request failed"
    }

}
# Clean up broker vars even when credentials were incomplete.
Remove-Item Env:\\_20X_SB_PORT -ErrorAction SilentlyContinue
Remove-Item Env:\\_20X_SB_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:\\_20X_REAL_SHELL -ErrorAction SilentlyContinue

# Execute the real command with original arguments
if ($args.Count -gt 0) {
    & $args[0] $args[1..($args.Count-1)]
} else {
    cmd.exe /c
}
`
}

/**
 * Windows equivalent of the secret shell wrapper using PowerShell.
 * Fetches secrets from the broker and injects them as environment variables
 * before executing the real command.
 */
function writeWindowsSecretShellWrapper(profileRoot: string): string {
  const shellPath = join(profileRoot, 'secret-shell.ps1')
  const debugLog = join(profileRoot, 'secret-shell-debug.log')

  const script = buildWindowsSecretShellScript(debugLog)

  writeFileSync(shellPath, script, 'utf-8')
  console.log(`[SecretBroker] Wrote shell wrapper to ${shellPath}`)
  return shellPath
}
