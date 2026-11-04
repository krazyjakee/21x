import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { holdProfileElsewhere, profileListing, stopOtherHosts } from '../../../test/helpers/profile-holder'
import { claimElectronProfile, type ElectronProfileClaim } from './electron-profile-claim'
import { PROFILE_LOCK_FILE, TAURI_HOLDER_FILE } from './profile-lock'

const roots: string[] = []
const claims: ElectronProfileClaim[] = []
const temporary = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), '21x-electron-claim-'))); roots.push(root); return root }
function start(root: string) {
  const paths = { userData: root }
  const app = { getPath: () => paths.userData, setPath: (_name: 'userData', path: string) => { paths.userData = path } }
  const claim = claimElectronProfile(app, '21x')
  claims.push(claim)
  return { claim, paths }
}
const refusal = (claim: ElectronProfileClaim) => {
  if (!claim.refused) throw new Error('Expected a refusal')
  return claim
}

afterEach(async () => {
  await stopOtherHosts()
  for (const claim of claims.splice(0)) { if (claim.refused) claim.discardScratch(); else claim.lock.release() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the Electron app claiming its profile', () => {
  it('owns a free profile and keeps using it', () => {
    const root = temporary()
    const { claim, paths } = start(root)
    if (claim.refused) throw new Error(claim.message)
    claim.lock.assertHeld()
    expect(claim.requestedRoot).toBe(root)
    expect(paths.userData).toBe(root)
  })

  it('refuses while the Tauri app holds the profile, says so, and writes nothing to it', async () => {
    const root = temporary()
    writeFileSync(join(root, '21x.db'), 'synthetic')
    await holdProfileElsewhere(root, { tauri: true })
    const before = profileListing(root)
    const { claim, paths } = start(root)
    expect(refusal(claim).message).toBe('The 21x Production Preview (the new Tauri app) is using this profile. Quit it, then open 21x again. Your data was not changed.')
    expect(profileListing(root)).toEqual(before)
    expect(paths.userData).not.toBe(root)
  })

  it('points a refused process away from the profile, then discards that folder', async () => {
    const root = temporary()
    await holdProfileElsewhere(root)
    const { claim, paths } = start(root)
    expect(existsSync(paths.userData)).toBe(true)
    refusal(claim).discardScratch()
    expect(existsSync(paths.userData)).toBe(false)
  })

  it('keeps refusing a second Electron launch, as today, and says which app', async () => {
    const root = temporary()
    await holdProfileElsewhere(root)
    expect(refusal(start(root).claim).message).toBe('Another 21x window is already using this profile. Switch to that window, or quit it and open 21x again. Your data was not changed.')
  })

  it('starts after the Tauri app crashes, and clears the note it left', async () => {
    const root = temporary()
    await (await holdProfileElsewhere(root, { tauri: true })).crash()
    expect(existsSync(join(root, TAURI_HOLDER_FILE))).toBe(true)
    const { claim } = start(root)
    expect(claim.refused).toBe(false)
    expect(existsSync(join(root, TAURI_HOLDER_FILE))).toBe(false)
  })

  it('is not refused for a copied profile, even one copied mid-session with its lock files and note', async () => {
    const root = temporary(), copy = join(temporary(), 'copied')
    await holdProfileElsewhere(root, { tauri: true })
    cpSync(root, copy, { recursive: true })
    expect(start(copy).claim.refused).toBe(false)
  })

  it('names no app when the lock itself is unusable', () => {
    const root = temporary(), target = join(temporary(), 'target')
    writeFileSync(target, 'untouched')
    symlinkSync(target, join(root, PROFILE_LOCK_FILE))
    const { message } = refusal(start(root).claim)
    expect(message).toContain('its profile lock is unavailable')
    expect(message).not.toContain('Tauri')
    expect(readFileSync(target, 'utf8')).toBe('untouched')
  })

  it('runs in main before the crash log and before ready', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    const claim = source.indexOf('claimElectronProfile(app')
    expect(claim).toBeGreaterThan(-1)
    expect(claim).toBeLessThan(source.indexOf('initCrashLogger()'))
    expect(claim).toBeLessThan(source.indexOf('app.whenReady()'))
  })
})
