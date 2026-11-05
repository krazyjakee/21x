import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireProfileLock, clearTauriHolder, heldByTauri, HOST_CLAIM_TIMEOUT_MS, ProfileLockError, type ProfileLock, type ProfileLockErrorCode } from './profile-lock'

export type ElectronProfileClaim =
  | { refused: false; lock: ProfileLock; requestedRoot: string }
  | { refused: true; message: string; discardScratch(): void }

interface ElectronPaths {
  getPath(name: 'userData'): string
  setPath(name: 'userData', path: string): void
}

/** What the user reads when this app cannot open its profile. */
export function profileRefusalMessage(code: ProfileLockErrorCode | null, tauriHolds: boolean, appName: string): string {
  if (code === 'PROFILE_IN_USE' && tauriHolds) return `The ${appName} Production Preview (the new Tauri app) is using this profile. Quit it, then open ${appName} again. Your data was not changed.`
  if (code === 'PROFILE_IN_USE') return `Another ${appName} window is already using this profile. Switch to that window, or quit it and open ${appName} again. Your data was not changed.`
  return 'Another desktop host may already be using this profile, or its profile lock is unavailable. Close the other host and use a supported local profile directory, then try again. Your data was not changed.'
}

/** A refused process still starts Chromium and the crash log: neither may reach a profile another app owns. */
function redirectToScratch(app: ElectronPaths): () => void {
  try {
    const scratch = mkdtempSync(join(tmpdir(), '21x-refused-'))
    app.setPath('userData', scratch)
    return () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* Chromium may still hold files on Windows */ } }
  } catch {
    return () => {}
  }
}

/**
 * Claims the profile before anything can write to it. Call this at module load,
 * ahead of the crash logger and `ready`: Chromium reads `userData` as it starts,
 * and only a pre-ready `setPath` keeps its files out of the profile. `ready` is
 * still needed to show the refusal, since Linux has no dialog before it.
 */
export function claimElectronProfile(app: ElectronPaths, appName: string): ElectronProfileClaim {
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
    return { refused: true, message: profileRefusalMessage(code, tauriHolds, appName), discardScratch: redirectToScratch(app) }
  }
}
