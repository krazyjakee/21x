import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireProfileLock, PROFILE_LOCK_FILE, type ProfileLock } from './profile-lock'

const require = createRequire(import.meta.url)
const profiles: string[] = []
const guards: ProfileLock[] = []
const children: ChildProcess[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), '21x-profile-lock-test-')); profiles.push(root); return root }
const acquire = (root: string, timeoutMs = 0) => { const guard = acquireProfileLock(root, { timeoutMs }); guards.push(guard); return guard }
const closed = (child: ChildProcess) => new Promise<void>((resolve) => child.once('close', () => resolve()))

async function childOwner(root: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], { timeout: 0 });
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('HELD\\n');
    process.stdin.resume();
    process.stdin.once('end', () => { db.close(); process.exit(0) });
  `, require.resolve('better-sqlite3'), join(root, PROFILE_LOCK_FILE)], { stdio: ['pipe', 'pipe', 'ignore'] })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('child lock readiness timeout')), 3000)
    child.once('error', (error) => { clearTimeout(deadline); reject(error) })
    child.once('exit', () => { clearTimeout(deadline); reject(new Error('child failed before ownership')) })
    child.stdout!.once('data', (value: Buffer) => {
      clearTimeout(deadline)
      if (value.toString() === 'HELD\n') resolve(); else reject(new Error('invalid readiness receipt'))
    })
  })
  return child
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const done = closed(child); child.kill('SIGKILL'); await done }
  }
  for (const guard of guards.splice(0)) guard.release()
  for (const root of profiles.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('real SQLite lifetime profile ownership', () => {
  it('preserves profile bytes and the permanent sentinel across release/reacquisition', () => {
    const root = temporary()
    const original = Buffer.from('synthetic untouched profile evidence')
    writeFileSync(join(root, '21x.db'), original)
    const first = acquire(root)
    first.assertHeld()
    first.release()
    first.release()
    expect(() => first.assertHeld()).toThrow('PROFILE_LOCK_LOST')
    expect(existsSync(join(root, PROFILE_LOCK_FILE))).toBe(true)
    acquire(root).assertHeld()
    expect(readFileSync(join(root, '21x.db'))).toEqual(original)
  })

  it('rejects duplicate and canonical path alias owners without disturbing ownership', () => {
    const root = temporary()
    const alias = join(temporary(), 'alias')
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const first = acquire(root)
    expect(() => acquire(root)).toThrow('PROFILE_DUPLICATE_OWNER')
    expect(() => acquire(alias)).toThrow('PROFILE_DUPLICATE_OWNER')
    first.assertHeld()
    first.release()
    expect(acquire(alias).profileRoot).toBe(root)
  })

  it('retains duplicate protection across module reloading', async () => {
    const root = temporary()
    const first = acquire(root)
    vi.resetModules()
    const reloaded = await import('./profile-lock')
    expect(() => reloaded.acquireProfileLock(root)).toThrow('PROFILE_DUPLICATE_OWNER')
    first.assertHeld()
  })

  it('fails closed under cross-process contention and reacquires after owner crash', async () => {
    const root = temporary()
    const child = await childOwner(root)
    const start = Date.now()
    expect(() => acquire(root, 30)).toThrow('PROFILE_IN_USE')
    expect(Date.now() - start).toBeLessThan(1500)
    const done = closed(child)
    child.kill('SIGKILL')
    await done
    acquire(root).assertHeld()
  })

  it('reacquires after an independent owner gracefully closes its transaction', async () => {
    const root = temporary()
    const child = await childOwner(root)
    expect(() => acquire(root)).toThrow('PROFILE_IN_USE')
    const done = closed(child)
    child.stdin!.end()
    await done
    acquire(root).assertHeld()
  })

  it.each(['21x.db', 'pf-desktop.db', PROFILE_LOCK_FILE])('rejects a hard-linked %s before opening it', (name) => {
    const root = temporary()
    const source = join(temporary(), 'source')
    writeFileSync(source, 'untouched')
    linkSync(source, join(root, name))
    expect(() => acquire(root)).toThrow('PROFILE_LOCK_INVALID')
    expect(readFileSync(source, 'utf8')).toBe('untouched')
  })

  it('rejects a symlink sentinel and an existing WAL sentinel', () => {
    const root = temporary()
    const source = join(temporary(), 'source')
    writeFileSync(source, 'untouched')
    symlinkSync(source, join(root, PROFILE_LOCK_FILE))
    expect(() => acquire(root)).toThrow('PROFILE_LOCK_INVALID')
    const walRoot = temporary()
    const wal = new Database(join(walRoot, PROFILE_LOCK_FILE))
    wal.pragma('journal_mode = WAL')
    wal.close()
    expect(() => acquire(walRoot)).toThrow('PROFILE_LOCK_INVALID')
  })

  it('rejects invalid/unbounded timeout and nonabsolute roots', () => {
    for (const timeoutMs of [-1, 1001, NaN, 0.5]) expect(() => acquireProfileLock(temporary(), { timeoutMs })).toThrow('PROFILE_LOCK_INVALID')
    expect(() => acquireProfileLock('relative')).toThrow('PROFILE_LOCK_INVALID')
  })
})
