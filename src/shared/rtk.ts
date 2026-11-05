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
 * - `approved`: as `rewrite`, but only commands that reach the approval step.
 *   Commands the backend approves by itself stay uncompressed.
 * - `rewrite`: shell commands go through `rtk rewrite` before they run. RTK
 *   rewrites the ones it can filter and leaves the rest as they are.
 * - `instructions`: 21x has no way to change the command, so the agent is told
 *   to use RTK. The agent may not follow that, so it is not enforcement.
 */
export type RtkCoverage = 'approved' | 'rewrite' | 'instructions'

export const RTK_BACKENDS = [
  { key: 'claudeCode', codingAgent: 'claude-code', label: 'Claude Code', coverage: 'approved' },
  { key: 'opencode', codingAgent: 'opencode', label: 'OpenCode', coverage: 'rewrite' },
  { key: 'pi', codingAgent: 'pi', label: 'Pi', coverage: 'rewrite' },
  { key: 'codex', codingAgent: 'codex', label: 'Codex', coverage: 'instructions' },
  { key: 'cursor', codingAgent: 'cursor', label: 'Cursor', coverage: 'instructions' }
] as const satisfies ReadonlyArray<{ key: string; codingAgent: string; label: string; coverage: RtkCoverage }>

/**
 * Global RTK hooks that 21x cannot turn off for a session. They run inside the
 * backend, before its permission check, and ignore RTK_DISABLED. Pi's extension
 * honours it, and a Codex integration is only an instruction.
 */
const GLOBAL_HOOKS_OUTSIDE_21X = ['claudeCode', 'opencode', 'cursor'] as const

export function rtkCoverageFor(codingAgent: string | null | undefined): RtkCoverage {
  return RTK_BACKENDS.find(backend => backend.codingAgent === codingAgent)?.coverage ?? 'rewrite'
}

/** `rtk rewrite` first shipped in this release. */
export const MINIMUM_RTK_VERSION = '0.23.0'

export type RtkEffectiveState = 'on' | 'off' | 'unavailable' | 'unsupported'

export interface RtkDetection {
  installed?: boolean
  version?: string | null
  integrations?: Record<string, boolean>
}

/** False for an old RTK, and for an unrelated program that happens to be called rtk. */
function isSupportedRtkVersion(version: string | null | undefined): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)/.exec(value)?.slice(1).map(Number)
  const current = version ? parse(version) : undefined
  const minimum = parse(MINIMUM_RTK_VERSION)
  if (!current || !minimum) return false
  return current[0] > minimum[0] || (current[0] === minimum[0] && current[1] >= minimum[1])
}

interface BackendDetection {
  installed?: boolean
  supported?: boolean
}

export function rtkEffectiveState(enabled: boolean, rtk: RtkDetection | undefined): RtkEffectiveState {
  if (!enabled) return 'off'
  if (!rtk?.installed) return 'unavailable'
  return isSupportedRtkVersion(rtk.version) ? 'on' : 'unsupported'
}

export const RTK_STATE_LABELS: Record<RtkEffectiveState, string> = {
  on: 'On',
  off: 'Off',
  unavailable: 'Not installed',
  unsupported: 'Unsupported version'
}

const isReady = (backend: BackendDetection | undefined): boolean =>
  backend?.installed === true && backend.supported !== false

/** The usable coding backends and what RTK does for each. */
export function rtkBackendCoverage(detection: Record<string, BackendDetection | undefined>) {
  return RTK_BACKENDS.filter(backend => isReady(detection[backend.key]))
}

/** Backends with a global RTK hook, which 21x can neither stop nor make respect deny rules. */
export function rtkGlobalHooks(detection: Record<string, BackendDetection | undefined>, rtk: RtkDetection | undefined) {
  return RTK_BACKENDS.filter(backend =>
    (GLOBAL_HOOKS_OUTSIDE_21X as readonly string[]).includes(backend.key)
    && isReady(detection[backend.key])
    && rtk?.integrations?.[backend.key] === true)
}
