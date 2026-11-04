import { execFile } from 'child_process'
import { accessSync, constants, statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { rtkCoverageFor } from '../../../shared/rtk'
import type { SessionConfig } from '../coding-agent-adapter'

/** Same limit as RTK's own hooks: a slow filter lookup must not stall a tool. */
const REWRITE_TIMEOUT_MS = 2_000
/** `rtk rewrite` exit codes that carry a command on stdout. Anything else means "leave it alone". */
const REWRITTEN_EXIT_CODES = new Set<unknown>([0, 3])

const RTK_INSTRUCTIONS_PROMPT = `

## Shell output compression

RTK is installed on this machine and compresses command output. Prefix shell commands with \`rtk\`, for example \`rtk git status\` or \`rtk cargo test\`, and keep the prefix inside chains: \`rtk git add . && rtk git commit -m "msg"\`. Commands RTK has no filter for run unchanged. Never write \`rtk rtk\`. Leave the prefix off the left side of a pipe, because later commands need the raw output. If the output is unusable, run \`rtk proxy <command>\`.
`

const RTK_OFF_PROMPT = `

## Shell output compression

RTK is turned off in 21x. Run shell commands directly, without an \`rtk\` prefix, even if other instructions ask for one.
`

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Locates RTK synchronously, because the session config is assembled synchronously. */
export function findRtkExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string | null {
  const name = platform === 'win32' ? 'rtk.exe' : 'rtk'
  const searchPath = env.PATH ?? env.Path ?? ''
  // The installer's target, which a desktop launch can leave out of PATH.
  const directories = [...searchPath.split(delimiter), join(home, '.local', 'bin')]
  for (const directory of directories) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (isExecutableFile(candidate, platform)) return candidate
  }
  return null
}

/**
 * Asks RTK for its version of a command. `rtk rewrite` is the only authority on
 * what can be filtered: it leaves unfiltered commands and commands that are
 * already wrapped alone, and declines shapes that need raw output, such as the
 * left side of `| wc -l`. Any failure, including a missing or old RTK, returns
 * the command unchanged so that RTK can never stop a command from running.
 */
export function rewriteWithRtk(executable: string, command: string): Promise<string> {
  if (!command.trim()) return Promise.resolve(command)
  return new Promise(resolve => {
    try {
      execFile(executable, ['rewrite', '--', command], { timeout: REWRITE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        const exitCode = error ? error.code : 0
        const rewritten = stdout.replace(/\r?\n$/, '')
        resolve(REWRITTEN_EXIT_CODES.has(exitCode) && rewritten ? rewritten : command)
      })
    } catch {
      resolve(command)
    }
  })
}

/** Applies the RTK preference to a session on a machine that has RTK. */
export function applyRtkSessionPolicy(
  config: SessionConfig,
  codingAgent: string | null | undefined,
  enabled: boolean,
  executable: string
): void {
  if (!enabled) {
    config.rtkDisabled = true
    config.systemPrompt = (config.systemPrompt || '') + RTK_OFF_PROMPT
    return
  }
  if (rtkCoverageFor(codingAgent) === 'instructions') {
    config.systemPrompt = (config.systemPrompt || '') + RTK_INSTRUCTIONS_PROMPT
  } else {
    config.rtkExecutable = executable
  }
}
