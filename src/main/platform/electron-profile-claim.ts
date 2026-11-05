import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { acquireProfileLock, clearTauriHolder, heldByTauri, HOST_CLAIM_TIMEOUT_MS, ProfileLockError, type ProfileLock, type ProfileLockErrorCode } from './profile-lock'

export type ElectronProfileClaim =
  | { refused: false; lock: ProfileLock; requestedRoot: string }
  /** `contained` is false when no folder could replace the profile: exit at once, before `ready`. */
  | { refused: true; message: string; contained: boolean; discardScratch(): void }

interface ElectronPaths {
  getPath(name: 'userData' | 'appData'): string
  setPath(name: 'userData' | 'sessionData', path: string): void
}

/** What the user reads when this app cannot open its profile. */
export function profileRefusalMessage(code: ProfileLockErrorCode | null, tauriHolds: boolean, appName: string): string {
  if (code === 'PROFILE_IN_USE' && tauriHolds) return `The ${appName} Production Preview (the new Tauri app) is using this profile. Quit it, then open ${appName} again. Your data was not changed.`
  if (code === 'PROFILE_IN_USE') return `Another ${appName} window is already using this profile. Switch to that window, or quit it and open ${appName} again. Your data was not changed.`
  return 'Another desktop host may already be using this profile, or its profile lock is unavailable. Close the other host and use a supported local profile directory, then try again. Your data was not changed.'
}

const canonical = (path: string): string => { try { return realpathSync.native(path) } catch { return path } }
const removeFolder = (path: string): void => { try { rmSync(path, { recursive: true, force: true }) } catch { /* Chromium may still hold files on Windows */ } }

function isInside(root: string, path: string): boolean {
  const inner = relative(root, path)
  return inner !== '..' && !inner.startsWith(`..${sep}`) && !isAbsolute(inner)
}

function defaultScratchParents(app: ElectronPaths): string[] {
  const parents = [tmpdir()]
  try { parents.push(app.getPath('appData')) } catch { /* the temp folder may still work */ }
  return parents
}

/**
 * A refused process still starts Chromium, which must not reach a profile another
 * app owns. Sets `sessionData` as well: Electron documents it only as pointing to
 * `userData` by default, not as following a later change. Returns null when no
 * folder would do, which the caller must treat as a reason to exit before `ready`.
 */
function redirectToScratch(app: ElectronPaths, profileRoot: string, parents: readonly string[]): (() => void) | null {
  const profile = canonical(profileRoot)
  for (const parent of parents) {
    if (isInside(profile, canonical(parent))) continue
    let scratch: string | undefined
    try {
      scratch = mkdtempSync(join(parent, '21x-refused-'))
      app.setPath('userData', scratch)
      app.setPath('sessionData', scratch)
      const folder = scratch
      return () => removeFolder(folder)
    } catch {
      if (scratch) removeFolder(scratch)
    }
  }
  return null
}

/**
 * Claims the profile before anything can write to it. Call this at module load,
 * ahead of the crash logger and `ready`: Chromium reads `userData` as it starts,
 * and only a pre-ready `setPath` keeps its files out of the profile. `ready` is
 * still needed to show the refusal, since Linux has no dialog before it.
 * `scratchParents` replaces the default folders a refused launch may use.
 */
export function claimElectronProfile(app: ElectronPaths, appName: string, scratchParents?: readonly string[]): ElectronProfileClaim {
  const requestedRoot = app.getPath('userData')
  try {
    const lock = acquireProfileLock(requestedRoot, { timeoutMs: HOST_CLAIM_TIMEOUT_MS })
    app.setPath('userData', lock.profileRoot)
    // A Tauri crash can leave its note behind; this app owns the profile now.
    clearTauriHolder(lock.profileRoot)
    return { refused: false, lock, requestedRoot }
  } catch (error) {
    const code = error instanceof ProfileLockError ? error.code : null
    const tauriHolds = code === 'PROFILE_IN_USE' && heldByTauri(requestedRoot)
    const discardScratch = redirectToScratch(app, requestedRoot, scratchParents ?? defaultScratchParents(app))
    return { refused: true, message: profileRefusalMessage(code, tauriHolds, appName), contained: discardScratch !== null, discardScratch: discardScratch ?? (() => {}) }
  }
}
