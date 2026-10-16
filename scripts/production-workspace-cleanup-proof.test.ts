import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isSyntheticDescendant, WORKSPACE_CLEANUP_FIXTURE } from './production-workspace-cleanup-proof'

describe('workspace cleanup fixture authority', () => {
  it('refuses roots, siblings and traversal before spawning a fixture process', () => {
    const root = join(tmpdir(), 'synthetic')
    expect(isSyntheticDescendant(root, join(root, 'task'))).toBe(true)
    expect(isSyntheticDescendant(root, root)).toBe(false)
    expect(isSyntheticDescendant(root, join(tmpdir(), 'synthetic-other', 'task'))).toBe(false)
    expect(isSyntheticDescendant(root, join(root, '..', 'foreign'))).toBe(false)
  })

  it('defines old completed-task data and a bounded receipt deadline explicitly', () => {
    expect(WORKSPACE_CLEANUP_FIXTURE.retentionDays).toBe(1)
    expect(Date.parse(WORKSPACE_CLEANUP_FIXTURE.age)).toBe(Date.UTC(2000, 0, 1))
    expect(WORKSPACE_CLEANUP_FIXTURE.timeoutMs).toBe(10_000)
  })
})
