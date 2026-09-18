/**
 * One-time data carry-over for the 20x → 21x rename (issue #25).
 *
 * Electron derives the userData directory from the product name, so the first
 * 21x launch starts in an empty `<appData>/21x` while the user's tasks sit in
 * `<appData>/20x/pf-desktop.db`. This module runs once, before the database is
 * opened, and:
 *
 *   1. Renames a `pf-desktop.db` (+ -wal/-shm) that is already in the NEW
 *      userData to `21x.db` — a dev checkout or a build that used the new
 *      product name before the database was renamed.
 *   2. If the new userData still has no database and a legacy userData has
 *      one, COPIES (never moves) the database and the directories the app
 *      relies on into the new userData. The legacy directory is left as it was,
 *      so the old app still works and a failed copy loses nothing.
 *   3. Writes a marker so the copy never runs again.
 *
 * Crash safety: everything is copied into a staging directory inside the new
 * userData and renamed into place. The database goes last, because "the new
 * database exists" is what tells a later launch the carry-over is finished. A
 * launch that dies half-way repeats the copy of whatever is not in place yet.
 *
 * Git worktrees store absolute paths (`<workspace>/.git` points at the bare
 * repository, the repository's `worktrees/<name>/gitdir` points back), so those
 * small files are rewritten from the legacy root to the new one after copying.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join, sep } from 'path'
import { DB_FILE_NAME, LEGACY_DB_FILE_NAME, LEGACY_PRODUCT_NAMES } from './app-identity'

export const IDENTITY_MIGRATION_MARKER = '.21x-identity-migration.json'
const STAGING_DIR = '.21x-identity-migration-staging'
const DB_SIDECARS = ['-wal', '-shm'] as const

/**
 * The userData entries copied from the legacy directory besides the database.
 * The database itself is handled separately. Chromium's own profile files are
 * left alone except Local Storage, which holds the renderer's persisted UI state.
 */
export const CARRIED_OVER_ENTRIES: readonly string[] = [
  'attachments',
  'plugins',
  'voice-models',
  'voice-tts-models',
  'voice-runtime',
  'browser-recordings',
  'logs',
  'Local Storage',
  // Largest last: a full disk then costs the least.
  'repos',
  'workspaces'
]

export type IdentityMigrationOutcome =
  | 'already-migrated'
  | 'existing-database'
  | 'fresh-install'
  | 'copied'

export interface IdentityMigrationResult {
  outcome: IdentityMigrationOutcome
  /** The pf-desktop.db already in the new userData was renamed to 21x.db. */
  renamedInPlace: boolean
  /** The legacy userData the data came from, when it was copied. */
  source?: string
  copied: string[]
  failed: Array<{ entry: string; error: string }>
}

export interface IdentityMigrationOptions {
  /** `app.getPath('userData')` — the new, 21x directory. */
  userDataDir: string
  /** Legacy userData directories to look in, most recent first. Defaults to the siblings named after LEGACY_PRODUCT_NAMES. */
  legacyUserDataDirs?: string[]
  log?: (message: string) => void
}

export function legacyUserDataDirs(userDataDir: string): string[] {
  const parent = dirname(userDataDir)
  return LEGACY_PRODUCT_NAMES.map((name) => join(parent, name)).filter((dir) => dir !== userDataDir)
}

export function migrateAppIdentity(options: IdentityMigrationOptions): IdentityMigrationResult {
  const { userDataDir } = options
  const log = options.log ?? ((message: string) => console.log(`[IdentityMigration] ${message}`))
  const newDb = join(userDataDir, DB_FILE_NAME)
  const result: IdentityMigrationResult = { outcome: 'already-migrated', renamedInPlace: false, copied: [], failed: [] }

  mkdirSync(userDataDir, { recursive: true })

  // 1. A legacy-named database already inside the new userData.
  const inPlaceLegacyDb = join(userDataDir, LEGACY_DB_FILE_NAME)
  if (!existsSync(newDb) && existsSync(inPlaceLegacyDb)) {
    // Stale destination sidecars are kept: after an interrupted rename they
    // are this database's own -wal/-shm, already moved.
    placeDatabase((suffix) => inPlaceLegacyDb + suffix, (suffix) => newDb + suffix, renameSync, false)
    result.renamedInPlace = true
    log(`Renamed ${inPlaceLegacyDb} to ${newDb}`)
  }

  // 2. Once done, never again.
  const markerPath = join(userDataDir, IDENTITY_MIGRATION_MARKER)
  if (existsSync(markerPath)) return result

  if (existsSync(newDb)) {
    // Either this directory already had a database, or a previous launch
    // finished the copy and died before writing the marker.
    result.outcome = 'existing-database'
    writeMarker(markerPath, result)
    return result
  }

  const source = (options.legacyUserDataDirs ?? legacyUserDataDirs(userDataDir))
    .find((dir) => dir !== userDataDir && existsSync(join(dir, LEGACY_DB_FILE_NAME)))
  if (!source) {
    result.outcome = 'fresh-install'
    writeMarker(markerPath, result)
    return result
  }

  log(`Copying data from ${source} to ${userDataDir}`)
  result.outcome = 'copied'
  result.source = source
  const staging = join(userDataDir, STAGING_DIR)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  for (const entry of CARRIED_OVER_ENTRIES) {
    const from = join(source, entry)
    const to = join(userDataDir, entry)
    if (!existsSync(from) || existsSync(to)) continue
    const staged = join(staging, entry)
    try {
      cpSync(from, staged, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: false })
      rewriteGitPointers(staged, source, userDataDir)
      renameSync(staged, to)
      result.copied.push(entry)
    } catch (error) {
      // A failed directory (a full disk, a locked file) stays in the legacy
      // userData, where it is untouched. The database still moves over.
      rmSync(staged, { recursive: true, force: true })
      const message = error instanceof Error ? error.message : String(error)
      result.failed.push({ entry, error: message })
      log(`Could not copy ${from}: ${message}`)
    }
  }

  // The database last: its presence means the carry-over is complete.
  const legacyDb = join(source, LEGACY_DB_FILE_NAME)
  const stagedDb = join(staging, DB_FILE_NAME)
  placeDatabase((suffix) => legacyDb + suffix, (suffix) => stagedDb + suffix, copyFileSync, true)
  placeDatabase((suffix) => stagedDb + suffix, (suffix) => newDb + suffix, renameSync, true)
  result.copied.push(DB_FILE_NAME)

  rmSync(staging, { recursive: true, force: true })
  writeMarker(markerPath, result)
  log(`Copied ${result.copied.join(', ')}${result.failed.length ? `; failed: ${result.failed.map((f) => f.entry).join(', ')}` : ''}`)
  return result
}

/**
 * Moves or copies a database and its -wal/-shm. The sidecars go first and the
 * main file last, so an interrupted run leaves the source database in place and
 * the next run repeats the operation. With `removeStaleSidecars`, a sidecar at
 * the destination with no counterpart at the source is deleted so it cannot be
 * paired with a database it does not belong to.
 */
function placeDatabase(
  from: (suffix: string) => string,
  to: (suffix: string) => string,
  transfer: (source: string, destination: string) => void,
  removeStaleSidecars: boolean
): void {
  for (const suffix of DB_SIDECARS) {
    if (existsSync(from(suffix))) transfer(from(suffix), to(suffix))
    else if (removeStaleSidecars) rmSync(to(suffix), { force: true })
  }
  transfer(from(''), to(''))
}

/** Git keeps absolute paths in two small files; point them at the copy. */
function rewriteGitPointers(root: string, legacyRoot: string, newRoot: string): void {
  const replacements = pathVariants(legacyRoot).map((variant, index) => [variant, pathVariants(newRoot)[index]] as const)
  visitGitPointerFiles(root, 0, (file) => {
    const content = readFileSync(file, 'utf8')
    let next = content
    for (const [from, to] of replacements) next = next.split(from).join(to)
    if (next !== content) writeFileSync(file, next)
  })
}

function pathVariants(path: string): string[] {
  // Git on Windows writes forward slashes.
  return sep === '\\' ? [path, path.replace(/\\/g, '/')] : [path]
}

const MAX_GIT_POINTER_DEPTH = 6

/**
 * Finds `.git` FILES (a worktree's pointer to its repository) and
 * `worktrees/<name>/gitdir` files (the repository's pointer back). Worktrees sit
 * at `workspaces/<task>/<repo>` and bare repositories at `repos/<org>/<repo>.git`,
 * so a shallow walk that skips node_modules finds all of them.
 */
function visitGitPointerFiles(dir: string, depth: number, visit: (file: string) => void): void {
  if (depth > MAX_GIT_POINTER_DEPTH) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (stat.isFile()) {
      const isWorktreePointer = name === '.git'
      const isRepositoryPointer = name === 'gitdir' && basename(dirname(dirname(path))) === 'worktrees'
      if ((isWorktreePointer || isRepositoryPointer) && stat.size < 4096) visit(path)
    } else if (stat.isDirectory()) {
      // Inside a bare repository only worktrees/ holds pointers; skip objects/, refs/ and the rest.
      if (dir.endsWith('.git') && name !== 'worktrees') continue
      visitGitPointerFiles(path, depth + 1, visit)
    }
  }
}

function writeMarker(markerPath: string, result: IdentityMigrationResult): void {
  const temporary = `${markerPath}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2)}\n`)
  renameSync(temporary, markerPath)
}
