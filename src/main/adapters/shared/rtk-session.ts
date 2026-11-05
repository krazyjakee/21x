import { execFile } from 'child_process'
import { accessSync, constants, statSync } from 'fs'
import { devNull, homedir } from 'os'
import { delimiter, dirname, isAbsolute, join } from 'path'
import { rtkCoverageFor } from '../../../shared/rtk'
import type { SessionConfig } from '../coding-agent-adapter'

/** Same limit as RTK's own hooks: a slow filter lookup must not stall a tool. */
const REWRITE_TIMEOUT_MS = 2_000
/** `rtk rewrite` exit codes that carry a command on stdout. Anything else means "leave it alone". */
const REWRITTEN_EXIT_CODES = new Set<unknown>([0, 3])
/**
 * A command that sets its own PATH. RTK would keep the assignment and put a bare
 * `rtk` after it (`PATH=/usr/bin rtk git status`), which that PATH cannot find.
 */
export const PATH_ASSIGNMENT = /(^|[\s;&|(])PATH\+?=/
const RTK_INVOCATION = /(^|[\s;&|(])rtk\s/

/**
 * True for what `rtk rewrite` produces: a command that runs rtk, and starts either
 * with rtk or as the original did. Text such as `Usage: rtk [OPTIONS]` from a
 * different program called rtk must not run as a command.
 */
export function isRtkRewrite(original: string, rewritten: string): boolean {
  const firstWord = (command: string) => command.trim().split(/\s+/)[0]
  return RTK_INVOCATION.test(rewritten) && ['rtk', firstWord(original)].includes(firstWord(rewritten))
}

/** `isRtkRewrite` as standalone source, for the code generated for OpenCode and Pi. */
export const IS_RTK_REWRITE_SOURCE = `function isRtkRewrite(original, rewritten) {
  var firstWord = function(command) { return command.trim().split(/\\s+/)[0]; };
  return ${String(RTK_INVOCATION)}.test(rewritten) && ["rtk", firstWord(original)].includes(firstWord(rewritten));
}`

/**
 * Stops RTK storing anything for a session, including from a global hook or an
 * `rtk` the agent types itself. RTK keeps command text in history.db and raw
 * output in recall.db or tee logs, and a user's own `RTK_HOOK_AUDIT=1` adds a log.
 *
 * The database path sits under the null device so that RTK can neither create it
 * nor touch its parent. Pointing at the device itself would make RTK, if running
 * as root, chmod /dev and /dev/null.
 */
const RTK_NO_STORAGE_ENV = {
  RTK_DISABLED: '1',
  RTK_DB_PATH: join(devNull, '21x-rtk.db'),
  RTK_RECALL: '0',
  RTK_TEE: '0',
  RTK_HOOK_AUDIT: '0'
}
/** RTK's own Pi extension honours this. Other global hooks ignore it. */
const RTK_OPT_OUT_ENV = { RTK_DISABLED: '1' }

const RTK_INSTRUCTIONS_PROMPT = `

## Shell output compression

RTK is installed on this machine and compresses command output. Prefix commands that read state or run tests and builds with \`rtk\`, for example \`rtk git status\` or \`rtk cargo test\`. Commands RTK has no filter for run unchanged. Never write \`rtk rtk\`. Leave the prefix off the left side of a pipe, because later commands need the raw output. If the output is unusable, run \`rtk proxy <command>\`.

Permission rules match the start of a command, so \`rtk\` can hide a command from them. Do not use it on commands that change anything outside the workspace, such as \`git push\`, and never use it to get around a command that was denied.
`

const RTK_REWRITE_PROMPT = `

## Shell output compression

Shell output may be compressed by RTK before you see it. If a result looks incomplete or unusable, run \`rtk proxy <command>\` to get the raw output.
`

const RTK_OFF_PROMPT = `

## Shell output compression

RTK is turned off for this session. Run shell commands directly, without an \`rtk\` prefix, even if other instructions ask for one.
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
    // A relative entry would resolve against whichever repository is open.
    if (!isAbsolute(directory)) continue
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
 * the command unchanged.
 *
 * This cannot enforce deny rules. RTK honours some Claude Code rules, but it does
 * not see managed settings, and it rewrites `timeout 5 git push` past a rule on
 * `git push`. So a caller must rewrite only after the backend's own permission
 * check, or after proving no deny rule exists. `cwd` is the session's directory,
 * where RTK reads those rules, as a second line of defence.
 */
export function rewriteWithRtk(executable: string, command: string, cwd: string): Promise<string> {
  if (!command.trim() || PATH_ASSIGNMENT.test(command)) return Promise.resolve(command)
  return new Promise(resolve => {
    try {
      execFile(executable, ['rewrite', '--', command], { cwd, timeout: REWRITE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        const exitCode = error ? error.code : 0
        const rewritten = stdout.replace(/\r?\n$/, '')
        resolve(REWRITTEN_EXIT_CODES.has(exitCode) && isRtkRewrite(command, rewritten) ? rewritten : command)
      })
    } catch {
      resolve(command)
    }
  })
}

/**
 * Environment additions for a process whose shell runs rewritten commands.
 * `rtk rewrite` emits a bare `rtk`, so RTK's directory has to be on PATH. It goes
 * last, and only when missing, so no other command resolves differently.
 */
export function rtkProcessEnv(
  config: Pick<SessionConfig, 'rtkEnv' | 'rtkExecutable'>,
  env: NodeJS.ProcessEnv
): Record<string, string> {
  const additions: Record<string, string> = { ...config.rtkEnv }
  if (config.rtkExecutable) {
    const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
    const directory = dirname(config.rtkExecutable)
    const entries = (env[key] ?? '').split(delimiter)
    if (!entries.includes(directory)) additions[key] = [...entries, directory].filter(Boolean).join(delimiter)
  }
  return additions
}

/**
 * Applies the RTK preference to a session.
 *
 * A session with secrets never uses RTK, whatever the preference says. The shell
 * expands `$TOKEN` before `rtk` starts, so RTK would see and store the value, and
 * no check of the command text can rule that out (`eval`, `${!name}`, or a value
 * the agent pasted). Any later session could then read it from RTK's files.
 */
export function applyRtkSessionPolicy(
  config: SessionConfig,
  codingAgent: string | null | undefined,
  enabled: boolean,
  executable: string | null,
  hasSecrets: boolean
): void {
  if (hasSecrets) {
    config.rtkEnv = RTK_NO_STORAGE_ENV
    if (executable) config.systemPrompt = (config.systemPrompt || '') + RTK_OFF_PROMPT
    return
  }
  if (!enabled) {
    config.rtkEnv = RTK_OPT_OUT_ENV
    config.systemPrompt = (config.systemPrompt || '') + RTK_OFF_PROMPT
    return
  }
  if (!executable) return
  if (rtkCoverageFor(codingAgent) === 'instructions') {
    config.systemPrompt = (config.systemPrompt || '') + RTK_INSTRUCTIONS_PROMPT
  } else {
    config.rtkExecutable = executable
    config.systemPrompt = (config.systemPrompt || '') + RTK_REWRITE_PROMPT
  }
}
