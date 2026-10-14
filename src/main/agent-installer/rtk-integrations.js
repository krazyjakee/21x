import { constants, openSync, fstatSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** RTK integrations supported by the coding-agent backends in 21x. */
export const RTK_INTEGRATIONS = {
  claudeCode: {
    label: 'Claude Code',
    args: ['init', '--global', '--auto-patch', '--no-trust-filters']
  },
  opencode: {
    label: 'OpenCode',
    args: ['init', '--global', '--opencode', '--auto-patch', '--no-trust-filters']
  },
  codex: {
    label: 'Codex',
    // RTK rejects patch-mode flags for Codex. This mode is non-interactive.
    args: ['init', '--global', '--codex']
  },
  cursor: {
    label: 'Cursor',
    args: ['init', '--global', '--agent', 'cursor', '--auto-patch', '--no-trust-filters']
  },
  pi: {
    label: 'Pi',
    args: ['init', '--global', '--agent', 'pi', '--auto-patch']
  }
}

/** Return setup commands only for coding agents that are currently installed. */
export function getRtkInitPlans(status) {
  return Object.entries(RTK_INTEGRATIONS)
    .filter(([key]) => status?.[key]?.installed && status[key]?.supported !== false)
    .map(([key, value]) => ({ key, ...value }))
}

function fileContains(path, text) {
  let descriptor
  let bytes
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0))
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > 262144) return false
    bytes = Buffer.alloc(stat.size + 1)
    const read = readSync(descriptor, bytes, 0, bytes.length, 0)
    return read <= stat.size && bytes.subarray(0, read).toString('utf8').includes(text)
  } catch {
    return false
  } finally { bytes?.fill(0); if (descriptor !== undefined) closeSync(descriptor) }
}

/** Inspect the global files written by RTK's own setup commands. */
export function rtkIntegrationFiles(env = process.env, home = homedir()) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const codexDir = env.CODEX_HOME || join(home, '.codex')
  const piDir = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')

  return [
    { key: 'claudeCode', path: join(claudeDir, 'settings.json'), text: 'rtk hook claude' },
    { key: 'opencode', path: join(home, '.config', 'opencode', 'plugins', 'rtk.ts'), text: 'rtk' },
    { key: 'codex', path: join(codexDir, 'hooks.json'), text: 'rtk hook codex' },
    { key: 'cursor', path: join(home, '.cursor', 'hooks.json'), text: 'rtk hook cursor' },
    { key: 'pi', path: join(piDir, 'extensions', 'rtk.ts'), text: 'rtk' }
  ]
}

export function detectRtkIntegrations(env = process.env, home = homedir()) {
  return Object.fromEntries(rtkIntegrationFiles(env, home).map(file => [file.key, fileContains(file.path, file.text)]))
}
