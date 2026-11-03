import { describe, expect, it } from 'vitest'

import { claudeCodePermissionMode } from './permission-mode'

/**
 * Production sessions always run with permissionMode 'allow'. That must map to
 * Claude Code's 'default' mode, never 'bypassPermissions', so canUseTool still
 * sees each request and can stop the dangerous ones.
 */
describe('claudeCodePermissionMode', () => {
  it("resolves allow to 'default', not a bypass", () => {
    expect(claudeCodePermissionMode({ permissionMode: 'allow' })).toBe('default')
    expect(claudeCodePermissionMode({ permissionMode: 'allow', sandboxMode: 'read-only' })).toBe('default')
  })

  it('resolves ask + read-only to plan, and ask + workspace-write to default', () => {
    expect(claudeCodePermissionMode({ permissionMode: 'ask', sandboxMode: 'read-only' })).toBe('plan')
    expect(claudeCodePermissionMode({ permissionMode: 'ask', sandboxMode: 'workspace-write' })).toBe('default')
  })

  it('never resolves any input to a bypass', () => {
    const inputs = [
      {},
      { permissionMode: 'ask' as const },
      { permissionMode: 'allow' as const },
      { sandboxMode: 'read-only' as const },
      { sandboxMode: 'workspace-write' as const },
      { sandboxMode: 'danger-full-access' as const },
      { permissionMode: 'allow' as const, sandboxMode: 'danger-full-access' as const }
    ]
    for (const input of inputs) {
      const resolved = claudeCodePermissionMode(input)
      expect(resolved).toBeTruthy()
      expect(resolved).not.toBe('bypassPermissions')
    }
  })
})
