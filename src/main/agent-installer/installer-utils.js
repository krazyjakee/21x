import { spawn } from 'child_process'
import { createWriteStream, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectInstalledAgents } from './detect.js'

/** @typedef {(progress: { stage: string, output: string, percent: number }) => void} OnProgress */

/**
 * Prepend a directory to this process's PATH so child processes spawned later
 * in the same session can find binaries placed there.
 * Returns true if PATH was modified.
 */
export function ensureOnPath(dir) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const pathEnv = process.env.PATH || ''
  const segments = pathEnv.split(sep)
  if (segments.includes(dir) || segments.includes(`${dir}/`)) return false
  process.env.PATH = `${dir}${sep}${pathEnv}`
  return true
}

export function installerDir() {
  const dir = join(tmpdir(), '20x-installers')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function removeQuietly(...paths) {
  for (const path of paths) {
    if (!path) continue
    try { rmSync(path, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Depth-first search for a file called `name` under `dir`. */
export function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, name)
      if (found) return found
    } else if (entry.name === name) {
      return full
    }
  }
  return null
}

/** GET a JSON document; resolves null on any failure so callers can fall back. */
export async function fetchJson(url, headers) {
  try {
    const { net } = await import('electron')
    const resp = await net.fetch(url, { signal: AbortSignal.timeout(8000), headers })
    return resp.ok ? await resp.json() : null
  } catch {
    return null
  }
}

/**
 * Download a file, following redirects. Uses Electron's net module so system
 * proxy settings apply.
 * @param {string} url
 * @param {string} destPath
 * @param {OnProgress} onProgress
 * @returns {Promise<void>}
 */
export async function downloadFile(url, destPath, onProgress) {
  const { net } = await import('electron')

  return new Promise((resolve, reject) => {
    const request = net.request(url)

    request.on('response', (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location
        onProgress({ stage: 'installing', output: `Redirecting...\n`, percent: 10 })
        downloadFile(redirectUrl, destPath, onProgress).then(resolve).catch(reject)
        return
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`))
        return
      }

      const contentLength = parseInt(response.headers['content-length']?.[0] || response.headers['content-length'] || '0', 10)
      let downloaded = 0
      const file = createWriteStream(destPath)

      response.on('data', (chunk) => {
        file.write(chunk)
        downloaded += chunk.length
        if (contentLength > 0) {
          const pct = Math.round((downloaded / contentLength) * 60) + 10
          onProgress({ stage: 'installing', output: `Downloaded ${(downloaded / 1024 / 1024).toFixed(1)} MB\r`, percent: Math.min(pct, 70) })
        }
      })

      response.on('end', () => {
        file.end()
        file.on('finish', () => resolve())
      })

      response.on('error', (err) => {
        file.destroy()
        reject(err)
      })
    })

    request.on('error', (err) => reject(err))
    request.end()
  })
}

/**
 * Spawn a process, forwarding its stdout/stderr as 'installing' progress at a
 * fixed percent. Never rejects: resolves with the spawn error (if any), exit
 * code and captured output.
 * @param {string} cmd
 * @param {string[]} args
 * @param {OnProgress} onProgress
 * @param {number} percent
 * @param {import('child_process').SpawnOptions} [options]
 * @returns {Promise<{ error: Error | null, code: number | null, stdout: string, stderr: string }>}
 */
export function streamProcess(cmd, args, onProgress, percent, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      onProgress({ stage: 'installing', output: text, percent })
    })
    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      onProgress({ stage: 'installing', output: text, percent })
    })
    proc.on('error', (error) => resolve({ error, code: null, stdout, stderr }))
    proc.on('close', (code) => resolve({ error: null, code, stdout, stderr }))
  })
}

/** Run a helper command (tar, unzip) silently; throws on failure. */
export async function runQuiet(cmd, args) {
  const { error, code, stderr } = await streamProcess(cmd, args, () => {}, 0)
  if (error) throw error
  if (code !== 0) throw new Error(`${cmd} exited with ${code}: ${stderr.trim()}`)
}

/**
 * Emit a final 'error' progress event (skipped when onProgress is omitted) and
 * return a failed install result.
 */
export async function fail(error, onProgress, output = `Error: ${error}\n`) {
  onProgress?.({ stage: 'error', output, percent: 100 })
  return { success: false, error, newStatus: await detectInstalledAgents() }
}

/** Turn an installer's { success, error } into the final progress event and install result. */
export async function finish(onProgress, { success, error }, successOutput, errorOutput = `Installation failed: ${error}\n`) {
  onProgress(success
    ? { stage: 'complete', output: successOutput, percent: 100 }
    : { stage: 'error', output: errorOutput, percent: 100 })
  return { success, error, newStatus: await detectInstalledAgents() }
}

/**
 * Spawn an install command and stream its output.
 * @param {string} cmd
 * @param {string[]} args
 * @param {OnProgress} onProgress
 */
export async function spawnInstall(cmd, args, onProgress) {
  onProgress({ stage: 'starting', output: `$ ${cmd} ${args.join(' ')}\n`, percent: 0 })
  const { error, code } = await streamProcess(cmd, args, onProgress, 50, { shell: process.platform === 'win32' })
  if (error) return fail(error.message, onProgress)
  return finish(
    onProgress,
    { success: code === 0, error: code === 0 ? null : `Install failed with exit code ${code}` },
    'Installation complete.\n',
    `Process exited with code ${code}\n`
  )
}

/**
 * Run a Windows installer (MSI/EXE) elevated via UAC.
 * @returns {Promise<{ success: boolean, error: string | null }>}
 */
export async function runInstaller(installerPath, args, onProgress) {
  onProgress({ stage: 'installing', output: `Running installer...\n`, percent: 75 })

  // Keep the process in a variable and call WaitForExit() explicitly: piping
  // -PassThru to Select-Object under UAC elevation fails with "Process must
  // exit before requested information".
  const psArgs = [
    '-NoProfile', '-Command',
    `$p = Start-Process -FilePath '${installerPath}' -ArgumentList @(${args.map(a => `'${a}'`).join(',')}) -Verb RunAs -PassThru; $p.WaitForExit(); exit $p.ExitCode`
  ]
  const { error, code } = await streamProcess('powershell.exe', psArgs, onProgress, 85, { windowsHide: false })
  if (error) return { success: false, error: error.message }
  if (code === 0 || code === 3010) return { success: true, error: null } // 3010 = success, reboot required
  return { success: false, error: `Installer exited with code ${code}` }
}

/**
 * Run a macOS .pkg installer via osascript, which shows the native admin
 * password prompt.
 * @returns {Promise<{ success: boolean, error: string | null }>}
 */
export async function runMacPkgInstaller(pkgPath, onProgress) {
  onProgress({ stage: 'installing', output: `Running pkg installer (you may see an admin prompt)...\n`, percent: 75 })

  const safePath = pkgPath.replace(/"/g, '\\"')
  const script = `do shell script "installer -pkg \\"${safePath}\\" -target /" with administrator privileges`
  const { error, code, stdout, stderr } = await streamProcess('osascript', ['-e', script], onProgress, 85)
  if (error) return { success: false, error: error.message }
  if (code === 0) return { success: true, error: null }
  return {
    success: false,
    error: stderr.includes('User canceled')
      ? 'Installation cancelled by user'
      : `Installer exited with code ${code}: ${stderr.trim() || stdout.trim()}`
  }
}
