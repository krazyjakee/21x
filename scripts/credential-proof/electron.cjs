// Real Electron MAIN-process canaries. No renderer, network, database, or live profile.
const { app, safeStorage } = require('electron')
const { randomBytes, createHash } = require('node:crypto')
const { createInterface } = require('node:readline')
const { join } = require('node:path')
const { fstatSync, createReadStream } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { isAbsolute } = require('node:path')
let token
let phase = 'stdio-attest'
const frame = (value) => process.stdout.write('21X_CREDENTIAL_FRAME ' + JSON.stringify({ token, ...value }) + '\n')
const die = () => { try { frame({ ok: false, code: 'LEGACY_PROBE_FAILED', phase }) } catch {} app.exit(1) }
process.on('uncaughtException', die)
process.on('unhandledRejection', die)

const pipe = (fd) => { const kind = fstatSync(fd); return kind.isFIFO() || kind.isSocket() }
try {
  if (process.platform === 'win32') {
    const argument = process.argv.find((arg) => arg.startsWith('--credential-pipe-attestor='))
    const helper = argument?.slice('--credential-pipe-attestor='.length)
    if (!helper || !isAbsolute(helper)) throw new Error('missing pipe attestor')
    const attested = spawnSync(helper, ['--attest-private-stdio'], { stdio: ['inherit', 'inherit', 'ignore'], timeout: 5000, windowsHide: true })
    if (attested.status !== 0 || attested.error) throw new Error('private pipe attestation failed')
  } else if (!pipe(0) || !pipe(1)) throw new Error('private pipes required')
} catch { die(); return }

phase = 'profile-setup'
app.setName('21x')
app.setPath('userData', join(__dirname, 'isolated-profile'))
app.setPath('sessionData', join(__dirname, 'isolated-session'))
// Electron44 deliberately substitutes an EOF-only process.stdin on Windows.
// Read the already-attested inherited descriptor; no filesystem path is opened.
const control = process.platform === 'win32' ? createReadStream('', { fd: 0, autoClose: false }) : process.stdin
control.on('error', die)

const hash = (value) => createHash('sha256').update(value).digest('hex')
const randomCanary = () => randomBytes(32).toString('hex')
const decode = (record) => {
  if (record.source.kind === 'setting') {
    if (!record.source.value.startsWith('safeStorage:v1:')) return record.source.value
    return safeStorage.decryptString(Buffer.from(record.source.value.slice('safeStorage:v1:'.length), 'base64'))
  }
  const bytes = Buffer.from(record.source.valueBase64, 'base64')
  return record.source.interpretation === 'safeStorage' ? safeStorage.decryptString(bytes) : bytes.toString('utf8')
}

async function probe(request) {
  token = request.token
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw new Error('invalid control')
  phase = 'app-ready'
  await app.whenReady()
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend()
    : process.platform === 'darwin' ? 'macos-keychain' : 'windows-dpapi'
  // The Chromium command-line switch uses a hyphen; Electron's API reports an underscore.
  const expectedBackend = request.legacyBackend === 'gnome-libsecret' ? 'gnome_libsecret' : request.legacyBackend
  phase = 'source-protection-check'
  if (request.legacyBackend === 'basic_text') {
    if (process.platform !== 'linux' || backend !== 'basic_text') throw new Error('unexpected backend')
    // Explicit synthetic legacy-only evidence, never candidate destination policy.
    safeStorage.setUsePlainTextEncryption(true)
  }
  if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && backend !== expectedBackend) {
    frame({ ok: false, code: 'LEGACY_UNAVAILABLE', phase, backend, encryptionAvailable: false })
    app.exit(1)
    return
  }
  if (request.operation === 'verify-originals') {
    phase = 'originals-verify'
    if (!Array.isArray(request.records) || request.records.length > 16) throw new Error('invalid records')
    const verified = request.records.every((record) => hash(decode(record)) === record.expectedHash)
    frame({ ok: verified, backend, originalsVerified: verified })
    app.exit(verified ? 0 : 1)
    return
  }
  if (request.operation !== 'generate') throw new Error('invalid operation')
  phase = 'canary-generate'
  const makeBlob = (table, column, rowId, plaintext, extra = {}) => ({
    location: { table, column, rowId },
    source: { kind: 'blob', interpretation: 'safeStorage', valueBase64: safeStorage.encryptString(plaintext).toString('base64') },
    expectedHash: hash(plaintext), ...extra
  })
  const key = randomCanary()
  const connector = JSON.stringify({ type: 'oauth2', clientId: 'synthetic-client', clientSecret: randomCanary(), accessToken: randomCanary(), refreshToken: randomCanary(), expiresAt: 1_800_000_000_000, tokenType: 'Bearer', scope: null })
  const fallback = randomCanary()
  const records = [
    makeBlob('secrets', 'value', 'fixture-secret', '\uFEFF' + randomCanary() + '-雪-🔑'),
    { location: { table: 'settings', column: 'value', rowId: 'fixture_api_key' }, source: { kind: 'setting', value: 'safeStorage:v1:' + safeStorage.encryptString(key).toString('base64') }, expectedHash: hash(key) },
    makeBlob('oauth_tokens', 'access_token', 'fixture-oauth', randomCanary()),
    makeBlob('oauth_tokens', 'refresh_token', 'fixture-oauth', randomCanary()),
    makeBlob('connector_instances', 'auth', 'fixture-connector', connector, { connectorAuthType: 'oauth2' }),
    { location: { table: 'secrets', column: 'value', rowId: 'fixture-fallback' }, source: { kind: 'blob', interpretation: 'plaintext-utf8', valueBase64: Buffer.from(fallback).toString('base64') }, expectedHash: hash(fallback) }
  ]
  let rejected = 0
  phase = 'source-corruption-check'
  for (const record of records.slice(0, 5)) {
    const ciphertext = record.source.kind === 'setting' ? Buffer.from(record.source.value.slice('safeStorage:v1:'.length), 'base64') : Buffer.from(record.source.valueBase64, 'base64')
    ciphertext[0] ^= 0xff
    try { safeStorage.decryptString(ciphertext) } catch { rejected++ }
    ciphertext.fill(0)
  }
  // Plaintext is handed only to the trusted parent over its anonymous pipe.
  // Original fixtures stay encrypted/explicitly classified and are never written.
  for (const record of records) record.decoded = decode(record)
  phase = 'source-export'
  frame({ ok: true, backend, appName: app.getName(), isPackaged: app.isPackaged,
    isolatedProfile: app.getPath('userData').startsWith(__dirname),
    corruptCiphertextsRejected: rejected, phase, records })
  app.exit(0)
}

let size = 0
phase = 'control-read'
control.on('data', (chunk) => {
  size += Buffer.byteLength(chunk)
  if (size > 1_048_576) { control.destroy(); die() }
})
const input = createInterface({ input: control })
input.once('line', (line) => {
  input.close()
  try { probe(JSON.parse(line)).catch(die) } catch { die() }
})
setTimeout(die, 30_000).unref()
