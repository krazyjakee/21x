import Database from 'better-sqlite3'
import { lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const PROFILE_LOCK_FILE = '.21x-profile-lock.sqlite'
/** Present only while the Tauri app runs on an Electron profile. See `heldByTauri`. */
export const TAURI_HOLDER_FILE = '.21x-tauri-holder'
/** Written by the Tauri app into an Electron profile it shares, and never removed by either app. See `tauriSharesWorkspaces`. */
export const TAURI_SHARED_WORKSPACES_FILE = '.21x-tauri-shares-workspaces'
/** Long enough for two simultaneous hosts to settle on one winner, not both fail. */
export const HOST_CLAIM_TIMEOUT_MS = 250
export type ProfileLockErrorCode = 'PROFILE_IN_USE' | 'PROFILE_DUPLICATE_OWNER' | 'PROFILE_LOCK_INVALID' | 'PROFILE_LOCK_LOST' | 'PROFILE_LOW_DISK'
export class ProfileLockError extends Error {
  constructor(readonly code: ProfileLockErrorCode) {
    super(code)
    this.name = 'ProfileLockError'
  }
}

export interface ProfileLock {
  /** Canonical physical directory; use it for every subsequent profile path. */
  readonly profileRoot: string
  assertHeld(): void
  /** Close all databases, providers and owned writers before releasing. */
  release(): void
}

// A second module instance must not open/close the sentinel descriptor while
// another instance owns POSIX fcntl locks. Share ownership across module reloads.
const registryKey = Symbol.for('21x.profile-lock.owners.v1')
const globals = globalThis as typeof globalThis & { [registryKey]?: Set<string> }
const owners = globals[registryKey] ??= new Set<string>()
const identity = (path: string): string => {
  const entry = statSync(path, { bigint: true })
  return `${entry.dev}:${entry.ino}`
}
const fail = (code: ProfileLockErrorCode): never => { throw new ProfileLockError(code) }

function regularUnaliasedFile(path: string, absentAllowed = false): void {
  try {
    const entry = lstatSync(path, { bigint: true })
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) fail('PROFILE_LOCK_INVALID')
  } catch (error) {
    if (absentAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/**
 * Tells the Electron app which app it lost to, so its refusal can name it. The
 * SQLite lock alone decides ownership: this note is read only after a real
 * PROFILE_IN_USE, so one left behind by a crash can neither block a start nor
 * make a live process look dead, and no process ID is ever consulted. It is
 * separate from the sentinel because closing a second descriptor on the sentinel
 * would drop this process's POSIX lock.
 */
export function heldByTauri(profileRoot: string): boolean {
  try { return lstatSync(join(profileRoot, TAURI_HOLDER_FILE)).isFile() } catch { return false }
}

/**
 * Tells Electron that the Tauri app shares these folders, so a workspace that looks
 * finished or unknown here may hold Tauri's only copy of some work. Presence alone
 * decides: the content is never read, and anything at this name counts, as does any
 * failure to look other than the name being absent. Wrongly keeping a folder costs
 * disk; wrongly removing one loses work.
 */
export function tauriSharesWorkspaces(profileRoot: string): boolean {
  try { lstatSync(join(profileRoot, TAURI_SHARED_WORKSPACES_FILE)); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
}

/** Only an owner may call this. Failing costs a precise message, never safety. */
export function clearTauriHolder(profileRoot: string): void {
  try { rmSync(join(profileRoot, TAURI_HOLDER_FILE), { force: true }) } catch { /* the lock still protects the profile */ }
}

function markTauriHolder(profileRoot: string): void {
  // Removed first, so a planted link is replaced rather than followed.
  clearTauriHolder(profileRoot)
  try { writeFileSync(join(profileRoot, TAURI_HOLDER_FILE), 'tauri\n', { flag: 'wx', mode: 0o600 }) } catch { /* as above */ }
}

/**
 * One lease over a profile and the second profile it shares data with. Callers
 * keep using the primary profile's paths; losing either lock loses the lease.
 */
export function jointProfileLock(primary: ProfileLock, shared: ProfileLock): ProfileLock {
  return Object.freeze({
    profileRoot: primary.profileRoot,
    assertHeld() { primary.assertHeld(); shared.assertHeld() },
    // A failed release keeps the primary too, so the caller still owns both.
    release() { shared.release(); primary.release() }
  })
}

/**
 * Cooperative lifetime ownership using SQLite's existing OS-backed VFS locks.
 * Only local filesystems with correct SQLite locking are supported. Retain the
 * sentinel permanently: unlinking/replacing it would create two lock domains.
 * No application database or credential provider is opened by this function.
 * `tauriHolder` is for a Tauri session that runs on an Electron profile.
 */
export function acquireProfileLock(profileRoot: string, options: { timeoutMs?: number; tauriHolder?: boolean } = {}): ProfileLock {
  const timeoutMs = options.timeoutMs ?? 0
  if (!isAbsolute(profileRoot) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 1000) fail('PROFILE_LOCK_INVALID')
  let connection: Database.Database | undefined
  let ownerKey: string | undefined
  try {
    mkdirSync(profileRoot, { recursive: true })
    const canonical = realpathSync.native(profileRoot)
    if (!statSync(canonical).isDirectory()) fail('PROFILE_LOCK_INVALID')
    ownerKey = identity(canonical)
    if (owners.has(ownerKey)) fail('PROFILE_DUPLICATE_OWNER')
    owners.add(ownerKey)
    const sentinel = join(canonical, PROFILE_LOCK_FILE)
    regularUnaliasedFile(sentinel, true)
    // Reject profiles that alias application databases into another lock domain.
    for (const name of ['21x.db', 'pf-desktop.db']) regularUnaliasedFile(join(canonical, name), true)
    connection = new Database(sentinel, { timeout: timeoutMs })
    regularUnaliasedFile(sentinel)
    const sentinelIdentity = identity(sentinel)
    // Never accept a WAL sentinel: BEGIN EXCLUSIVE in WAL allows other readers.
    if (connection.pragma('journal_mode', { simple: true }) !== 'delete') fail('PROFILE_LOCK_INVALID')
    connection.exec('BEGIN EXCLUSIVE')
    if (options.tauriHolder) markTauriHolder(canonical)
    const ownedConnection = connection
    const heldOwnerKey = ownerKey
    let released = false
    return Object.freeze({
      profileRoot: canonical,
      assertHeld() {
        if (released || !ownedConnection.open || !ownedConnection.inTransaction) fail('PROFILE_LOCK_LOST')
        try {
          regularUnaliasedFile(sentinel)
          if (identity(canonical) !== heldOwnerKey || identity(sentinel) !== sentinelIdentity) fail('PROFILE_LOCK_LOST')
        } catch { fail('PROFILE_LOCK_LOST') }
      },
      release() {
        if (released) return
        // Still the owner here, so this cannot remove a later owner's note.
        if (options.tauriHolder) clearTauriHolder(canonical)
        // close rolls back the empty transaction and releases the kernel lock.
        // Keep registration on failure, so a second owner cannot bypass it.
        try { ownedConnection.close() } catch { fail('PROFILE_LOCK_LOST') }
        released = true
        owners.delete(heldOwnerKey)
      }
    })
  } catch (error) {
    if (connection?.open) connection.close()
    // Never remove an existing owner's registration after a duplicate request.
    if (ownerKey && !(error instanceof ProfileLockError && error.code === 'PROFILE_DUPLICATE_OWNER')) owners.delete(ownerKey)
    if (error instanceof ProfileLockError) throw error
    const code = (error as { code?: string }).code
    if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'SQLITE_FULL') return fail('PROFILE_LOW_DISK')
    return fail(code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ? 'PROFILE_IN_USE' : 'PROFILE_LOCK_INVALID')
  }
}
