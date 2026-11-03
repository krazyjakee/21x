import { homedir, tmpdir } from 'os'
import { isAbsolute, relative, resolve } from 'path'

/**
 * The one safety check every agent backend shares.
 *
 * Agents run with full access and no approval prompts. The only requests that
 * still reach the user are the rare ones that could do lasting damage outside
 * the task: deleting files outside the workspace, writing into system
 * directories, wiping disks, powering the machine off. Everything else is
 * approved without asking.
 *
 * This is a guard against mistakes, not a sandbox: it reads the commands and
 * paths an agent declares before a tool runs.
 */

export interface ToolRequest {
  /** The backend's tool name, e.g. `Bash`, `Write`, `bash`, `edit`. */
  toolName?: string
  /** The tool's input as the backend reports it. */
  input?: unknown
  /** Shell commands stated outright (OpenCode patterns, a Pi confirm message). */
  commands?: string[]
  /** Paths the request writes or deletes, stated outright. */
  paths?: string[]
  /** The task's workspace; anything inside it is the agent's to change. */
  workspaceDir?: string
}

/** Directories whose contents belong to the operating system. */
const SYSTEM_DIRS = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/root', '/sbin', '/snap', '/sys', '/usr', '/var']
/** Scratch locations that are always fair game. */
const SCRATCH_DIRS = ['/tmp', '/var/tmp', '/dev/null', tmpdir()]

const DELETE_VERBS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'wipe', 'trash', 'trash-put', 'gio'])
const DISK_VERBS = new Set(['mkfs', 'wipefs', 'fdisk', 'sfdisk', 'gdisk', 'parted', 'mkswap', 'blkdiscard'])
const POWER_VERBS = new Set(['shutdown', 'reboot', 'poweroff', 'halt'])
const OWNER_VERBS = new Set(['chmod', 'chown', 'chgrp'])

const COMMAND_KEYS = new Set(['command', 'cmd', 'script', 'commands'])
const PATH_KEYS = new Set(['file_path', 'filePath', 'path', 'paths', 'notebook_path', 'target', 'destination'])
const WRITE_TOOL = /^(write|edit|multiedit|notebookedit|str_replace\w*|apply_patch|patch|create|delete|remove|move|rename)/i
const DELETE_TOOL = /^(delete|remove)/i

/**
 * Why this request needs the user, or null when it should just run.
 */
export function dangerousToolReason(request: ToolRequest): string | null {
  const workspace = request.workspaceDir ? resolve(request.workspaceDir) : undefined
  const commands = [...(request.commands ?? [])]
  const paths = [...(request.paths ?? [])]
  collect(request.input, commands, paths, 0)

  for (const command of commands) {
    const reason = dangerousCommandReason(command, workspace)
    if (reason) return reason
  }

  const tool = request.toolName ?? ''
  if (WRITE_TOOL.test(tool)) {
    for (const path of paths) {
      const target = expand(path, workspace)
      if (!target) continue
      if (DELETE_TOOL.test(tool) && outsideWorkspace(target, workspace)) return `deletes ${path}, outside the task workspace`
      if (isSystemPath(target)) return `changes the system path ${path}`
    }
  }
  return null
}

/** Pulls command and path strings out of a tool input, a few levels deep. */
function collect(value: unknown, commands: string[], paths: string[], depth: number): void {
  if (depth > 3 || value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (COMMAND_KEYS.has(key)) {
      if (typeof entry === 'string') commands.push(entry)
      else if (Array.isArray(entry)) commands.push(entry.filter((part) => typeof part === 'string').join(' '))
    } else if (PATH_KEYS.has(key)) {
      if (typeof entry === 'string') paths.push(entry)
      else if (Array.isArray(entry)) paths.push(...entry.filter((part): part is string => typeof part === 'string'))
    } else if (typeof entry === 'object') {
      collect(entry, commands, paths, depth + 1)
    }
  }
}

function dangerousCommandReason(command: string, workspace: string | undefined): string | null {
  if (/--no-preserve-root/.test(command)) return 'deletes from the filesystem root'
  if (/(^|[^<])>\s*\/dev\/(sd|nvme|hd|vd|xvd|mmcblk|disk)/.test(command)) return 'writes directly to a disk device'

  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).map(unquote).filter(Boolean)
    for (let i = 0; i < words.length; i++) {
      const verb = words[i].replace(/^.*\//, '')
      const rest = words.slice(i + 1)
      const targets = rest.filter((word) => !word.startsWith('-'))

      if (DISK_VERBS.has(verb) || verb.startsWith('mkfs.')) return `runs ${verb}, which can erase a disk`
      if (POWER_VERBS.has(verb)) return `runs ${verb} on this machine`
      if (verb === 'dd' && rest.some((word) => /^of=\/dev\/(sd|nvme|hd|vd|xvd|mmcblk|disk)/.test(word))) return 'writes directly to a disk device'

      if (DELETE_VERBS.has(verb)) {
        if (verb === 'gio' && rest[0] !== 'trash' && rest[0] !== 'remove') continue
        for (const target of targets) {
          const reason = deletionReason(target, workspace)
          if (reason) return reason
        }
      }
      if (verb === 'find' && rest.some((word) => word === '-delete' || word === 'rm')) {
        const root = targets[0]
        if (root) {
          const reason = deletionReason(root, workspace)
          if (reason) return reason
        }
      }
      if (OWNER_VERBS.has(verb) && rest.some((word) => /^-\w*R/.test(word) || word === '--recursive')) {
        for (const target of targets) {
          const path = expand(target, workspace)
          if (path && (path === '/' || isSystemPath(path) || path === homedir())) return `recursively changes ownership or permissions of ${target}`
        }
      }
      if (verb === 'mv' && targets.length > 0) {
        const source = expand(targets[0], workspace)
        if (source && isSystemPath(source)) return `moves the system path ${targets[0]}`
      }
    }
  }
  return null
}

function deletionReason(target: string, workspace: string | undefined): string | null {
  const path = expand(target, workspace)
  if (!path) return null
  if (path === '/' || path === '/*') return 'deletes from the filesystem root'
  if (path === homedir() || path === `${homedir()}/*`) return 'deletes the home directory'
  if (isSystemPath(path)) return `deletes the system path ${target}`
  if (outsideWorkspace(path, workspace)) return `deletes ${target}, outside the task workspace`
  return null
}

/** The absolute path a target names; relative paths resolve in the workspace. */
function expand(target: string, workspace?: string): string | null {
  const cleaned = target.replace(/[?!,)]+$/, '')
  if (!cleaned || cleaned.includes('$(') || cleaned.includes('`')) return null
  if (/^(~|\$HOME|\$\{HOME\})(\/|$)/.test(cleaned)) return resolve(homedir(), cleaned.replace(/^(~|\$HOME|\$\{HOME\})\/?/, ''))
  if (isAbsolute(cleaned)) return resolve(cleaned)
  return resolve(workspace ?? process.cwd(), cleaned)
}

function isSystemPath(path: string): boolean {
  if (SCRATCH_DIRS.some((dir) => within(path, dir))) return false
  return path === '/' || SYSTEM_DIRS.some((dir) => within(path, dir))
}

function outsideWorkspace(path: string, workspace: string | undefined): boolean {
  if (SCRATCH_DIRS.some((dir) => within(path, dir))) return false
  // Without a workspace only system paths can be judged.
  return !!workspace && !within(path, workspace)
}

function within(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function unquote(word: string): string {
  return word.replace(/^['"]|['"]$/g, '')
}
