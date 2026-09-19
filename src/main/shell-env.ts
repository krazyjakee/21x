import { execFile } from 'child_process'
import { readdirSync } from 'fs'
import { join } from 'path'
import { getWindowsPathEntries, prependMissingWindowsPaths } from './windows-runtime-paths'

// macOS GUI apps (launched from /Applications) do NOT inherit the user's shell
// environment, so CLI tools like codex, claude, gh etc. cannot be found and
// auth env vars like CODEX_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY are
// missing. We read the values from a login shell and apply them to process.env.

// We need the interactive shell (`-i`) because tools like NVM, pnpm, bun,
// etc. add their paths in `.zshrc` / `.bashrc` (interactive config), NOT in
// `.zprofile` / `.bash_profile` (login-only config).
//
// Interactive mode also makes shell init scripts (oh-my-zsh, powerlevel10k,
// gitstatus, etc.) emit escape codes, error messages and prompt strings that
// corrupt the output, so every value is wrapped in unique markers.
const PATH_START = '__20X_PATH_START__'
const PATH_END = '__20X_PATH_END__'

// CODEX_HOME: if the user's terminal `codex` uses a custom CODEX_HOME (e.g. a
// work profile / a different ChatGPT account than ~/.codex), 20x must read the
// SAME one — otherwise Codex authenticates as whatever account lives in the
// default ~/.codex, which may be a free/over-limit account ("Upgrade to Plus")
// while the terminal subscription works fine.
const INHERITED_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_HOME'] as const

const startMarker = (name: string): string => `__20X_${name}_START__`
const endMarker = (name: string): string => `__20X_${name}_END__`

function extractMarkedValue(stdout: string, start: string, end: string): string | undefined {
  const match = stdout.match(new RegExp(`${start}([\\s\\S]*?)${end}`))
  return match?.[1] || undefined
}

/** Brings PATH (and a few auth variables on macOS) in line with the user's shell. Never rejects. */
export function loadPlatformShellEnv(): Promise<void> {
  if (process.platform === 'win32') {
    // GUI apps can miss PATH updates from installers. Rehydrate the usual
    // runtime locations, including the python.org user install path used by
    // the NSIS bootstrap.
    process.env.PATH = prependMissingWindowsPaths(process.env.PATH || '', getWindowsPathEntries(process.env))
    return Promise.resolve()
  }
  if (process.platform !== 'darwin') return Promise.resolve()

  const command = [
    `printf '%s%s%s\\n' "${PATH_START}" "$PATH" "${PATH_END}"`,
    ...INHERITED_VARS.map((name) => `printf '%s%s%s\\n' "${startMarker(name)}" "$${name}" "${endMarker(name)}"`)
  ].join('; ')

  return new Promise((resolve) => {
    const userShell = process.env.SHELL || '/bin/zsh'
    execFile(userShell, ['-ilc', command], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      if (err || !stdout) {
        console.error('[Main] Failed to read shell PATH, using fallback:', err?.message)
        process.env.PATH = buildFallbackPath()
        resolve()
        return
      }

      const pathFromShell = extractMarkedValue(stdout, PATH_START, PATH_END)
      if (pathFromShell) {
        console.log('[Main] Setting PATH from shell:', userShell)
        process.env.PATH = pathFromShell
      } else {
        console.error('[Main] Failed to read shell PATH, using fallback')
        process.env.PATH = buildFallbackPath()
      }

      for (const name of INHERITED_VARS) {
        const value = extractMarkedValue(stdout, startMarker(name), endMarker(name))
        if (!value) continue
        process.env[name] = value
        if (name === 'CODEX_HOME') console.log('[Main] Inherited CODEX_HOME from shell:', value)
      }
      resolve()
    })
  })
}

/**
 * Fallback PATH for when the shell invocation fails: Homebrew, system bins,
 * npm/pnpm/volta globals and the newest NVM node.
 */
function buildFallbackPath(): string {
  const home = process.env.HOME || ''
  const commonPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/Library/pnpm`,
    `${home}/.volta/bin`,
  ]

  // Detect the NVM version rather than hardcoding one.
  if (home) {
    try {
      const nvmVersionsDir = join(home, '.nvm', 'versions', 'node')
      const versions = readdirSync(nvmVersionsDir)
      if (versions.length > 0) {
        versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        commonPaths.push(join(nvmVersionsDir, versions[0], 'bin'))
      }
    } catch {
      // NVM not installed.
    }
  }

  return [...new Set([...commonPaths, ...(process.env.PATH || '').split(':')])]
    .filter(Boolean)
    .join(':')
}
