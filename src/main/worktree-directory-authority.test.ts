import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeDirectoryAuthority } from './worktree-directory-authority'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), '21x-worktree-authority-')); roots.push(root)
  const repos = join(root, 'repos'), workspaces = join(root, 'workspaces'), outside = join(root, 'personal')
  for (const path of [repos, workspaces, outside]) mkdirSync(path)
  let available = true
  return { root, repos, workspaces, outside,
    authority: new WorktreeDirectoryAuthority([repos, workspaces], () => { if (!available) throw new Error('OWNER_REPLACED') }),
    retire() { available = false } }
}
describe('captured worktree directory authority', () => {
  it('admits missing contained descendants without creating them and checks current owner', () => {
    const value = fixture()
    value.authority.assertPath(join(value.repos, 'group', 'repo.git'))
    value.authority.assertPath(join(value.workspaces, 'task', 'repo'))
    value.retire(); expect(() => value.authority.assertPath(value.repos)).toThrow('OWNER_REPLACED')
  })
  it('refuses outside roots, noncanonical paths and root lookalikes', () => {
    const value = fixture()
    for (const path of [value.outside, value.repos + '-lookalike/repo', value.repos + '/group/../repo', value.repos + '/bad\0name']) expect(() => value.authority.assertPath(path)).toThrow('WORKTREE_PATH_UNAUTHORIZED')
  })
  it('refuses a captured root replaced by a directory or link with the same spelling', () => {
    const value = fixture(); renameSync(value.repos, value.repos + '.owned')
    mkdirSync(value.repos); expect(() => value.authority.assertPath(join(value.repos, 'group'))).toThrow('WORKTREE_ROOT_CHANGED')
    rmdirSync(value.repos); symlinkSync(value.outside, value.repos, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => value.authority.assertPath(join(value.repos, 'group'))).toThrow('WORKTREE_ROOT_CHANGED')
  })
  it('rejects child aliases and files before a caller can create a descendant outside its root', () => {
    const value = fixture(); symlinkSync(value.outside, join(value.repos, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => value.authority.assertPath(join(value.repos, 'alias', 'would-create'))).toThrow('WORKTREE_PATH_UNAUTHORIZED')
    writeFileSync(join(value.repos, 'file'), 'Preserve')
    expect(() => value.authority.assertPath(join(value.repos, 'file', 'child'))).toThrow('WORKTREE_PATH_UNAUTHORIZED')
  })
})
