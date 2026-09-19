/**
 * Maps an agent's permission setting onto Claude Code's own permission modes.
 *
 * 21x stores a two-valued `permission_mode` ('ask' | 'allow') per agent and
 * passes it to every adapter as `SessionConfig.permissionMode`.
 *
 * The rule: a mode may resolve to something STRICTER than the user asked for,
 * never to something looser. `'bypassPermissions'` is reachable from exactly
 * one input, an explicit `'allow'`. An absent mode resolves to `'default'`, so a
 * caller that forgets the field cannot silently restore the bypass.
 *
 *  permissionMode | sandboxMode        | Claude Code mode
 *  ---------------|--------------------|------------------
 *  'allow'        | (any)              | 'bypassPermissions'
 *  'ask'          | 'read-only'        | 'plan'
 *  'ask'          | 'workspace-write'  | 'default'
 *  'ask'          | (absent)           | 'default'
 *  (absent)       | (absent)           | 'default'      <-- NOT bypass
 *
 * In `'default'` and `'plan'` Claude Code asks before running tools that need
 * approval; the adapter routes those requests to the 21x approval UI through
 * the SDK's `canUseTool` callback.
 */

/** `sandboxMode` carries the read-only case that 'ask' | 'allow' cannot. */
export function claudeCodePermissionMode(config: {
  permissionMode?: 'ask' | 'allow'
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
}): 'default' | 'plan' | 'bypassPermissions' {
  if (config.permissionMode === 'allow') {
    return 'bypassPermissions'
  }
  if (config.sandboxMode === 'read-only') {
    return 'plan'
  }
  // 'workspace-write' could mean either `acceptEdits` or `default`; `default`
  // is the stricter of the two, so it is the right answer when in doubt.
  return 'default'
}
