/**
 * Secret Broker — local HTTP server for secure secret injection.
 *
 * Runs in the Electron main process, listens on 127.0.0.1:{random port}.
 * Agent shell wrappers call this to fetch decrypted secrets at command execution time.
 * Secrets never enter the agent process environment directly — only the broker
 * port and a per-session token are passed to the agent.
 *
 * Flow:
 *   1. Agent session starts → registerSecretSession(token, agentId, secretIds)
 *   2. Agent's SHELL is set to secret-shell.sh wrapper
 *   3. Wrapper calls GET /secrets/export?token=<token>
 *   4. Broker decrypts secrets from SQLite, returns export KEY='val' statements
 *   5. Wrapper evals exports, unsets broker vars, exec's real shell
 *   6. The real shell command runs with secrets in env — agent process never has them
 */

import { createServer, type Server as HttpServer } from 'http'
import { writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { DatabaseManager } from './database'

const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

let server: HttpServer | null = null
let port: number | null = null
let dbRef: DatabaseManager | null = null

// session token → { agentId, secretIds }
const activeSessions = new Map<string, { agentId: string; secretIds: string[] }>()

export function getSecretBrokerPort(): number | null {
  return port
}

export function registerSecretSession(token: string, agentId: string, secretIds: string[]): void {
  activeSessions.set(token, { agentId, secretIds })
  console.log(`[SecretBroker] Registered session for agent ${agentId} with ${secretIds.length} secret(s)`)
}

export function unregisterSecretSession(token: string): void {
  activeSessions.delete(token)
}

export function startSecretBroker(db: DatabaseManager): Promise<number> {
  if (server && port) return Promise.resolve(port)
  dbRef = db

  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')

      if (url.pathname === '/secrets/export') {
        const token = url.searchParams.get('token')
        if (!token || !activeSessions.has(token)) {
          console.log(`[SecretBroker] 403 — invalid/missing token: ${token ? token.substring(0, 8) + '...' : 'null'}`)
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('')
          return
        }

        const session = activeSessions.get(token)!
        if (!dbRef) {
          console.log('[SecretBroker] 500 — dbRef is null')
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('')
          return
        }

        console.log(`[SecretBroker] Fetching secrets for agent ${session.agentId}, secretIds: [${session.secretIds.join(', ')}]`)
        const secrets = dbRef.getSecretsWithValues(session.secretIds)
        console.log(`[SecretBroker] Found ${secrets.length} secret(s): [${secrets.map(s => `${s.env_var_name}(${s.value.length} chars)`).join(', ')}]`)

        // The wrapper evals this body, so names are restricted to shell
        // identifiers and values are single-quoted with embedded quotes escaped.
        const exports = secrets
          .filter(s => {
            if (SHELL_IDENTIFIER.test(s.env_var_name)) return true
            console.warn(`[SecretBroker] Skipping secret with invalid variable name: ${JSON.stringify(s.env_var_name)}`)
            return false
          })
          .map(s => `export ${s.env_var_name}='${s.value.replace(/'/g, "'\\''")}'`)
          .join('\n')

        console.log(`[SecretBroker] Response body length: ${exports.length} bytes`)
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(exports)
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('')
    })

    // Listen on random available port, loopback only
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (typeof addr === 'object' && addr) {
        port = addr.port
        console.log(`[SecretBroker] Started on port ${port}`)
        resolve(port)
      } else {
        reject(new Error('Failed to get secret broker address'))
      }
    })

    server.on('error', reject)
  })
}

export function stopSecretBroker(): void {
  if (server) {
    server.close()
    server = null
    port = null
  }
  activeSessions.clear()
}

/**
 * Writes the secret shell wrapper script to the app's userData directory.
 * This script is set as $SHELL for agent processes — it transparently fetches
 * secrets from the broker before executing the real shell.
 *
 * Returns the absolute path to the wrapper script.
 */
export function writeSecretShellWrapper(): string {
  const isWin = process.platform === 'win32'

  if (isWin) {
    return writeWindowsSecretShellWrapper()
  }

  const shellPath = join(app.getPath('userData'), 'secret-shell.sh')

  const debugLog = join(app.getPath('userData'), 'secret-shell-debug.log')

  const script = `#!/bin/bash
# 20x Secret Shell Wrapper
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
  echo "[secret-shell \$(date '+%H:%M:%S')] port=\$_20X_SB_PORT curl_exit=\$_20x_curl_exit body_len=\${#_20x_secrets}" >> "${debugLog}"

  if [ -n "\$_20x_secrets" ]; then
    eval "\$_20x_secrets"
  fi
  # Clean up broker vars so they don't leak into command output
  unset _20X_SB_PORT _20X_SB_TOKEN _20X_REAL_SHELL _20x_secrets _20x_curl_exit
fi

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
  const debugLog = debugLogPath.replace(/\\/g, '\\\\')

  return `# 20x Secret Shell Wrapper (Windows PowerShell)
# Fetches secrets from the local broker and injects them into the command environment.

$ErrorActionPreference = "SilentlyContinue"

if ($env:_20X_SB_PORT -and $env:_20X_SB_TOKEN) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($env:_20X_SB_PORT)/secrets/export?token=$($env:_20X_SB_TOKEN)" -UseBasicParsing -TimeoutSec 5
        $secrets = $response.Content

        $timestamp = Get-Date -Format "HH:mm:ss"
        Add-Content -Path "${debugLog}" -Value "[secret-shell $timestamp] port=$($env:_20X_SB_PORT) status=$($response.StatusCode) body_len=$($secrets.Length)"

        if ($secrets) {
            # Parse KEY=VALUE lines and set as environment variables
            $secrets -split "\\n" | ForEach-Object {
                if ($_ -match "^export\\s+([^=]+)=(.*)$") {
                    $key = $Matches[1]
                    # Values arrive single-quoted with ' written as '\\''
                    $val = ($Matches[2] -replace "^'|'$", "") -replace "'\\\\''", "'"
                    [Environment]::SetEnvironmentVariable($key, $val, "Process")
                }
            }
        }
    } catch {
        Add-Content -Path "${debugLog}" -Value "[secret-shell $(Get-Date -Format 'HH:mm:ss')] ERROR: $_"
    }

    # Clean up broker vars
    Remove-Item Env:\\_20X_SB_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:\\_20X_SB_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\\_20X_REAL_SHELL -ErrorAction SilentlyContinue
}

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
function writeWindowsSecretShellWrapper(): string {
  const shellPath = join(app.getPath('userData'), 'secret-shell.ps1')
  const debugLog = join(app.getPath('userData'), 'secret-shell-debug.log')

  const script = buildWindowsSecretShellScript(debugLog)

  writeFileSync(shellPath, script, 'utf-8')
  console.log(`[SecretBroker] Wrote shell wrapper to ${shellPath}`)
  return shellPath
}
