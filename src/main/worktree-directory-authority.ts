import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Captured host roots, never renderer-selected paths. Child links are refused;
 * a trusted system ancestor alias may remain only while its identity is stable. */
export class WorktreeDirectoryAuthority {
  private readonly roots: Array<{ path: string; canonical: string; dev: number; ino: number }>
  constructor(roots: readonly string[], private readonly assertCurrent: () => void) {
    assertCurrent()
    if (!roots.length || roots.length > 2) throw new Error('WORKTREE_ROOTS_INVALID')
    this.roots = roots.map(path => {
      if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw new Error('WORKTREE_ROOTS_INVALID')
      const info = lstatSync(path)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('WORKTREE_ROOTS_INVALID')
      return { path, canonical: realpathSync(path), dev: info.dev, ino: info.ino }
    })
  }
  assertPath(path: string): void {
    this.assertCurrent()
    if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0') || path.length > 16384) throw new Error('WORKTREE_PATH_UNAUTHORIZED')
    const root = this.roots.find(root => {
      const value = relative(root.path, path)
      return value === '' || !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)
    })
    if (!root) throw new Error('WORKTREE_PATH_UNAUTHORIZED')
    const current = lstatSync(root.path)
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino || realpathSync(root.path) !== root.canonical) throw new Error('WORKTREE_ROOT_CHANGED')
    const parts = relative(root.path, path).split(sep).filter(Boolean)
    if (parts.length > 64) throw new Error('WORKTREE_PATH_UNAUTHORIZED')
    let cursor = root.path
    for (let index = 0; index < parts.length; index++) {
      cursor = resolve(cursor, parts[index])
      let info: Stats
      try { info = lstatSync(cursor) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('WORKTREE_PATH_UNAUTHORIZED')
    }
  }
}
