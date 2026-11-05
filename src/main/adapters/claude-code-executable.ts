import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { execFileAsync, findExecutable } from '../find-executable'
import { isVersionAtLeast } from '../agent-installer/detect.js'

/** Older CLIs ignore CLAUDE_ENV_FILE: 2.0.20 ran commands with empty variables, 2.0.60 did not. */
export const MINIMUM_CLAUDE_VERSION_FOR_SECRETS = '2.0.60'

/** Resolved once per process; shared across adapter instances. */
let resolvedClaudeExecutablePath: string | null = null

/**
 * On Windows the SDK spawns the executable without a shell, so a claude.cmd
 * wrapper fails with EINVAL. Resolve it to the underlying cli.js so the SDK
 * runs `node cli.js` instead. Falls back to the .cmd path.
 */
function resolveWindowsCmdToJs(cmdPath: string): string {
  try {
    // Known npm global layout: <cmd dir>/node_modules/@anthropic-ai/claude-code/cli.js
    const cmdDir = dirname(cmdPath)
    const cliJs = join(cmdDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    if (existsSync(cliJs)) {
      console.log(`[ClaudeCodeAdapter] Resolved .cmd → ${cliJs}`)
      return cliJs
    }

    const content = readFileSync(cmdPath, 'utf8')
    const match = content.match(/"[^"]*node(?:\.exe)?"[^"]*"([^"]+\.js)"/)
      || content.match(/node(?:\.exe)?\s+"([^"]+\.js)"/)
      || content.match(/node(?:\.exe)?\s+([^\s]+\.js)/)
    if (match?.[1]) {
      const resolvedJs = match[1].replace(/%dp0%/g, cmdDir + '\\')
      if (existsSync(resolvedJs)) {
        console.log(`[ClaudeCodeAdapter] Parsed .cmd → ${resolvedJs}`)
        return resolvedJs
      }
    }
  } catch (err) {
    console.warn(`[ClaudeCodeAdapter] Failed to resolve .cmd to .js:`, err)
  }
  return cmdPath
}

/**
 * Well-known install locations: Homebrew, npm/pnpm globals, Volta and NVM, so
 * the binary is found even when a packaged macOS GUI app starts with a
 * minimal PATH.
 */
function claudeFallbackPaths(isWin: boolean): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (isWin) {
    return [
      `${home}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js`,
      `${home}\\AppData\\Roaming\\npm\\claude.cmd`,
      `${home}\\AppData\\Roaming\\npm\\claude.exe`,
      `${home}\\.local\\bin\\claude.cmd`,
      `${home}\\.local\\bin\\claude.exe`
    ]
  }

  const paths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${home}/.local/bin/claude`,
    `${home}/.npm-global/bin/claude`,
    `${home}/Library/pnpm/claude`,
    `${home}/.volta/bin/claude`,
  ]
  if (home) {
    try {
      const nvmDir = join(home, '.nvm', 'versions', 'node')
      const versions = readdirSync(nvmDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const version of versions) {
        paths.push(join(nvmDir, version, 'bin', 'claude'))
      }
    } catch {
      // NVM not installed
    }
  }
  return paths
}

export async function findClaudeExecutable(): Promise<string> {
  if (resolvedClaudeExecutablePath) return resolvedClaudeExecutablePath

  const isWin = process.platform === 'win32'
  const found = await findExecutable('claude', claudeFallbackPaths(isWin))
  if (!found) {
    throw new Error('Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code')
  }

  // `where` may return an extensionless npm shim or a .cmd wrapper; neither can
  // be spawned directly.
  resolvedClaudeExecutablePath = isWin && !/\.(js|exe)$/i.test(found) ? resolveWindowsCmdToJs(found) : found
  console.log(`[ClaudeCodeAdapter] Found claude executable at: ${resolvedClaudeExecutablePath}`)
  return resolvedClaudeExecutablePath
}

/** Null when it cannot be read, as with a cli.js that is not directly executable. */
async function readClaudeVersion(executable: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 10_000, windowsHide: true })
    return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null
  } catch {
    return null
  }
}

/** False only when a shell ran and did not find them. Null when no shell could run. */
async function hasSecretTools(): Promise<boolean | null> {
  try {
    await execFileAsync('sh', ['-c', 'command -v curl && command -v base64'], { timeout: 10_000, windowsHide: true })
    return true
  } catch (error) {
    return typeof (error as { code?: unknown }).code === 'number' ? false : null
  }
}

/** Refuses to start a session whose secrets would silently come through empty. */
export async function assertClaudeSupportsSecrets(executable: string): Promise<void> {
  const tools = await hasSecretTools()
  if (tools === false) throw new Error('This agent has secrets, which need curl and base64 on PATH. Install them and try again.')
  if (tools === null) console.warn('[ClaudeCodeAdapter] Could not check for curl and base64, which secrets need.')
  const version = await readClaudeVersion(executable)
  if (version === null) {
    console.warn(`[ClaudeCodeAdapter] Could not read the Claude Code version. Secrets need ${MINIMUM_CLAUDE_VERSION_FOR_SECRETS} or newer.`)
  } else if (!isVersionAtLeast(version, MINIMUM_CLAUDE_VERSION_FOR_SECRETS)) {
    throw new Error(`This agent has secrets, which need Claude Code ${MINIMUM_CLAUDE_VERSION_FOR_SECRETS} or newer. Found ${version}. Update Claude Code.`)
  }
}
