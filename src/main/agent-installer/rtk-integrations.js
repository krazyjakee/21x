import { existsSync, readFileSync } from 'fs'
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
  try {
    return existsSync(path) && readFileSync(path, 'utf8').includes(text)
  } catch {
    return false
  }
}

/** Inspect the global files written by RTK's own setup commands. */
export function detectRtkIntegrations(env = process.env, home = homedir()) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const codexDir = env.CODEX_HOME || join(home, '.codex')
  const piDir = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')

  return {
    claudeCode: fileContains(join(claudeDir, 'settings.json'), 'rtk hook claude'),
    opencode: fileContains(join(home, '.config', 'opencode', 'plugins', 'rtk.ts'), 'rtk'),
    codex: fileContains(join(codexDir, 'hooks.json'), 'rtk hook codex'),
    cursor: fileContains(join(home, '.cursor', 'hooks.json'), 'rtk hook cursor'),
    pi: fileContains(join(piDir, 'extensions', 'rtk.ts'), 'rtk')
  }
}
