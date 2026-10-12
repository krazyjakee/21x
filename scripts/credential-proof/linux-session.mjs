// Own a disposable DBus session and keyring. Never lock a developer's login store.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCredentialProof, stageModules } from './run.mjs'
import { observeOwnedProcess } from './process.mjs'

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

const dbus = (path, method, ...arguments_) => command('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', path, '--method', method, ...arguments_], undefined, 2000)
// Bus ownership queries cannot auto-activate Secret Service. Never issue a
// Secret Service call before our own daemon owns the name: DBus activation can
// otherwise start a second daemon with the outer session's original XDG paths.
const bus = (method, ...arguments_) => command('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', `org.freedesktop.DBus.${method}`, ...arguments_], undefined, 1000)
const SESSION_CODES = new Set(['SESSION_COMMAND_FAILED', 'SESSION_UNAVAILABLE', 'SESSION_FOREIGN_OWNER', 'SESSION_KEY_MISMATCH', 'SESSION_NOT_LOCKED'])

async function insideSession() {
  const temporary = await mkdtemp(join(tmpdir(), '21x-secret-service-'))
  const password = Buffer.from(randomBytes(32).toString('hex'))
  const lockAccount = 't03-lock-' + randomBytes(16).toString('hex')
  const key = randomBytes(32)
  let daemon
  let daemonOwned
  let store
  let locked = false
  let lockEntryAttempted = false
  let phase = 'isolation-setup'
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
    phase = 'owned-daemon-start'
    await mkdir(join(temporary, 'runtime', 'keyring'), { mode: 0o700 })
    daemon = spawn('gnome-keyring-daemon', ['--foreground', '--components=secrets', '--unlock', '--control-directory=' + join(temporary, 'runtime', 'keyring')], { stdio: ['pipe', 'ignore', 'ignore'], env: allowed })
    daemonOwned = observeOwnedProcess(daemon)
    daemon.on('error', () => { report.daemonSpawnFailed = true })
    daemon.once('close', (code, signal) => { report.daemonExit = { code, signal: signal === 'SIGTERM' || signal === 'SIGKILL' ? signal : signal ? 'other' : null } })
    daemon.stdin.on('error', () => {})
    daemon.stdin.end(password) // Synthetic keyring password lives only in memory/private stdin.
    let collection
    report.startup = { ownerSeen: false, ownerMatchesOwnedDaemon: false, aliasSeen: false, aliasRootSeen: false, commandFailures: 0 }
    phase = 'owned-daemon-readiness'
    const startupDeadline = Date.now() + 10_000
    while (!collection && Date.now() < startupDeadline) {
      try {
        if (daemonOwned.closed()) throw new Error('SESSION_UNAVAILABLE')
        const present = await bus('NameHasOwner', 'org.freedesktop.secrets')
        if (!/\btrue\b/.test(present)) { await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); continue }
        report.startup.ownerSeen = true
        const owner = await bus('GetConnectionUnixProcessID', 'org.freedesktop.secrets')
        const ownerPid = Number(owner.match(/uint32\s+(\d+)/)?.[1])
        if (ownerPid !== daemon.pid) throw new Error('SESSION_FOREIGN_OWNER')
        report.startup.ownerMatchesOwnedDaemon = true
        const alias = await dbus('/org/freedesktop/secrets', 'org.freedesktop.Secret.Service.ReadAlias', 'default')
        collection = alias.match(/\/org\/freedesktop\/secrets\/collection\/[a-zA-Z0-9_/]+/)?.[0]
        report.startup.aliasSeen = Boolean(collection)
        report.startup.aliasRootSeen = alias.includes("'/'")
      } catch (error) {
        if (error.message === 'SESSION_FOREIGN_OWNER' || daemonOwned.closed()) throw error
        report.startup.commandFailures++
      }
      if (!collection) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    if (!collection) throw new Error('SESSION_UNAVAILABLE')
    phase = 'unlocked-conversion'
    report.unlocked = await runCredentialProof({ helper, electron, legacyBackend: 'gnome-libsecret' })
    phase = 'basic-text-conversion'
    report.basicTextLegacy = await runCredentialProof({ helper, electron, legacyBackend: 'basic_text' })

    phase = 'lock-canary-create'
    store = new modules.keys.NativeApplicationKeyStore(resolve(helper), 5000)
    lockEntryAttempted = true
    await store.create(lockAccount, key)
    const before = await store.load(lockAccount)
    if (!before.equals(key)) throw new Error('SESSION_KEY_MISMATCH')
    before.fill(0)
    phase = 'collection-lock'
    await dbus('/org/freedesktop/secrets', 'org.freedesktop.Secret.Service.Lock', `[ '${collection}' ]`)
    const property = await dbus(collection, 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Locked')
    locked = /\btrue\b/.test(property)
    if (!locked) throw new Error('SESSION_NOT_LOCKED')
    phase = 'locked-destination'
    let blocked = false
    try { const unexpected = await store.load(lockAccount); unexpected.fill(0) } catch (error) { blocked = error.code === 'KEYSTORE_NO_ACCESS' }
    report.lockedDestinationBootstrapRejected = blocked
    // An independent real Electron process must refuse locked legacy access.
    phase = 'locked-legacy'
    report.lockedLegacy = await runCredentialProof({ helper, electron, legacyBackend: 'gnome-libsecret' })
    report.lockedLegacyRejected = !report.lockedLegacy.passed && report.lockedLegacy.errorCode === 'LEGACY_UNAVAILABLE'
    phase = 'collection-unlock'
    await command('gnome-keyring-daemon', ['--unlock', '--components=secrets'], password)
    locked = false
    const reopened = await store.load(lockAccount)
    report.keySurvivedLock = reopened.equals(key)
    reopened.fill(0)
    phase = 'unavailable-destination'
    const sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS
    try {
      process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(temporary, 'absent-bus')}`
      let blocked = false
      try { const unexpected = await store.load(lockAccount); unexpected.fill(0) } catch (error) { blocked = error.code === 'KEYSTORE_NO_ACCESS' }
      report.unavailableDestinationBootstrapRejected = blocked
    } finally {
      process.env.DBUS_SESSION_BUS_ADDRESS = sessionBus
    }
    phase = 'fixture-delete'
    await store.deleteFixture(lockAccount)
    lockEntryAttempted = false
    report.fixtureKeysDeleted = true
    report.passed = report.unlocked.passed && report.basicTextLegacy.passed && report.lockedDestinationBootstrapRejected && report.lockedLegacyRejected && report.keySurvivedLock && report.unavailableDestinationBootstrapRejected
  } catch (error) {
    report.errorCode = SESSION_CODES.has(error.message) ? error.message : /^KEYSTORE_(NO_ACCESS|NO_ENTRY|ALREADY_EXISTS|INVALID_DATA|UNSUPPORTED|PROTOCOL_ERROR)$/.test(error.code) ? error.code : 'ISOLATED_SECRET_SERVICE_PROOF_FAILED'
    report.failurePhase = phase
  } finally {
    if (locked) { try { await command('gnome-keyring-daemon', ['--unlock', '--components=secrets'], password) } catch { report.cleanupFailed = true } }
    if (store && lockEntryAttempted) { try { await store.deleteFixture(lockAccount) } catch { report.cleanupFailed = true } }
    key.fill(0)
    password.fill(0)
    const stopped = !daemonOwned || await daemonOwned.stop()
    if (stopped) await rm(temporary, { recursive: true, force: true })
    else { report.temporaryProfileRetained = temporary; report.cleanupFailed = true }
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
  const child = spawn('dbus-run-session', ['--', 'xvfb-run', '--auto-servernum', process.execPath, script, '--inside-isolated-session', '--helper', resolve(helper), '--electron', resolve(electron)], { stdio: ['ignore', 'inherit', 'ignore'], env, detached: true })
  const owned = observeOwnedProcess(child, true)
  const deadline = setTimeout(async () => {
    await owned.stop()
    console.error('ISOLATED_SECRET_SERVICE_DEADLINE')
    process.exitCode = 1
  }, 150_000)
  child.on('error', () => { console.error('ISOLATED_SECRET_SERVICE_UNAVAILABLE'); process.exitCode = 1 })
  child.on('close', (code) => { clearTimeout(deadline); process.exitCode = code === 0 ? 0 : 1 })
} else {
  const report = await insideSession()
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.passed ? 0 : 1
}
