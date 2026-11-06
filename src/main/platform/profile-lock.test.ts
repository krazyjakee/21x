import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireProfileLock, heldByTauri, HOST_CLAIM_TIMEOUT_MS, jointProfileLock, PROFILE_LOCK_FILE, TAURI_HOLDER_FILE, TAURI_SHARED_WORKSPACES_FILE, tauriSharesWorkspaces, type ProfileLock } from './profile-lock'
import { holdProfileElsewhere, profileListing, raceForProfile, stopOtherHosts } from '../../../test/helpers/profile-holder'

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
  await stopOtherHosts()
  for (const guard of guards.splice(0)) guard.release()
  for (const root of profiles.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the marker that keeps whole workspaces', () => {
  it('is absent only when the name is really absent', () => {
    const root = temporary()
    expect(tauriSharesWorkspaces(root)).toBe(false)
    writeFileSync(join(root, TAURI_SHARED_WORKSPACES_FILE), '')
    expect(tauriSharesWorkspaces(root)).toBe(true)
  })
  it('counts a link to nowhere, and a folder', () => {
    const link = temporary(), folder = temporary()
    symlinkSync(join(link, 'missing'), join(link, TAURI_SHARED_WORKSPACES_FILE))
    mkdirSync(join(folder, TAURI_SHARED_WORKSPACES_FILE))
    expect(tauriSharesWorkspaces(link)).toBe(true)
    expect(tauriSharesWorkspaces(folder)).toBe(true)
  })
  it('counts as present when the folder cannot be searched', () => {
    if (process.getuid?.() === 0) return
    const root = temporary()
    chmodSync(root, 0o000)
    try { expect(tauriSharesWorkspaces(root)).toBe(true) } finally { chmodSync(root, 0o700) }
  })
  it('counts as present when the path is not a folder at all', () => {
    const root = temporary(), file = join(root, 'file'); writeFileSync(file, '')
    expect(tauriSharesWorkspaces(file)).toBe(true)
  })
  it('is not the note that says who holds the lock, which is cleared on exit', () => {
    expect(TAURI_SHARED_WORKSPACES_FILE).not.toBe(TAURI_HOLDER_FILE)
    expect(TAURI_SHARED_WORKSPACES_FILE).not.toBe(PROFILE_LOCK_FILE)
  })
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

  it('writes nothing to the profile when it loses to a live owner', async () => {
    const root = temporary()
    writeFileSync(join(root, '21x.db'), 'synthetic')
    await holdProfileElsewhere(root)
    const before = profileListing(root)
    expect(() => acquireProfileLock(root, { tauriHolder: true })).toThrow('PROFILE_IN_USE')
    expect(profileListing(root)).toEqual(before)
    expect(heldByTauri(root)).toBe(false)
  })

  it('lets one of two simultaneous starts win, including on a brand-new profile', async () => {
    for (let round = 0; round < 5; round++) {
      const race = await raceForProfile(temporary(), 2, HOST_CLAIM_TIMEOUT_MS)
      expect(race.winners).toBe(1)
      await race.finish()
    }
  }, 20_000)

  it('announces a Tauri holder only while it holds the lock', () => {
    const root = temporary()
    const tauri = acquireProfileLock(root, { tauriHolder: true }); guards.push(tauri)
    expect(heldByTauri(root)).toBe(true)
    tauri.release()
    expect(heldByTauri(root)).toBe(false)
  })

  it('leaves no note for a host that does not announce itself', () => {
    const root = temporary()
    acquire(root)
    expect(existsSync(join(root, TAURI_HOLDER_FILE))).toBe(false)
  })

  it('is never blocked by a note a crash left behind, whatever process ID it once belonged to', () => {
    const root = temporary()
    writeFileSync(join(root, TAURI_HOLDER_FILE), 'tauri\n')
    acquire(root).assertHeld()
  })

  it('replaces a planted note link instead of writing through it', () => {
    const root = temporary()
    const target = join(temporary(), 'target')
    writeFileSync(target, 'untouched')
    symlinkSync(target, join(root, TAURI_HOLDER_FILE))
    const tauri = acquireProfileLock(root, { tauriHolder: true }); guards.push(tauri)
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    expect(heldByTauri(root)).toBe(true)
  })

  it('joins two locks into one lease that either can break', () => {
    const primary = acquire(temporary()), shared = acquire(temporary())
    const joint = jointProfileLock(primary, shared)
    expect(joint.profileRoot).toBe(primary.profileRoot)
    joint.assertHeld()
    shared.release()
    expect(() => joint.assertHeld()).toThrow('PROFILE_LOCK_LOST')
    joint.release()
    expect(() => primary.assertHeld()).toThrow('PROFILE_LOCK_LOST')
  })

  it('rejects invalid/unbounded timeout and nonabsolute roots', () => {
    for (const timeoutMs of [-1, 1001, NaN, 0.5]) expect(() => acquireProfileLock(temporary(), { timeoutMs })).toThrow('PROFILE_LOCK_INVALID')
    expect(() => acquireProfileLock('relative')).toThrow('PROFILE_LOCK_INVALID')
  })
})
