import { afterEach, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { writeAgentsDocumentation } from './workspace-docs'
const boundary = vi.hoisted(() => ({ afterWrite: undefined as (() => void) | undefined }))
vi.mock('fs/promises', async original => {
  const actual = await original<typeof import('fs/promises')>()
  return { ...actual, writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => { await actual.writeFile(...args); boundary.afterWrite?.() }) }
})
afterEach(() => { boundary.afterWrite = undefined; vi.restoreAllMocks() })
it('acknowledges the accepted real file write but refuses the next workspace document after scope withdrawal', async () => {
  const db = createPortableTestDb(), task = db.createTask({ title: 'Workspace documentation' })!, workspace = db.getWorkspaceDir(task.id), denied = new Error('Caller scope withdrawn')
  writeFileSync(join(workspace, 'CLAUDE.md'), 'Keep existing instructions')
  let allowed = true; boundary.afterWrite = () => { allowed = false }
  try {
    await expect(writeAgentsDocumentation(db, workspace, [], [], undefined, undefined, () => { if (!allowed) throw denied })).rejects.toBe(denied)
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain('Agent')
    expect(readFileSync(join(workspace, 'CLAUDE.md'), 'utf8')).toBe('Keep existing instructions')
  } finally { db.close(); rmSync(dirname(dirname(workspace)), { recursive: true, force: true }) }
})
