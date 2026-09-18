import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IDENTITY_MIGRATION_MARKER, legacyUserDataDirs, migrateAppIdentity } from './app-identity-migration'

describe('migrateAppIdentity', () => {
  let appData: string
  let oldDir: string
  let newDir: string
  const quiet = (): void => {}

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), '21x-identity-'))
    oldDir = join(appData, '20x')
    newDir = join(appData, '21x')
  })

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true })
  })

  function write(path: string, content: string): void {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }

  function read(path: string): string {
    return readFileSync(path, 'utf8')
  }

  it('looks for the legacy userData next to the new one', () => {
    expect(legacyUserDataDirs(newDir)).toEqual([oldDir])
  })

  it('copies the legacy database with its WAL/SHM and the data directories, once', () => {
    write(join(oldDir, 'pf-desktop.db'), 'db')
    write(join(oldDir, 'pf-desktop.db-wal'), 'wal')
    write(join(oldDir, 'pf-desktop.db-shm'), 'shm')
    write(join(oldDir, 'attachments', 'task-1', 'a-file.txt'), 'attachment')
    write(join(oldDir, 'voice-models', 'model.bin'), 'model')
    write(join(oldDir, 'logs', 'crash.log'), 'log')
    write(join(oldDir, 'Cache', 'junk'), 'not carried over')

    const result = migrateAppIdentity({ userDataDir: newDir, log: quiet })

    expect(result.outcome).toBe('copied')
    expect(result.source).toBe(oldDir)
    expect(read(join(newDir, '21x.db'))).toBe('db')
    expect(read(join(newDir, '21x.db-wal'))).toBe('wal')
    expect(read(join(newDir, '21x.db-shm'))).toBe('shm')
    expect(read(join(newDir, 'attachments', 'task-1', 'a-file.txt'))).toBe('attachment')
    expect(read(join(newDir, 'voice-models', 'model.bin'))).toBe('model')
    expect(read(join(newDir, 'logs', 'crash.log'))).toBe('log')
    expect(existsSync(join(newDir, 'Cache'))).toBe(false)
    expect(existsSync(join(newDir, 'pf-desktop.db'))).toBe(false)
    expect(existsSync(join(newDir, IDENTITY_MIGRATION_MARKER))).toBe(true)
    expect(existsSync(join(newDir, '.21x-identity-migration-staging'))).toBe(false)

    // Copied, not moved.
    expect(read(join(oldDir, 'pf-desktop.db'))).toBe('db')
    expect(read(join(oldDir, 'pf-desktop.db-wal'))).toBe('wal')
    expect(read(join(oldDir, 'attachments', 'task-1', 'a-file.txt'))).toBe('attachment')

    // The marker stops a second copy even if the new database goes away.
    write(join(oldDir, 'pf-desktop.db'), 'newer legacy data')
    rmSync(join(newDir, '21x.db'))
    const again = migrateAppIdentity({ userDataDir: newDir, log: quiet })
    expect(again.outcome).toBe('already-migrated')
    expect(existsSync(join(newDir, '21x.db'))).toBe(false)
  })

  it('never touches a database that already exists in the new userData', () => {
    write(join(oldDir, 'pf-desktop.db'), 'old')
    write(join(oldDir, 'attachments', 'x'), 'old attachment')
    write(join(newDir, '21x.db'), 'current')

    const result = migrateAppIdentity({ userDataDir: newDir, log: quiet })

    expect(result.outcome).toBe('existing-database')
    expect(read(join(newDir, '21x.db'))).toBe('current')
    expect(existsSync(join(newDir, 'attachments'))).toBe(false)
    expect(existsSync(join(newDir, IDENTITY_MIGRATION_MARKER))).toBe(true)
  })

  it('renames a pf-desktop.db already in the new userData to 21x.db', () => {
    write(join(newDir, 'pf-desktop.db'), 'dev db')
    write(join(newDir, 'pf-desktop.db-wal'), 'dev wal')
    write(join(oldDir, 'pf-desktop.db'), 'legacy db')

    const result = migrateAppIdentity({ userDataDir: newDir, log: quiet })

    expect(result.renamedInPlace).toBe(true)
    expect(result.outcome).toBe('existing-database')
    expect(read(join(newDir, '21x.db'))).toBe('dev db')
    expect(read(join(newDir, '21x.db-wal'))).toBe('dev wal')
    expect(existsSync(join(newDir, 'pf-desktop.db'))).toBe(false)
    expect(existsSync(join(newDir, 'pf-desktop.db-wal'))).toBe(false)
  })

  it('finishes an in-place rename that was interrupted after the WAL moved', () => {
    write(join(newDir, 'pf-desktop.db'), 'dev db')
    write(join(newDir, '21x.db-wal'), 'already moved wal')

    migrateAppIdentity({ userDataDir: newDir, log: quiet })

    expect(read(join(newDir, '21x.db'))).toBe('dev db')
    expect(read(join(newDir, '21x.db-wal'))).toBe('already moved wal')
  })

  it('resumes a copy interrupted before the database was placed', () => {
    write(join(oldDir, 'pf-desktop.db'), 'db')
    write(join(oldDir, 'attachments', 'a'), 'attachment')
    write(join(oldDir, 'logs', 'crash.log'), 'log')
    // State left by a crash: attachments placed, logs half-staged, no database, no marker.
    write(join(newDir, 'attachments', 'a'), 'attachment')
    write(join(newDir, '.21x-identity-migration-staging', 'logs', 'partial'), 'partial')

    const result = migrateAppIdentity({ userDataDir: newDir, log: quiet })

    expect(result.outcome).toBe('copied')
    expect(result.copied).toEqual(['logs', '21x.db'])
    expect(read(join(newDir, 'logs', 'crash.log'))).toBe('log')
    expect(existsSync(join(newDir, 'logs', 'partial'))).toBe(false)
    expect(read(join(newDir, '21x.db'))).toBe('db')
  })

  it('drops a stale WAL beside the new database when the legacy database has none', () => {
    write(join(oldDir, 'pf-desktop.db'), 'db')
    write(join(newDir, '21x.db-wal'), 'stale')

    migrateAppIdentity({ userDataDir: newDir, log: quiet })

    expect(read(join(newDir, '21x.db'))).toBe('db')
    expect(existsSync(join(newDir, '21x.db-wal'))).toBe(false)
  })

  it('points copied git worktrees at the new userData', () => {
    const oldRepo = join(oldDir, 'repos', 'org', 'app.git')
    const oldWorktree = join(oldDir, 'workspaces', 'task-1', 'app')
    write(join(oldDir, 'pf-desktop.db'), 'db')
    write(join(oldWorktree, '.git'), `gitdir: ${join(oldRepo, 'worktrees', 'app')}\n`)
    write(join(oldWorktree, 'src', 'index.ts'), 'code')
    write(join(oldRepo, 'worktrees', 'app', 'gitdir'), `${join(oldWorktree, '.git')}\n`)
    write(join(oldRepo, 'HEAD'), 'ref: refs/heads/main\n')

    migrateAppIdentity({ userDataDir: newDir, log: quiet })

    const newRepo = join(newDir, 'repos', 'org', 'app.git')
    const newWorktree = join(newDir, 'workspaces', 'task-1', 'app')
    expect(read(join(newWorktree, '.git'))).toBe(`gitdir: ${join(newRepo, 'worktrees', 'app')}\n`)
    expect(read(join(newRepo, 'worktrees', 'app', 'gitdir'))).toBe(`${join(newWorktree, '.git')}\n`)
    expect(read(join(newWorktree, 'src', 'index.ts'))).toBe('code')
    // The legacy copy still points at itself.
    expect(read(join(oldWorktree, '.git'))).toBe(`gitdir: ${join(oldRepo, 'worktrees', 'app')}\n`)
  })

  it('records a fresh install so later launches skip the check', () => {
    const result = migrateAppIdentity({ userDataDir: newDir, log: quiet })

    expect(result.outcome).toBe('fresh-install')
    expect(existsSync(join(newDir, IDENTITY_MIGRATION_MARKER))).toBe(true)
    expect(existsSync(join(newDir, '21x.db'))).toBe(false)
  })
})
