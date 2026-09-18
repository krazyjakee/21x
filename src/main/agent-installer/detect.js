import { execFile } from 'child_process'
import { promisify } from 'util'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'

const execFileAsync = promisify(execFile)
export const MINIMUM_PI_VERSION = '0.80.5'

/** Detection keys for every supported coding-agent backend. */
export const AGENT_BACKEND_KEYS = ['claudeCode', 'opencode', 'codex', 'cursor', 'pi']

/** A backend is usable when it is installed and not flagged as unsupported. */
export function isBackendReady(status) {
  return Boolean(status && status.installed && status.supported !== false)
}

/**
 * Backend keys that are installed and usable, in `AGENT_BACKEND_KEYS` order.
 * Every detected backend is available — there is no single-selection gate.
 * @param {Record<string, { installed: boolean, supported?: boolean }>} status
 * @returns {string[]}
 */
export function getInstalledBackends(status) {
  return AGENT_BACKEND_KEYS.filter((key) => isBackendReady(status?.[key]))
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function ensurePathDirectory(dir) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const segments = (process.env.PATH || '').split(sep)
  if (!dir || segments.includes(dir) || segments.includes(`${dir}/`)) return false
  process.env.PATH = `${dir}${sep}${process.env.PATH || ''}`
  return true
}

/** Return common locations used by global npm and Node version managers. */
export async function getPiCommandCandidates(exec = execFileAsync) {
  const home = homedir()
  const candidates = process.platform === 'win32'
    ? [
        'pi.cmd',
        'pi.exe',
        join(home, 'AppData', 'Roaming', 'npm', 'pi.cmd'),
        join(home, 'AppData', 'Roaming', 'npm', 'pi.exe')
      ]
    : [
        'pi',
        '/opt/homebrew/bin/pi',
        '/usr/local/bin/pi',
        join(home, '.local', 'bin', 'pi'),
        join(home, '.npm-global', 'bin', 'pi'),
        join(home, '.volta', 'bin', 'pi')
      ]

  try {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const { stdout } = await exec(npmCommand, ['prefix', '-g'], {
      timeout: 5000,
      shell: process.platform === 'win32',
      windowsHide: true
    })
    const prefix = stdout.trim()
    if (prefix) {
      candidates.push(process.platform === 'win32'
        ? join(prefix, 'pi.cmd')
        : join(prefix, 'bin', 'pi'))
    }
  } catch {
    // npm is optional during detection.
  }

  return unique(candidates)
}

export function isVersionAtLeast(version, minimum) {
  const current = String(version || '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const required = String(minimum || '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(current.length, required.length)
  for (let index = 0; index < length; index++) {
    if ((current[index] || 0) > (required[index] || 0)) return true
    if ((current[index] || 0) < (required[index] || 0)) return false
  }
  return true
}

/**
 * Ensure well-known agent install directories are on the running process's
 * PATH so detection works immediately after install without an app restart.
 */
function ensureAgentPaths() {
  const home = homedir()

  const knownDirs = [
    join(home, '.opencode', 'bin'),  // OpenCode standalone installer
    join(home, '.local', 'bin')       // Linux binary installs
  ]

  let modified = false
  for (const dir of knownDirs) {
    if (existsSync(dir) && ensurePathDirectory(dir)) modified = true
  }
  return modified
}

/**
 * Detect which agents and tools are installed on this system.
 *
 * Every supported backend (`AGENT_BACKEND_KEYS`) is probed on each call, so
 * re-running detection reflects backends installed or removed since the last
 * run. The result is a snapshot — nothing is cached between calls.
 *
 * @param {{ exec?: typeof execFileAsync }} [options] - `exec` overrides the
 *   command runner (used by tests to simulate installs and removals).
 * @returns {Promise<Record<string, { installed: boolean, version: string | null }>>}
 */
export async function detectInstalledAgents(options = {}) {
  const isWin = process.platform === 'win32'
  const exec = options.exec || execFileAsync

  // Ensure well-known install dirs are on PATH before probing
  ensureAgentPaths()

  /**
   * Run a command and extract a version string from stdout.
   * On Windows, shell: true is required to resolve .cmd/.bat wrappers.
   * @param {string} cmd
   * @param {string[]} args
   * @returns {Promise<{ installed: boolean, version: string | null }>}
   */
  async function probe(cmd, args) {
    try {
      const { stdout, stderr } = await exec(cmd, args, {
        timeout: 10000,
        shell: isWin,
        windowsHide: true
      })
      const raw = `${stdout}\n${stderr}`.trim()
      // Extract version-like string (e.g. "v22.1.0", "2.44.0", "1.0.3")
      const match = raw.match(/(\d+\.\d+[\w.\-]*)/)
      return { installed: true, version: match ? match[1] : raw.split('\n')[0] }
    } catch {
      return { installed: false, version: null }
    }
  }

  async function probePi() {
    for (const command of await getPiCommandCandidates(exec)) {
      const status = await probe(command, ['--version'])
      if (!status.installed) continue
      if (existsSync(command)) ensurePathDirectory(dirname(command))
      const supported = status.version
        ? isVersionAtLeast(status.version, MINIMUM_PI_VERSION)
        : false
      return {
        ...status,
        supported,
        reason: supported
          ? null
          : status.version
            ? `Pi ${status.version} is unsupported. Update to ${MINIMUM_PI_VERSION} or newer.`
            : `Could not determine the Pi version. Pi ${MINIMUM_PI_VERSION} or newer is required.`
      }
    }
    return { installed: false, version: null, supported: false, reason: 'Pi CLI is not installed.' }
  }

  // Run all probes in parallel — shell:true on Windows resolves .cmd automatically
  const [nodejs, npm, pnpm, git, gh, glab, tea, claudeCode, opencode, codex, cursor, pi] = await Promise.all([
    probe('node', ['--version']),
    probe('npm', ['--version']),
    probe('pnpm', ['--version']),
    probe('git', ['--version']),
    probe('gh', ['--version']),
    probe('glab', ['--version']),
    probe('tea', ['--version']),
    probe('claude', ['--version']),
    probe('opencode', ['--version']),
    probe('codex', ['--version']),
    probe('cursor-agent', ['--version']),
    probePi()
  ])

  return { nodejs, npm, pnpm, git, gh, glab, tea, claudeCode, opencode, codex, cursor, pi }
}
