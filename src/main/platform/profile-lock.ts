import Database from 'better-sqlite3'
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const PROFILE_LOCK_FILE = '.21x-profile-lock.sqlite'
export type ProfileLockErrorCode = 'PROFILE_IN_USE' | 'PROFILE_DUPLICATE_OWNER' | 'PROFILE_LOCK_INVALID' | 'PROFILE_LOCK_LOST'
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
 * Cooperative lifetime ownership using SQLite's existing OS-backed VFS locks.
 * Only local filesystems with correct SQLite locking are supported. Retain the
 * sentinel permanently: unlinking/replacing it would create two lock domains.
 * No application database or credential provider is opened by this function.
 */
export function acquireProfileLock(profileRoot: string, options: { timeoutMs?: number } = {}): ProfileLock {
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
    fail(code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ? 'PROFILE_IN_USE' : 'PROFILE_LOCK_INVALID')
  }
}
