import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdProfileElsewhere, profileListing, stopOtherHosts } from '../../../test/helpers/profile-holder'
import { claimElectronProfile, type ElectronProfileClaim } from './electron-profile-claim'
import { acquireProfileLock, HOST_CLAIM_TIMEOUT_MS, PROFILE_LOCK_FILE, TAURI_HOLDER_FILE } from './profile-lock'

vi.mock('./profile-lock', async importOriginal => {
  const actual = await importOriginal<typeof import('./profile-lock')>()
  return { ...actual, acquireProfileLock: vi.fn(actual.acquireProfileLock) }
})

const roots: string[] = []
const claims: ElectronProfileClaim[] = []
const temporary = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), '21x-electron-claim-'))); roots.push(root); return root }
function start(root: string, options: { appData?: string; scratchParents?: string[]; rejectSessionData?: boolean } = {}) {
  const paths = { userData: root, sessionData: root, appData: options.appData ?? dirname(root) }
  const app = {
    getPath: (name: 'userData' | 'appData') => paths[name],
    setPath: (name: 'userData' | 'sessionData', path: string) => {
      if (name === 'sessionData' && options.rejectSessionData) throw new Error('Electron refused this path')
      paths[name] = path
    }
  }
  const claim = claimElectronProfile(app, '21x', options.scratchParents)
  claims.push(claim)
  return { claim, paths }
}
/** A path nothing can be created under, because its parent is a file. */
const unusable = () => { const file = join(temporary(), 'file'); writeFileSync(file, ''); return join(file, 'temp') }
const refusal = (claim: ElectronProfileClaim) => {
  if (!claim.refused) throw new Error('Expected a refusal')
  return claim
}

afterEach(async () => {
  vi.unstubAllEnvs()
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
    expect(refusal(claim).contained).toBe(true)
    expect(paths.userData).not.toBe(root)
    expect(paths.sessionData).toBe(paths.userData)
    expect(existsSync(paths.userData)).toBe(true)
    refusal(claim).discardScratch()
    expect(existsSync(paths.userData)).toBe(false)
  })

  it('still leaves the profile when the temp folder cannot be used', async () => {
    const root = temporary(), appData = temporary(), blocked = unusable()
    await holdProfileElsewhere(root)
    const before = profileListing(root)
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, blocked)
    const { claim, paths } = start(root, { appData })
    expect(refusal(claim).contained).toBe(true)
    expect(dirname(paths.userData)).toBe(appData)
    expect(paths.sessionData).toBe(paths.userData)
    expect(profileListing(root)).toEqual(before)
  })

  it('never uses a folder inside the profile as its scratch space', async () => {
    const root = temporary(), inner = join(root, 'inner'), outside = temporary()
    await holdProfileElsewhere(root)
    mkdirSync(inner)
    const before = profileListing(root)
    const { claim, paths } = start(root, { scratchParents: [root, inner, outside] })
    expect(refusal(claim).contained).toBe(true)
    expect(dirname(paths.userData)).toBe(outside)
    expect(profileListing(root)).toEqual(before)
  })

  it('says so when no folder can replace the profile, and writes nothing to it', async () => {
    const root = temporary()
    await holdProfileElsewhere(root, { tauri: true })
    const before = profileListing(root)
    const { claim } = start(root, { scratchParents: [unusable(), unusable()] })
    expect(refusal(claim).contained).toBe(false)
    expect(refusal(claim).message).toContain('Your data was not changed')
    refusal(claim).discardScratch()
    expect(profileListing(root)).toEqual(before)
  })

  it('removes a scratch folder Electron would not accept', async () => {
    const root = temporary(), parent = temporary()
    await holdProfileElsewhere(root)
    const { claim } = start(root, { scratchParents: [parent], rejectSessionData: true })
    expect(refusal(claim).contained).toBe(false)
    expect(readdirSync(parent)).toEqual([])
  })

  it('waits the shared claim time, so two simultaneous starts settle on one winner', () => {
    const root = temporary()
    vi.mocked(acquireProfileLock).mockClear()
    start(root)
    expect(HOST_CLAIM_TIMEOUT_MS).toBeGreaterThan(0)
    expect(acquireProfileLock).toHaveBeenCalledWith(root, { timeoutMs: HOST_CLAIM_TIMEOUT_MS })
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

  it('keeps a refused launch off the crash log, and stops one with nowhere else to go before ready', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    expect(source).toMatch(/if \(!profileClaim\.refused\) \{\s+initCrashLogger\(\)\s+\} else if \(!profileClaim\.contained\) \{/)
    const exit = source.indexOf('app.exit(1)', source.indexOf('!profileClaim.contained'))
    expect(exit).toBeGreaterThan(-1)
    expect(exit).toBeLessThan(source.indexOf('app.whenReady()'))
  })
})
