import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { StringDecoder } from 'node:string_decoder'
import { observeOwnedProcess } from './process.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const SAFE_CODES = new Set(['LEGACY_UNAVAILABLE', 'LEGACY_PROBE_FAILED', 'KEYSTORE_NO_ACCESS', 'KEYSTORE_NO_ENTRY', 'KEYSTORE_ALREADY_EXISTS', 'KEYSTORE_INVALID_DATA', 'KEYSTORE_UNSUPPORTED', 'SECRET_STORE_UNAVAILABLE', 'KEYSTORE_PROTOCOL_ERROR', 'INVALID_SECRET_KEY', 'INVALID_SECRET_VALUE', 'INVALID_SECRET_CIPHERTEXT', 'INVALID_SOURCE', 'AMBIGUOUS_BLOB', 'INVALID_SOURCE_FORMAT', 'DUPLICATE_LOCATION', 'BOUNDS_EXCEEDED', 'LEGACY_DECRYPT_FAILED', 'DESTINATION_NOT_SECURE', 'DESTINATION_UNAVAILABLE', 'DESTINATION_ENCRYPT_FAILED', 'DESTINATION_VERIFY_FAILED'])
const SOURCE_PHASES = new Set(['stdio-attest', 'profile-setup', 'control-read', 'app-ready', 'source-protection-check', 'originals-verify', 'canary-generate', 'source-corruption-check', 'source-export'])
const SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EMFILE', 'ENOMEM'])
const SIGNALS = new Set(['SIGABRT', 'SIGTRAP', 'SIGSEGV', 'SIGTERM', 'SIGKILL'])

/** Low-cost transpilation of four isolated modules; no application build/addons. */
export async function stageModules(directory) {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '21x', productName: '21x', version: '0.0.0', type: 'module', main: 'electron.cjs' }))
  await mkdir(join(directory, 'isolated-profile'))
  await mkdir(join(directory, 'isolated-session'))
  for (const name of ['authenticated-secret-storage', 'native-application-key-store', 'credential-migration']) {
    const source = await readFile(join(root, `src/main/platform/${name}.ts`), 'utf8')
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    await writeFile(join(directory, `${name}.js`), output)
  }
  await writeFile(join(directory, 'electron.cjs'), await readFile(join(root, 'scripts/credential-proof/electron.cjs')))
  return {
    provider: await import(pathToFileURL(join(directory, 'authenticated-secret-storage.js')).href),
    keys: await import(pathToFileURL(join(directory, 'native-application-key-store.js')).href),
    migration: await import(pathToFileURL(join(directory, 'credential-migration.js')).href)
  }
}

function electronFrame(executable, helper, directory, request, legacyBackend, allowedEnvironment, proofOnlyLinuxNoSandbox = false) {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString('hex')
    const args = [directory]
    if (process.platform === 'win32') args.push('--credential-pipe-attestor=' + resolve(helper))
    if (process.platform === 'linux') args.push('--password-store=' + (legacyBackend === 'basic_text' ? 'basic' : 'gnome-libsecret'))
    if (process.platform === 'linux' && (process.getuid?.() === 0 || proofOnlyLinuxNoSandbox)) args.push('--no-sandbox')
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: allowedEnvironment, windowsHide: true, detached: process.platform !== 'win32' })
    const owned = observeOwnedProcess(child, process.platform !== 'win32')
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let bytes = 0
    let response
    let spawnCode
    let runtimeFailure
    let diagnosticTail = ''
    let diagnosticBytes = 0
    let privatePipeAttested = process.platform !== 'win32'
    let settled = false
    const finish = async (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.destroy()
      pending = ''
      if (error) {
        const stopped = await owned.stop()
        child.stdout.destroy()
        child.stderr.destroy()
        diagnosticTail = ''
        reject(Object.assign(new Error(error), { code: error, cleanupSafe: stopped, sourcePhase: SOURCE_PHASES.has(response?.phase) ? response.phase : 'no-frame', sourceExitCode: child.exitCode, sourceSignal: SIGNALS.has(child.signalCode) ? child.signalCode : child.signalCode ? 'other' : null, spawnCode, runtimeFailure, privatePipeAttested }))
      } else {
        child.stdout.destroy()
        child.stderr.destroy()
        diagnosticTail = ''
        resolve({ ...response, privatePipeAttested })
      }
    }
    const timer = setTimeout(() => finish('LEGACY_UNAVAILABLE'), 35_000)
    child.on('error', (error) => { spawnCode = SPAWN_CODES.has(error.code) ? error.code : 'other'; finish('LEGACY_PROBE_FAILED') })
    child.stdin.on('error', () => finish('LEGACY_PROBE_FAILED'))
    // Discard raw runtime diagnostics. Only fixed startup categories can leave
    // this private bounded classifier; no error/provider text reaches reports.
    child.stderr.on('data', (chunk) => {
      diagnosticBytes += chunk.length
      if (diagnosticBytes > 16_384) return
      diagnosticTail = (diagnosticTail + chunk.toString('utf8')).slice(-4096)
      if (/error while loading shared libraries/i.test(diagnosticTail)) runtimeFailure = 'runtime-library-missing'
      else if (/No usable sandbox|Failed to move to new namespace|SUID sandbox|Operation not permitted.*namespace|Check failed:.*sandbox|zygote_host_impl_linux/i.test(diagnosticTail)) runtimeFailure = 'runtime-sandbox-unavailable'
      else if (/Missing X server|Unable to open X display|The platform failed to initialize/i.test(diagnosticTail)) runtimeFailure = 'runtime-display-unavailable'
    })
    child.stdout.on('data', (chunk) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > 1_048_576) { finish('LEGACY_PROBE_FAILED'); return }
      pending += decoder.write(chunk)
      let newline
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line === '21X_PIPE_ATTEST {"version":1,"privatePipes":true}') { privatePipeAttested = true; continue }
        if (!line.startsWith('21X_CREDENTIAL_FRAME ')) continue
        try {
          const message = JSON.parse(line.slice('21X_CREDENTIAL_FRAME '.length))
          // Before control can be read, accept only a fixed metadata failure from
          // this owned private pipe. Successful frames always require the nonce.
          const earlyFailure = message.token === undefined && message.ok === false && message.code === 'LEGACY_PROBE_FAILED' && SOURCE_PHASES.has(message.phase)
          if (message.token !== token && !earlyFailure || response) { finish('LEGACY_PROBE_FAILED'); return }
          response = message
        } catch { finish('LEGACY_PROBE_FAILED') }
      }
    })
    child.on('close', (code) => {
      if (!response || response.ok !== true || code !== 0) finish(SAFE_CODES.has(response?.code) ? response.code : 'LEGACY_PROBE_FAILED')
      else finish()
    })
    child.stdin.end(JSON.stringify({ ...request, token, legacyBackend }) + '\n')
  })
}

function expectRejected(action, code) {
  try { action() } catch (error) { if (error.code === code) return true }
  throw Object.assign(new Error('PROOF_FAILED'), { code: 'PROOF_FAILED' })
}

export async function runCredentialProof({ helper, electron, legacyBackend = process.platform === 'linux' ? 'gnome-libsecret' : 'native' }) {
  const directory = await mkdtemp(join(tmpdir(), '21x-credential-proof-'))
  let candidate
  let reloaded
  let keys
  let created = false
  let cleanupSafe = true
  let phase = 'stage-modules'
  const account = 't03-' + randomBytes(16).toString('hex')
  const report = { reportVersion: 1, platform: process.platform, arch: process.arch, scenario: legacyBackend, passed: false }
  try {
    const modules = await stageModules(directory)
    const allowedEnvironment = modules.keys.nativeCredentialEnvironment(process.env)
    let proofOnlyLinuxNoSandbox = process.platform === 'linux' && process.getuid?.() === 0
    const legacyFrame = async (request) => {
      try { return await electronFrame(electron, helper, directory, request, legacyBackend, allowedEnvironment, proofOnlyLinuxNoSandbox) }
      catch (error) {
        // Ubuntu CI can deny Chromium namespaces through AppArmor. Retry only
        // a classified sandbox startup failure in this fixed synthetic MAIN
        // process: no renderer, arbitrary code, listener or live profile exists.
        if (process.platform !== 'linux' || proofOnlyLinuxNoSandbox || error.runtimeFailure !== 'runtime-sandbox-unavailable' || error.cleanupSafe === false) throw error
        proofOnlyLinuxNoSandbox = true
        report.proofOnlyLinuxSandboxDisabled = true
        return await electronFrame(electron, helper, directory, request, legacyBackend, allowedEnvironment, true)
      }
    }
    phase = 'legacy-generate'
    const source = await legacyFrame({ operation: 'generate' })
    report.legacy = { backend: ['windows-dpapi', 'macos-keychain', 'gnome_libsecret', 'basic_text'].includes(source.backend) ? source.backend : 'other', appName: source.appName === '21x' ? '21x' : 'other', isPackaged: source.isPackaged === true, isolatedProfile: source.isolatedProfile === true, corruptCiphertextsRejected: Number.isInteger(source.corruptCiphertextsRejected) && source.corruptCiphertextsRejected >= 0 && source.corruptCiphertextsRejected <= 5 ? source.corruptCiphertextsRejected : null, sourceRecordsValid: Array.isArray(source.records) && source.records.length === 6, privatePipeAttested: source.privatePipeAttested === true }
    if (!report.legacy.sourceRecordsValid || source.corruptCiphertextsRejected !== 5 || source.appName !== '21x' || !source.isolatedProfile) throw Object.assign(new Error('PROOF_FAILED'), { code: 'PROOF_FAILED' })
    keys = new modules.keys.NativeApplicationKeyStore(resolve(helper))
    phase = 'destination-create'
    created = true // Cleanup even if key creation succeeds but subsequent read fails.
    candidate = await modules.provider.initializeProtectedSecretStorage(keys, account, 'create')
    report.destination = { backend: await keys.backend(account), format: modules.provider.AUTHENTICATED_SECRET_FORMAT }
    phase = 'source-provenance'
    const decoded = new Map()
    const inputs = source.records.map((record) => {
      if (hash(record.decoded) !== record.expectedHash) throw Object.assign(new Error('PROOF_FAILED'), { code: 'PROOF_FAILED' })
      const value = record.source.kind === 'blob' ? Buffer.from(record.source.valueBase64, 'base64') : record.source.value
      const ciphertext = record.source.kind === 'blob' ? value : Buffer.from(value.slice('safeStorage:v1:'.length), 'base64')
      if (record.source.kind === 'setting' || record.source.interpretation === 'safeStorage') decoded.set(ciphertext.toString('base64'), record.decoded)
      return { location: record.location, source: { ...record.source, value }, connectorAuthType: record.connectorAuthType }
    })
    const originalFingerprint = hash(JSON.stringify(inputs))
    // Already decoded by the real trusted Electron exporter. This temporary
    // cache avoids hidden synchronous IPC/RPC in the migration serializer.
    const legacy = { isEncryptionAvailable: () => true, encryptString: () => { throw new Error('UNSUPPORTED') }, decryptString: (bytes) => {
      const value = decoded.get(bytes.toString('base64'))
      if (value === undefined) throw new Error('LEGACY_DECRYPT_FAILED')
      return value
    } }
    const injected = { legacy, destination: { storage: candidate, formatId: modules.provider.AUTHENTICATED_SECRET_FORMAT, persistentProtection: 'os-protected' } }
    phase = 'conversion-plan'
    const plan = modules.migration.prepareCredentialMigration(inputs, injected)
    phase = 'import-rejection-checks'
    const ambiguous = { ...inputs[0], source: { ...inputs[0].source, interpretation: undefined } }
    report.ambiguousBlobRejected = expectRejected(() => modules.migration.prepareCredentialMigration([ambiguous], injected), 'AMBIGUOUS_BLOB')
    const corrupt = { ...inputs[0], source: { ...inputs[0].source, value: Buffer.from(inputs[0].source.value) } }
    corrupt.source.value[0] ^= 0xff
    report.corruptImportRejected = expectRejected(() => modules.migration.prepareCredentialMigration([inputs[1], corrupt], injected), 'LEGACY_DECRYPT_FAILED')
    report.originalsUnchanged = hash(JSON.stringify(inputs)) === originalFingerprint
    decoded.clear()
    for (const record of source.records) delete record.decoded
    phase = 'destination-dispose'
    candidate.dispose()
    report.disposedProviderFailsClosed = expectRejected(() => candidate.isEncryptionAvailable(), 'SECRET_STORE_UNAVAILABLE')
    phase = 'destination-reload'
    reloaded = await modules.provider.initializeProtectedSecretStorage(keys, account, 'load')
    report.reloadedDestinationVerified = plan.changes.every((change, index) => hash(reloaded.decryptString(Buffer.from(change.ciphertextBase64, 'base64'))) === source.records[index].expectedHash)
    const damaged = Buffer.from(plan.changes[0].ciphertextBase64, 'base64')
    damaged[damaged.length - 1] ^= 0xff
    report.destinationTamperRejected = expectRejected(() => reloaded.decryptString(damaged), 'INVALID_SECRET_CIPHERTEXT')
    phase = 'legacy-rollback'
    const rollback = await legacyFrame({ operation: 'verify-originals', records: source.records })
    report.legacyOriginalsReopened = rollback.originalsVerified === true
    report.credentialClasses = ['secret-blob', 'provider-key-setting', 'oauth-access-refresh-blobs', 'connector-oauth-json', 'explicit-legacy-plaintext']
    report.passed = report.ambiguousBlobRejected && report.corruptImportRejected && report.originalsUnchanged && report.disposedProviderFailsClosed && report.reloadedDestinationVerified && report.destinationTamperRejected && report.legacyOriginalsReopened
  } catch (error) {
    report.errorCode = SAFE_CODES.has(error.code) ? error.code : 'PROOF_FAILED'
    report.failurePhase = phase
    if (error.sourcePhase) report.legacyFailure = { phase: error.sourcePhase, privatePipeAttested: error.privatePipeAttested, exitCode: error.sourceExitCode, signal: error.sourceSignal, spawnCode: error.spawnCode, runtimeFailure: error.runtimeFailure }
    if (error.cleanupSafe === false) cleanupSafe = false
  } finally {
    candidate?.dispose()
    reloaded?.dispose()
    if (created) {
      try { await keys.deleteFixture(account); report.fixtureKeyDeleted = true }
      catch (error) {
        report.fixtureKeyDeleted = error.code === 'KEYSTORE_NO_ENTRY'
        if (!report.fixtureKeyDeleted) { report.cleanupAccount = account; report.passed = false }
      }
    }
    if (cleanupSafe) await rm(directory, { recursive: true, force: true })
    else { report.temporaryProfileRetained = directory; report.passed = false }
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
  const helper = option('--helper')
  const electron = option('--electron')
  if (!helper || !electron) { console.error('Usage: node scripts/credential-proof/run.mjs --helper ABSOLUTE_PATH --electron ABSOLUTE_PATH [--legacy-backend gnome-libsecret|basic_text]'); process.exitCode = 1 }
  else {
    const report = await runCredentialProof({ helper, electron, legacyBackend: option('--legacy-backend') })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.passed ? 0 : 1
  }
}
