/**
 * Set on the agent processes 21x spawns, and inherited by whatever they run.
 * On a Linux desktop it is the only proof that an orphan adopted by the session
 * manager was started by 21x, so the workspace sweep may act on it. See
 * `workspace-process-cleanup.ts`.
 *
 * Never put this on `process.env`. It has to stay off everything a person
 * starts, or that person's editor or tmux server would look like agent work.
 */
export const AGENT_WORK_MARKER = 'TWENTYONEX_AGENT_WORK'
export const AGENT_WORK_ENV: Readonly<Record<string, string>> = { [AGENT_WORK_MARKER]: '1' }

/** A copy without the marker, for a shell a person will type into. */
export function withoutAgentWorkMarker<T extends Record<string, string | undefined>>(env: T): T {
  const copy = { ...env }
  delete copy[AGENT_WORK_MARKER]
  return copy
}
