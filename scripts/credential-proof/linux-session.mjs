// Own a disposable DBus session and keyring. Never lock a developer's login store.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCredentialProof, stageModules } from './run.mjs'

const script = fileURLToPath(import.meta.url)
const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const helper = option('--helper')
const electron = option('--electron')

function command(executable, arguments_, input, timeout = 15_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, { stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('SESSION_COMMAND_FAILED')) }, timeout)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); if (stdout.length > 4096) { child.kill(); reject(new Error('SESSION_COMMAND_FAILED')) } })
    child.on('error', () => { clearTimeout(timer); reject(new Error('SESSION_COMMAND_FAILED')) })
    child.stdin.on('error', () => {})
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolvePromise(stdout); else reject(new Error('SESSION_COMMAND_FAILED')) })
    child.stdin.end(input)
  })
}

const dbus = (path, method, ...arguments_) => command('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', path, '--method', method, ...arguments_])

async function insideSession() {
  const temporary = await mkdtemp(join(tmpdir(), '21x-secret-service-'))
  const password = Buffer.from(randomBytes(32).toString('hex'))
  const lockAccount = 't03-lock-' + randomBytes(16).toString('hex')
  const key = randomBytes(32)
  let daemon
  let store
  let locked = false
  let lockEntryAttempted = false
  const report = { reportVersion: 1, platform: 'linux', arch: process.arch, isolatedDBus: true, passed: false }
  try {
    for (const [name, directory] of Object.entries({ XDG_DATA_HOME: 'data', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime' })) {
      await mkdir(join(temporary, directory), { mode: 0o700 })
      process.env[name] = join(temporary, directory)
    }
    const staged = join(temporary, 'modules')
    await mkdir(staged)
    const modules = await stageModules(staged)
    // Drop unrelated parent secrets and preload variables before any child spawn.
    const allowed = modules.keys.nativeCredentialEnvironment(process.env)
    for (const name of Object.keys(process.env)) if (!(name in allowed)) delete process.env[name]
    daemon = spawn('gnome-keyring-daemon', ['--foreground', '--components=secrets', '--unlock'], { stdio: ['pipe', 'ignore', 'ignore'], env: allowed })
    daemon.on('error', () => {})
    daemon.stdin.on('error', () => {})
    daemon.stdin.end(password) // Synthetic keyring password lives only in memory/private stdin.
    let collection
    for (let attempt = 0; attempt < 50 && !collection; attempt++) {
      try {
        const alias = await dbus('/org/freedesktop/secrets', 'org.freedesktop.Secret.Service.ReadAlias', 'default')
        collection = alias.match(/\/org\/freedesktop\/secrets\/collection\/[a-zA-Z0-9_/]+/)?.[0]
      } catch { /* Service startup may still be in progress. */ }
      if (!collection) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    if (!collection) throw new Error('SESSION_UNAVAILABLE')
    report.unlocked = await runCredentialProof({ helper, electron, legacyBackend: 'gnome-libsecret' })
    report.basicTextLegacy = await runCredentialProof({ helper, electron, legacyBackend: 'basic_text' })

    store = new modules.keys.NativeApplicationKeyStore(resolve(helper), 5000)
    lockEntryAttempted = true
    await store.create(lockAccount, key)
    const before = await store.load(lockAccount)
    if (!before.equals(key)) throw new Error('SESSION_KEY_MISMATCH')
    before.fill(0)
    await dbus('/org/freedesktop/secrets', 'org.freedesktop.Secret.Service.Lock', `[ '${collection}' ]`)
    const property = await dbus(collection, 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Locked')
    locked = /\btrue\b/.test(property)
    if (!locked) throw new Error('SESSION_NOT_LOCKED')
    let blocked = false
    try { const unexpected = await store.load(lockAccount); unexpected.fill(0) } catch (error) { blocked = error.code === 'KEYSTORE_NO_ACCESS' }
    report.lockedDestinationBootstrapRejected = blocked
    // An independent real Electron process must refuse locked legacy access.
    report.lockedLegacy = await runCredentialProof({ helper, electron, legacyBackend: 'gnome-libsecret' })
    report.lockedLegacyRejected = !report.lockedLegacy.passed && report.lockedLegacy.errorCode === 'LEGACY_UNAVAILABLE'
    await command('gnome-keyring-daemon', ['--unlock', '--components=secrets'], password)
    locked = false
    const reopened = await store.load(lockAccount)
    report.keySurvivedLock = reopened.equals(key)
    reopened.fill(0)
    const sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS
    try {
      process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(temporary, 'absent-bus')}`
      let blocked = false
      try { const unexpected = await store.load(lockAccount); unexpected.fill(0) } catch (error) { blocked = error.code === 'KEYSTORE_NO_ACCESS' }
      report.unavailableDestinationBootstrapRejected = blocked
    } finally {
      process.env.DBUS_SESSION_BUS_ADDRESS = sessionBus
    }
    await store.deleteFixture(lockAccount)
    lockEntryAttempted = false
    report.fixtureKeysDeleted = true
    report.passed = report.unlocked.passed && report.basicTextLegacy.passed && report.lockedDestinationBootstrapRejected && report.lockedLegacyRejected && report.keySurvivedLock && report.unavailableDestinationBootstrapRejected
  } catch {
    report.errorCode = 'ISOLATED_SECRET_SERVICE_PROOF_FAILED'
  } finally {
    if (locked) { try { await command('gnome-keyring-daemon', ['--unlock', '--components=secrets'], password) } catch { report.cleanupFailed = true } }
    if (store && lockEntryAttempted) { try { await store.deleteFixture(lockAccount) } catch { report.cleanupFailed = true } }
    key.fill(0)
    password.fill(0)
    if (daemon) {
      const stopped = new Promise((resolvePromise) => { if (daemon.exitCode !== null) resolvePromise(); else daemon.once('close', resolvePromise) })
      daemon.kill()
      await Promise.race([stopped, new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))])
      if (daemon.exitCode === null) daemon.kill('SIGKILL')
    }
    await rm(temporary, { recursive: true, force: true })
    if (report.cleanupFailed) report.passed = false
  }
  return report
}

if (process.platform !== 'linux' || !helper || !electron) {
  console.error('Usage on Linux: node scripts/credential-proof/linux-session.mjs --helper ABSOLUTE_PATH --electron ABSOLUTE_PATH')
  process.exitCode = 1
} else if (!args.includes('--inside-isolated-session')) {
  // Owned DBus/display subprocess lifecycle, with no keyring password in args/env.
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
  const env = Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]))
  const child = spawn('dbus-run-session', ['--', 'xvfb-run', '--auto-servernum', process.execPath, script, '--inside-isolated-session', '--helper', resolve(helper), '--electron', resolve(electron)], { stdio: ['ignore', 'inherit', 'ignore'], env })
  child.on('error', () => { console.error('ISOLATED_SECRET_SERVICE_UNAVAILABLE'); process.exitCode = 1 })
  child.on('close', (code) => { process.exitCode = code === 0 ? 0 : 1 })
} else {
  const report = await insideSession()
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.passed ? 0 : 1
}
