/**
 * Process- and transport-level helpers for the shared `opencode serve` server.
 */

import { execSync } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { delimiter, join } from 'path'
import { homedir } from 'os'
import { setTimeout as sleep } from 'timers/promises'

export const DEFAULT_SERVER_URL = 'http://localhost:4096'

/** Returns the first of url / its localhost↔127.0.0.1 twin whose health check answers. */
export async function findAccessibleServer(url: string): Promise<string | null> {
  const urls = [url]
  if (url.includes('localhost')) {
    urls.push(url.replace('localhost', '127.0.0.1'))
  } else if (url.includes('127.0.0.1')) {
    urls.push(url.replace('127.0.0.1', 'localhost'))
  }

  for (const testUrl of urls) {
    try {
      const response = await fetch(`${testUrl}/global/health`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return testUrl
    } catch {
      // Try next URL
    }
  }
  return null
}

/**
 * Adds common install locations (and the user-configured binary directory) to
 * PATH so the SDK's createOpencode can find the `opencode` binary. The custom
 * path is otherwise only added to PATH during the onboarding dependency check.
 */
export function ensureOpencodeBinaryPaths(customPath: string | null): void {
  const currentPath = process.env.PATH || ''
  const extraPaths = [
    ...(customPath ? [customPath] : []),
    join(homedir(), '.opencode', 'bin'),
    ...(process.platform === 'win32'
      ? [join(homedir(), 'AppData', 'Roaming', 'npm')]
      : ['/usr/local/bin']),
    join(homedir(), '.local', 'bin')
  ].filter(p => !currentPath.includes(p))

  if (extraPaths.length > 0) {
    process.env.PATH = [...extraPaths, currentPath].join(delimiter)
    console.log('[OpencodeAdapter] Added binary paths to PATH:', extraPaths)
  }
}

/**
 * Kills any opencode process on the default port (possibly left over from a
 * previous launch or a terminal session) and deletes the global database with
 * its WAL/SHM sidecars, which can be corrupted by a crash or a version upgrade.
 */
export function killServerAndClearDatabase(): void {
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM opencode.exe 2>nul', { stdio: 'ignore' })
    } else {
      execSync("lsof -ti :4096 | xargs kill -9 2>/dev/null || true", { stdio: 'ignore' })
    }
    console.log('[OpencodeAdapter] Killed opencode process on port 4096')
  } catch {
    // Process may already be gone
  }

  const dbDir = join(homedir(), '.local', 'share', 'opencode')
  for (const file of ['opencode.db', 'opencode.db-shm', 'opencode.db-wal']) {
    const filePath = join(dbDir, file)
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath)
        console.log(`[OpencodeAdapter] Deleted corrupted DB file: ${filePath}`)
      }
    } catch (err) {
      console.warn(`[OpencodeAdapter] Could not delete ${filePath}:`, err)
    }
  }
}

/**
 * Reads the server's SSE stream at `${baseUrl}/global/event` until `signal`
 * aborts, reconnecting after 3s on connection errors.
 */
export async function streamServerEvents(
  baseUrl: string,
  signal: AbortSignal,
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const url = `${baseUrl}/global/event`

  while (!signal.aborted) {
    try {
      const response = await (globalThis as unknown as { fetch: typeof fetch }).fetch(url, {
        signal,
        headers: { 'Accept': 'text/event-stream' }
      })
      const reader = response.body?.getReader()
      if (!reader) return

      const decoder = new TextDecoder()
      let buffer = ''
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let nlIdx: number
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIdx).trim()
          buffer = buffer.slice(nlIdx + 1)
          if (!line.startsWith('data:')) continue
          const json = line.slice(line.startsWith('data: ') ? 6 : 5)
          if (!json) continue
          try {
            onEvent(JSON.parse(json) as Record<string, unknown>)
          } catch {
            // Not valid JSON — skip
          }
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) return
      if (err instanceof Error && err.name === 'AbortError') return
      console.warn('[OpencodeAdapter] SSE connection error, reconnecting in 3s:', err instanceof Error ? err.message : err)
      await sleep(3_000)
    }
  }
}
