/**
 * Maps an agent's permission setting onto Claude Code's own permission modes.
 *
 * Production sessions always arrive with `permissionMode: 'allow'` (see
 * assembleSessionConfig): agents run without approval prompts. That maps to
 * Claude Code's `'default'` mode, NOT `'bypassPermissions'`, so every gated
 * tool call still passes through the adapter's `canUseTool` callback. The
 * callback approves it at once unless ./tool-safety.ts finds it dangerous
 * (deleting outside the workspace, touching system paths, wiping disks), and
 * only those rare requests reach the user.
 *
 *  permissionMode | sandboxMode        | Claude Code mode | canUseTool
 *  ---------------|--------------------|------------------|-------------------------
 *  'allow'        | (any)              | 'default'        | approve unless dangerous
 *  'ask'          | 'read-only'        | 'plan'           | ask the user
 *  'ask'          | 'workspace-write'  | 'default'        | ask the user
 *  (absent)       | (absent)           | 'default'        | ask the user
 *
 * 'ask' remains for proof harnesses that construct a SessionConfig directly.
 */

/** Claude Code's own permission modes that this mapping can produce. */
export type ClaudeCodePermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'

/** What 21x stores and what the shared adapter contract accepts. */
export type AdapterPermissionMode = 'ask' | 'allow'

export type AdapterSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Resolve the adapter's permission setting (plus `sandboxMode`, which carries
 * the read-only case that 'ask' | 'allow' cannot) into Claude Code's mode.
 *
 * Total: every input yields a defined mode. `'bypassPermissions'` is never
 * used, because it would skip the dangerous-request check.
 */
export function claudeCodePermissionMode(config: {
  permissionMode?: AdapterPermissionMode
  sandboxMode?: AdapterSandboxMode
}): ClaudeCodePermissionMode {
  if (config.permissionMode === 'allow') {
    return 'default'
  }
  if (config.sandboxMode === 'read-only') {
    return 'plan'
  }
  // 'workspace-write' could mean either `acceptEdits` or `default`; `default`
  // is the stricter of the two, so it is the right answer when in doubt.
  return 'default'
}
