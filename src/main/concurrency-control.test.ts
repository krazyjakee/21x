import { execFileSync } from 'child_process'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, it } from 'vitest'
import { changedFiles, findFileOverlap } from './concurrency-control'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('detects overlap for Git-quoted paths and both sides of a rename', async () => {
  const dir = mkdtempSync(join(tmpdir(), '21x-concurrency-diff-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Concurrency test')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(dir, 'old.ts'), 'export const old = 1\n')
  git('add', '.')
  git('commit', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  renameSync(join(dir, 'old.ts'), join(dir, 'new.ts'))
  writeFileSync(join(dir, 'café.ts'), 'export const value = 1\n')
  git('add', '.')
  git('commit', '-m', 'rename and Unicode')
  writeFileSync(join(dir, 'tab\tfile.ts'), 'untracked')
  const files = await changedFiles(dir)
  expect(files).toEqual(expect.arrayContaining(['old.ts', 'new.ts', 'café.ts', 'tab\tfile.ts']))
  for (const path of ['old.ts', 'café.ts', 'tab\tfile.ts']) {
    expect(findFileOverlap({ taskId: 'waiting', repos: ['repo'], touches: [path] }, [
      { taskId: 'running', repos: ['repo'], touches: files }
    ])).toEqual({ taskId: 'running', path })
  }
})
