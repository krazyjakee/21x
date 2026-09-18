import { describe, expect, it } from 'vitest'

import { claudeCodePermissionMode } from './permission-mode'

/**
 * The Claude Code adapter used to hardcode `bypassPermissions`, ignoring the
 * per-agent `permission_mode`. These pin the resolution that replaced it.
 */
describe('claudeCodePermissionMode', () => {
  it('resolves an explicit allow to a real bypass', () => {
    expect(claudeCodePermissionMode({ permissionMode: 'allow' })).toBe('bypassPermissions')
    // sandboxMode must not be able to talk it out of the user's explicit choice.
    expect(claudeCodePermissionMode({ permissionMode: 'allow', sandboxMode: 'read-only' })).toBe(
      'bypassPermissions'
    )
  })

  it('resolves ask + read-only to plan, and ask + workspace-write to default', () => {
    expect(claudeCodePermissionMode({ permissionMode: 'ask', sandboxMode: 'read-only' })).toBe('plan')
    expect(claudeCodePermissionMode({ permissionMode: 'ask', sandboxMode: 'workspace-write' })).toBe(
      'default'
    )
  })

  // If an absent mode resolved to a bypass, any caller that forgot the field
  // would silently restore the old behaviour.
  it('NEVER resolves an absent mode to a bypass', () => {
    expect(claudeCodePermissionMode({})).toBe('default')
    expect(claudeCodePermissionMode({ permissionMode: 'ask' })).toBe('default')
    expect(claudeCodePermissionMode({ sandboxMode: 'workspace-write' })).toBe('default')
    expect(claudeCodePermissionMode({ sandboxMode: 'danger-full-access' })).toBe('default')
  })

  it('is total — every input yields a defined mode, and only allow yields a bypass', () => {
    const inputs = [
      {},
      { permissionMode: 'ask' as const },
      { permissionMode: 'allow' as const },
      { sandboxMode: 'read-only' as const },
      { sandboxMode: 'workspace-write' as const },
      { sandboxMode: 'danger-full-access' as const },
      { permissionMode: 'ask' as const, sandboxMode: 'danger-full-access' as const }
    ]
    for (const input of inputs) {
      const resolved = claudeCodePermissionMode(input)
      expect(resolved).toBeTruthy()
      // The one-way door: a bypass is reachable ONLY from an explicit allow.
      if (resolved === 'bypassPermissions') {
        expect(input).toHaveProperty('permissionMode', 'allow')
      }
    }
  })
})
