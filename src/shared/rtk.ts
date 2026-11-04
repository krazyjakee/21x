/**
 * RTK preference and coverage rules, shared by the session config, Settings and
 * the setup dialog so they cannot disagree. See docs/rtk.md.
 */

/** Unset means on: only an explicit opt-out is ever stored as 'false'. */
export const RTK_ENABLED_SETTING = 'rtk_enabled' as const

export function isRtkEnabled(value: string | null | undefined): boolean {
  return value !== 'false'
}

/**
 * What 21x can do for a backend's sessions:
 * - `rewrite`: every shell command goes through `rtk rewrite` before it runs.
 * - `instructions`: 21x has no way to change the command, so the agent is told
 *   to use RTK. The agent may not follow that, so it is not enforcement.
 */
export type RtkCoverage = 'rewrite' | 'instructions'

export const RTK_BACKENDS = [
  { key: 'claudeCode', codingAgent: 'claude-code', label: 'Claude Code', coverage: 'rewrite' },
  { key: 'opencode', codingAgent: 'opencode', label: 'OpenCode', coverage: 'rewrite' },
  { key: 'pi', codingAgent: 'pi', label: 'Pi', coverage: 'rewrite' },
  { key: 'codex', codingAgent: 'codex', label: 'Codex', coverage: 'instructions' },
  { key: 'cursor', codingAgent: 'cursor', label: 'Cursor', coverage: 'instructions' }
] as const satisfies ReadonlyArray<{ key: string; codingAgent: string; label: string; coverage: RtkCoverage }>

/**
 * Global RTK hooks that 21x cannot turn off for a single session: they run
 * inside the backend and ignore RTK_DISABLED. Pi's extension honours it, and a
 * Codex integration is only an instruction, which the session prompt overrides.
 */
const GLOBAL_HOOKS_SURVIVE_OPT_OUT = ['claudeCode', 'opencode', 'cursor'] as const

export function rtkCoverageFor(codingAgent: string | null | undefined): RtkCoverage {
  return RTK_BACKENDS.find(backend => backend.codingAgent === codingAgent)?.coverage ?? 'rewrite'
}

export type RtkEffectiveState = 'on' | 'off' | 'unavailable'

export interface RtkDetection {
  installed?: boolean
  integrations?: Record<string, boolean>
}

interface BackendDetection {
  installed?: boolean
  supported?: boolean
}

export function rtkEffectiveState(enabled: boolean, rtk: RtkDetection | undefined): RtkEffectiveState {
  if (!enabled) return 'off'
  return rtk?.installed ? 'on' : 'unavailable'
}

export const RTK_STATE_LABELS: Record<RtkEffectiveState, string> = {
  on: 'On',
  off: 'Off',
  unavailable: 'Not installed'
}

const isReady = (backend: BackendDetection | undefined): boolean =>
  backend?.installed === true && backend.supported !== false

/** The usable coding backends and what RTK does for each. */
export function rtkBackendCoverage(detection: Record<string, BackendDetection | undefined>) {
  return RTK_BACKENDS.filter(backend => isReady(detection[backend.key]))
}

/** Backends whose global hook keeps rewriting commands after the opt-out. */
export function rtkGlobalHooksAfterOptOut(detection: Record<string, BackendDetection | undefined>, rtk: RtkDetection | undefined) {
  return RTK_BACKENDS.filter(backend =>
    (GLOBAL_HOOKS_SURVIVE_OPT_OUT as readonly string[]).includes(backend.key)
    && isReady(detection[backend.key])
    && rtk?.integrations?.[backend.key] === true)
}
