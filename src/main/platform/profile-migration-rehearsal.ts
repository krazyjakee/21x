import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ProfileLock } from './profile-lock'
import { CredentialMigrationError, prepareCredentialMigration, type CredentialLocation, type CredentialMigrationProviders, type LegacyCredentialInput } from './credential-migration'

export const REHEARSAL_MAX_BYTES = 8 * 1024 * 1024
const CHUNK_BYTES = 512 * 1024
const MARKER = '.21x-migration-rehearsal.json'
const OUTPUT = 'credential-import-rehearsal'
const BACKUP = 'original.sqlite.enc'
const CANDIDATE = 'candidate.sqlite'
const JOURNAL = 'journal.enc'
const SETTING_PREFIX = '21x-credential:'
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const keyOf = (location: CredentialLocation) => JSON.stringify([location.table, location.rowId, location.column])

export type RehearsalErrorCode = 'REHEARSAL_SCOPE_INVALID' | 'REHEARSAL_LOCK_INVALID' | 'REHEARSAL_SOURCE_BUSY' | 'REHEARSAL_SOURCE_INVALID' | 'REHEARSAL_BOUNDS_EXCEEDED' | 'REHEARSAL_COVERAGE_INCOMPLETE' | 'REHEARSAL_PROVIDER_UNAVAILABLE' | 'REHEARSAL_SNAPSHOT_CORRUPT' | 'REHEARSAL_STATE_CONFLICT' | 'REHEARSAL_RESOURCE_CHANGED' | 'REHEARSAL_PRESERVATION_FAILED' | 'REHEARSAL_INTERRUPTED' | 'REHEARSAL_ROLLBACK_PLAINTEXT' | 'REHEARSAL_IO_FAILED'
export class ProfileMigrationRehearsalError extends Error {
  constructor(readonly code: RehearsalErrorCode) { super(code); this.name = 'ProfileMigrationRehearsalError' }
}
const fail = (code: RehearsalErrorCode): never => { throw new ProfileMigrationRehearsalError(code) }

export type RehearsalBoundary = 'backup-published' | 'journal-prepared' | 'candidate-written' | 'journal-ready' | 'candidate-published' | 'journal-committed'
export interface RehearsalOptions {
  readonly lock: ProfileLock
  readonly providers: CredentialMigrationProviders
  /** Each BLOB needs trusted source provenance, never a ciphertext guess. */
  readonly blobInterpretations: readonly { location: CredentialLocation; interpretation: 'safeStorage' | 'plaintext-utf8' }[]
  /** Explicit fixture resources; no external path or live-profile discovery. */
  readonly resourcePaths?: readonly string[]
  readonly maxBytes?: number
  /** Deterministic rehearsal fault injection; never used by shipping bootstrap. */
  readonly interruptAfter?: RehearsalBoundary
}
interface Resource { path: string; bytes: number; sha256: string }
interface SnapshotManifest { type: 'original-sqlite-snapshot'; version: 1; fixtureId: string; snapshotId: string; format: string; bytes: number; sha256: string; chunks: number; resources: Resource[] }
interface Capsule { version: 1; manifest: string; chunks: string[] }
interface Journal { type: 'credential-import-rehearsal'; version: 1; fixtureId: string; snapshotId: string; backupHash: string; sourceHash: string; format: string; state: 'prepared' | 'candidate-ready' | 'committed'; candidateHash: string | null; preservedHash: string }
interface Context { root: string; output: string; source: string; fixtureId: string; maxBytes: number; options: RehearsalOptions }
export interface RehearsalResult { readonly state: 'committed'; readonly candidatePath: string; readonly encryptedOriginalPath: string; readonly recovered: boolean; readonly credentialChanges: number }

/** Creates only an owned fixture directory under canonical OS temp. No DB/copy/discovery. */
export function createProfileMigrationFixture(scope: 'synthetic' | 'copied-fixture' = 'synthetic'): string {
  if (scope !== 'synthetic' && scope !== 'copied-fixture') fail('REHEARSAL_SCOPE_INVALID')
  const parent = realpathSync.native(tmpdir())
  const root = mkdtempSync(join(parent, '21x-migration-rehearsal-'))
  writeFileSync(join(root, MARKER), JSON.stringify({ version: 1, scope, fixtureId: randomBytes(16).toString('hex') }), { flag: 'wx', mode: 0o600 })
  return root
}

function regular(path: string): void {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) fail('REHEARSAL_SCOPE_INVALID')
}
function boundedRead(path: string, limit: number): Buffer {
  regular(path)
  if (statSync(path).size > limit) fail('REHEARSAL_BOUNDS_EXCEEDED')
  const bytes = readFileSync(path)
  if (bytes.length > limit) { bytes.fill(0); fail('REHEARSAL_BOUNDS_EXCEEDED') }
  return bytes
}
function context(options: RehearsalOptions): Context {
  try { options.lock.assertHeld() } catch { fail('REHEARSAL_LOCK_INVALID') }
  const root = options.lock.profileRoot
  const maxBytes = options.maxBytes ?? REHEARSAL_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > REHEARSAL_MAX_BYTES) fail('REHEARSAL_BOUNDS_EXCEEDED')
  if (!isAbsolute(root) || realpathSync.native(root) !== root || dirname(root) !== realpathSync.native(tmpdir()) || !/^21x-migration-rehearsal-[a-zA-Z0-9_-]+$/.test(basename(root))) fail('REHEARSAL_SCOPE_INVALID')
  const markerBytes = boundedRead(join(root, MARKER), 512)
  let marker: { version?: unknown; scope?: unknown; fixtureId?: unknown }
  try { marker = JSON.parse(markerBytes.toString('utf8')) } catch { fail('REHEARSAL_SCOPE_INVALID') }
  if (marker.version !== 1 || marker.scope !== 'synthetic' && marker.scope !== 'copied-fixture' || typeof marker.fixtureId !== 'string' || !/^[0-9a-f]{32}$/.test(marker.fixtureId)) fail('REHEARSAL_SCOPE_INVALID')
  const output = join(root, OUTPUT)
  if (existsSync(output) && (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink())) fail('REHEARSAL_SCOPE_INVALID')
  if (!existsSync(output)) mkdirSync(output, { mode: 0o700 })
  const source = join(root, '21x.db')
  regular(source)
  return { root, output, source, fixtureId: marker.fixtureId, maxBytes, options }
}
function held(ctx: Context): void {
  try { ctx.options.lock.assertHeld() } catch { fail('REHEARSAL_LOCK_INVALID') }
  if (realpathSync.native(ctx.root) !== ctx.root || realpathSync.native(ctx.output) !== ctx.output) fail('REHEARSAL_SCOPE_INVALID')
}
function fileIdentity(path: string): string {
  const file = statSync(path, { bigint: true })
  return `${file.dev}:${file.ino}`
}
function secureResource(ctx: Context, path: string): string {
  if (typeof path !== 'string' || !path || path.length > 512 || isAbsolute(path) || path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') || path === MARKER || path.startsWith(OUTPUT + '/')) fail('REHEARSAL_SCOPE_INVALID')
  const target = join(ctx.root, path)
  if (relative(ctx.root, target).startsWith('..' + sep)) fail('REHEARSAL_SCOPE_INVALID')
  let cursor = ctx.root
  for (const part of path.split(/[\\/]/)) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) fail('REHEARSAL_SCOPE_INVALID') }
  regular(target)
  return target
}
function captureResources(ctx: Context): Resource[] {
  const paths = ctx.options.resourcePaths ?? []
  if (!Array.isArray(paths) || paths.length > 256 || new Set(paths).size !== paths.length) fail('REHEARSAL_BOUNDS_EXCEEDED')
  let bytes = 0
  return [...paths].sort().map((path) => {
    const data = boundedRead(secureResource(ctx, path), ctx.maxBytes)
    try { bytes += data.length; if (bytes > ctx.maxBytes) fail('REHEARSAL_BOUNDS_EXCEEDED'); return { path, bytes: data.length, sha256: hash(data) } }
    finally { data.fill(0) }
  })
}
function verifyResources(ctx: Context, expected: Resource[]): void {
  const actual = captureResources(ctx)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('REHEARSAL_RESOURCE_CHANGED')
}
function provider(ctx: Context) {
  const destination = ctx.options.providers?.destination
  try {
    if (!destination || destination.persistentProtection !== 'os-protected' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(destination.formatId) || !destination.storage.isEncryptionAvailable()) fail('REHEARSAL_PROVIDER_UNAVAILABLE')
  } catch { fail('REHEARSAL_PROVIDER_UNAVAILABLE') }
  return destination!
}
function encrypt(ctx: Context, value: string): Buffer {
  const storage = provider(ctx).storage
  try {
    const cipher = storage.encryptString(value)
    if (!Buffer.isBuffer(cipher) || !cipher.length || cipher.equals(Buffer.from(value)) || storage.decryptString(Buffer.from(cipher)) !== value) fail('REHEARSAL_PROVIDER_UNAVAILABLE')
    return Buffer.from(cipher)
  } catch { fail('REHEARSAL_PROVIDER_UNAVAILABLE') }
}
function decrypt(ctx: Context, value: Buffer): string {
  try { return provider(ctx).storage.decryptString(value) } catch { fail('REHEARSAL_SNAPSHOT_CORRUPT') }
}
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return // Node cannot fsync a directory handle here; power-loss guarantees remain a platform gate.
  const fd = openSync(directory, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function writeExclusive(path: string, bytes: Buffer): void {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}
function removePending(path: string): void { if (existsSync(path)) { regular(path); unlinkSync(path) } }
function writeJournal(ctx: Context, journal: Journal): void {
  held(ctx)
  const bytes = encrypt(ctx, JSON.stringify(journal))
  const target = join(ctx.output, JOURNAL)
  const pending = target + '.next'
  try {
    removePending(pending)
    writeExclusive(pending, bytes)
    if (existsSync(target)) regular(target)
    renameSync(pending, target)
    syncDirectory(ctx.output)
  } finally { bytes.fill(0) }
}
function boundary(ctx: Context, stage: RehearsalBoundary): void {
  if (ctx.options.interruptAfter === stage) fail('REHEARSAL_INTERRUPTED')
}

function createCapsule(ctx: Context, snapshot: Buffer, resources: Resource[]): { bytes: Buffer; manifest: SnapshotManifest } {
  const snapshotId = randomBytes(16).toString('hex')
  const chunks = Math.ceil(snapshot.length / CHUNK_BYTES)
  const manifest: SnapshotManifest = { type: 'original-sqlite-snapshot', version: 1, fixtureId: ctx.fixtureId, snapshotId, format: provider(ctx).formatId, bytes: snapshot.length, sha256: hash(snapshot), chunks, resources }
  const encrypted: string[] = []
  for (let index = 0; index < chunks; index++) {
    const bytes = encrypt(ctx, JSON.stringify({ type: 'sqlite-snapshot-chunk', version: 1, fixtureId: ctx.fixtureId, snapshotId, index, chunks, data: snapshot.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64') }))
    try { encrypted.push(bytes.toString('base64')) } finally { bytes.fill(0) }
  }
  const encryptedManifest = encrypt(ctx, JSON.stringify(manifest))
  try { return { bytes: Buffer.from(JSON.stringify({ version: 1, manifest: encryptedManifest.toString('base64'), chunks: encrypted })), manifest } }
  finally { encryptedManifest.fill(0) }
}
function fromBase64(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || !value || value.length > limit * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('REHEARSAL_SNAPSHOT_CORRUPT')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > limit || bytes.toString('base64') !== value) { bytes.fill(0); fail('REHEARSAL_SNAPSHOT_CORRUPT') }
  return bytes
}
function readCapsule(ctx: Context): { snapshot: Buffer; manifest: SnapshotManifest; backupHash: string } {
  const encoded = boundedRead(join(ctx.output, BACKUP), ctx.maxBytes * 2 + 262144)
  const parts: Buffer[] = []
  try {
    const capsule = JSON.parse(encoded.toString('utf8')) as Capsule
    if (capsule.version !== 1 || !Array.isArray(capsule.chunks) || capsule.chunks.length < 1 || capsule.chunks.length > Math.ceil(ctx.maxBytes / CHUNK_BYTES)) fail('REHEARSAL_SNAPSHOT_CORRUPT')
    const manifestCipher = fromBase64(capsule.manifest, CHUNK_BYTES * 2)
    let manifest: SnapshotManifest
    try { manifest = JSON.parse(decrypt(ctx, manifestCipher)) } finally { manifestCipher.fill(0) }
    if (manifest.type !== 'original-sqlite-snapshot' || manifest.version !== 1 || manifest.fixtureId !== ctx.fixtureId || !/^[0-9a-f]{32}$/.test(manifest.snapshotId) || manifest.format !== provider(ctx).formatId || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 4096 || manifest.bytes > ctx.maxBytes || !/^[0-9a-f]{64}$/.test(manifest.sha256) || manifest.chunks !== capsule.chunks.length || !Array.isArray(manifest.resources) || manifest.resources.length > 256) fail('REHEARSAL_SNAPSHOT_CORRUPT')
    for (const [index, value] of capsule.chunks.entries()) {
      const cipher = fromBase64(value, CHUNK_BYTES * 2)
      let chunk: { type: string; version: number; fixtureId: string; snapshotId: string; index: number; chunks: number; data: string }
      try { chunk = JSON.parse(decrypt(ctx, cipher)) } finally { cipher.fill(0) }
      if (chunk.type !== 'sqlite-snapshot-chunk' || chunk.version !== 1 || chunk.fixtureId !== ctx.fixtureId || chunk.snapshotId !== manifest.snapshotId || chunk.index !== index || chunk.chunks !== manifest.chunks) fail('REHEARSAL_SNAPSHOT_CORRUPT')
      parts.push(fromBase64(chunk.data, CHUNK_BYTES))
    }
    const snapshot = Buffer.concat(parts)
    if (snapshot.length !== manifest.bytes || hash(snapshot) !== manifest.sha256) { snapshot.fill(0); fail('REHEARSAL_SNAPSHOT_CORRUPT') }
    return { snapshot, manifest, backupHash: hash(encoded) }
  } catch (error) {
    if (error instanceof ProfileMigrationRehearsalError) throw error
    fail('REHEARSAL_SNAPSHOT_CORRUPT')
  } finally { for (const part of parts) part.fill(0); encoded.fill(0) }
}

function integrity(db: Database.Database): void {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) fail('REHEARSAL_SOURCE_INVALID')
}
function parseObject(value: unknown): Record<string, unknown> {
  try { const object = JSON.parse(String(value)); if (object && typeof object === 'object' && !Array.isArray(object)) return object } catch { /* fixed error below */ }
  fail('REHEARSAL_COVERAGE_INCOMPLETE')
}
function inputs(db: Database.Database, options: RehearsalOptions): LegacyCredentialInput[] {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]).map((row) => row.name))
  for (const table of ['secrets', 'settings', 'oauth_tokens', 'connector_instances']) if (!tables.has(table)) fail('REHEARSAL_COVERAGE_INCOMPLETE')
  // Unsupported known plaintext-bearing configurations cannot be copied into
  // a supposedly converted candidate. This harness does not sweep typed JSON.
  if (tables.has('agents')) for (const row of db.prepare('SELECT config FROM agents').all() as { config: string }[]) {
    const config = parseObject(row.config)
    if (config.api_keys != null && Object.keys(parseObject(JSON.stringify(config.api_keys))).length) fail('REHEARSAL_COVERAGE_INCOMPLETE')
  }
  if (tables.has('mcp_servers')) for (const row of db.prepare('SELECT headers, environment FROM mcp_servers').all() as { headers: string; environment: string }[]) {
    if (Object.keys(parseObject(row.headers)).length || Object.keys(parseObject(row.environment)).length) fail('REHEARSAL_COVERAGE_INCOMPLETE')
  }
  const provenance = new Map<string, 'safeStorage' | 'plaintext-utf8'>()
  if (!Array.isArray(options.blobInterpretations) || options.blobInterpretations.length > 10000) fail('REHEARSAL_COVERAGE_INCOMPLETE')
  for (const entry of options.blobInterpretations) {
    const key = keyOf(entry.location)
    if (provenance.has(key) || entry.interpretation !== 'safeStorage' && entry.interpretation !== 'plaintext-utf8') fail('REHEARSAL_COVERAGE_INCOMPLETE')
    provenance.set(key, entry.interpretation)
  }
  const result: LegacyCredentialInput[] = []
  const blob = (location: CredentialLocation, value: unknown, authType?: LegacyCredentialInput['connectorAuthType']) => {
    const key = keyOf(location)
    const interpretation = provenance.get(key)
    if (!Buffer.isBuffer(value) || !interpretation) fail('REHEARSAL_COVERAGE_INCOMPLETE')
    provenance.delete(key)
    result.push({ location, source: { kind: 'blob', value: value as Buffer, interpretation }, connectorAuthType: authType })
  }
  for (const row of db.prepare('SELECT id, value FROM secrets ORDER BY id').all() as { id: string; value: Buffer }[]) blob({ table: 'secrets', rowId: row.id, column: 'value' }, row.value)
  for (const row of db.prepare("SELECT key, value FROM settings WHERE substr(key,-8)='_api_key' AND value<>'' ORDER BY key").all() as { key: string; value: string }[]) result.push({ location: { table: 'settings', rowId: row.key, column: 'value' }, source: { kind: 'setting', value: row.value } })
  for (const row of db.prepare('SELECT id, access_token, refresh_token FROM oauth_tokens ORDER BY id').all() as { id: string; access_token: Buffer; refresh_token: Buffer | null }[]) {
    blob({ table: 'oauth_tokens', rowId: row.id, column: 'access_token' }, row.access_token)
    if (row.refresh_token !== null) blob({ table: 'oauth_tokens', rowId: row.id, column: 'refresh_token' }, row.refresh_token)
  }
  for (const row of db.prepare('SELECT id, auth, auth_type, config FROM connector_instances ORDER BY id').all() as { id: string; auth: Buffer | null; auth_type: LegacyCredentialInput['connectorAuthType']; config: string }[]) {
    if (Object.keys(parseObject(row.config)).length) fail('REHEARSAL_COVERAGE_INCOMPLETE')
    if (row.auth !== null) blob({ table: 'connector_instances', rowId: row.id, column: 'auth' }, row.auth, row.auth_type)
  }
  if (provenance.size) fail('REHEARSAL_COVERAGE_INCOMPLETE')
  return result
}
function preservedHash(db: Database.Database, locations: readonly CredentialLocation[]): string {
  const excluded = new Set(locations.map(keyOf))
  const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]
  const digest = createHash('sha256')
  for (const table of tables) {
    let rows: Record<string, unknown>[]
    try { rows = db.prepare(`SELECT rowid AS __rehearsal_rowid__, * FROM ${quote(table.name)}`).safeIntegers().all() as Record<string, unknown>[] }
    catch { rows = db.prepare(`SELECT * FROM ${quote(table.name)}`).safeIntegers().all() as Record<string, unknown>[] }
    const serialized = rows.map((row) => {
      const id = String(table.name === 'settings' ? row.key : row.id)
      return JSON.stringify(Object.entries(row).filter(([column]) => !excluded.has(JSON.stringify([table.name, id, column]))), (_key, value) => typeof value === 'bigint' ? { integer: value.toString() } : value)
    }).sort()
    digest.update(JSON.stringify([table.name, table.sql, serialized]))
  }
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
  digest.update(JSON.stringify(schema))
  digest.update(JSON.stringify([db.pragma('user_version', { simple: true }), db.pragma('application_id', { simple: true })]))
  return digest.digest('hex')
}
function applyCandidate(ctx: Context, snapshot: Buffer): { bytes: Buffer; changes: number; preserved: string } {
  const db = new Database(snapshot)
  try {
    db.pragma('temp_store=MEMORY')
    db.pragma('secure_delete=ON')
    db.pragma('foreign_keys=ON')
    integrity(db)
    const sourceInputs = inputs(db, ctx.options)
    const plan = prepareCredentialMigration(sourceInputs, ctx.options.providers)
    const locations = plan.changes.map((change) => change.location)
    const preserved = preservedHash(db, locations)
    db.transaction(() => {
      for (const change of plan.changes) {
        const location = change.location
        const keyColumn = location.table === 'settings' ? 'key' : 'id'
        const bytes = Buffer.from(change.ciphertextBase64, 'base64')
        try {
          const value = location.table === 'settings' ? SETTING_PREFIX + plan.destinationFormat + ':' + change.ciphertextBase64 : bytes
          const update = db.prepare(`UPDATE ${quote(location.table)} SET ${quote(location.column)}=? WHERE ${quote(keyColumn)}=?`).run(value, location.rowId)
          if (update.changes !== 1) fail('REHEARSAL_PRESERVATION_FAILED')
        } finally { bytes.fill(0) }
      }
      integrity(db)
      if (preservedHash(db, locations) !== preserved) fail('REHEARSAL_PRESERVATION_FAILED')
    }).immediate()
    // Plaintext legacy values must not survive in SQLite's freed cells/pages.
    // Normalize only in RAM; reject any profile whose row identities change.
    db.exec('VACUUM')
    integrity(db)
    if (preservedHash(db, locations) !== preserved) fail('REHEARSAL_PRESERVATION_FAILED')
    const bytes = db.serialize()
    if (bytes.length > ctx.maxBytes) { bytes.fill(0); fail('REHEARSAL_BOUNDS_EXCEEDED') }
    return { bytes, changes: plan.changes.length, preserved }
  } finally { db.close() }
}
function readJournal(ctx: Context, manifest: SnapshotManifest, backupHash: string): Journal | undefined {
  const path = join(ctx.output, JOURNAL)
  if (!existsSync(path)) return undefined
  const encrypted = boundedRead(path, 262144)
  try {
    const value = JSON.parse(decrypt(ctx, encrypted)) as Journal
    if (value.type !== 'credential-import-rehearsal' || value.version !== 1 || value.fixtureId !== ctx.fixtureId || value.snapshotId !== manifest.snapshotId || value.backupHash !== backupHash || value.sourceHash !== manifest.sha256 || value.format !== manifest.format || !['prepared', 'candidate-ready', 'committed'].includes(value.state) || !/^[0-9a-f]{64}$/.test(value.preservedHash) || value.state === 'prepared' && value.candidateHash !== null || value.state !== 'prepared' && (typeof value.candidateHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.candidateHash))) fail('REHEARSAL_STATE_CONFLICT')
    return value
  } catch (error) { if (error instanceof ProfileMigrationRehearsalError) throw error; fail('REHEARSAL_STATE_CONFLICT') }
  finally { encrypted.fill(0) }
}
function validateCandidate(ctx: Context, path: string, expectedHash: string, expectedPreserved: string, locations: readonly CredentialLocation[]): void {
  const bytes = boundedRead(path, ctx.maxBytes)
  try {
    if (hash(bytes) !== expectedHash) fail('REHEARSAL_STATE_CONFLICT')
    const db = new Database(bytes)
    try { integrity(db); if (preservedHash(db, locations) !== expectedPreserved) fail('REHEARSAL_PRESERVATION_FAILED') }
    finally { db.close() }
  } finally { bytes.fill(0) }
}

/** Rehearsal-only candidate commit. Original DB and resource files are never replaced. */
export function rehearseProfileCredentialImport(options: RehearsalOptions): RehearsalResult {
  let source: Database.Database | undefined
  let snapshot: Buffer | undefined
  try {
    const ctx = context(options)
    held(ctx)
    provider(ctx)
    const sourceIdentity = fileIdentity(ctx.source)
    const sourceHeld = () => { held(ctx); regular(ctx.source); if (fileIdentity(ctx.source) !== sourceIdentity) fail('REHEARSAL_SOURCE_BUSY') }
    source = new Database(ctx.source, { fileMustExist: true, timeout: 0 })
    source.pragma('temp_store=MEMORY')
    source.pragma('foreign_keys=ON')
    if (source.pragma('journal_mode', { simple: true }) === 'wal') {
      const checkpoint = source.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[]
      if (checkpoint.length !== 1 || checkpoint[0].busy !== 0 || checkpoint[0].log !== 0) fail('REHEARSAL_SOURCE_BUSY')
    }
    if (source.pragma('journal_mode=DELETE', { simple: true }) !== 'delete') fail('REHEARSAL_SOURCE_BUSY')
    source.exec('BEGIN EXCLUSIVE')
    sourceHeld()
    if (existsSync(ctx.source + '-wal') || existsSync(ctx.source + '-shm')) fail('REHEARSAL_SOURCE_BUSY')
    integrity(source)
    const pageBytes = Number(source.pragma('page_count', { simple: true })) * Number(source.pragma('page_size', { simple: true }))
    if (!Number.isSafeInteger(pageBytes) || pageBytes > ctx.maxBytes) fail('REHEARSAL_BOUNDS_EXCEEDED')
    snapshot = source.serialize()
    if (snapshot.length > ctx.maxBytes) fail('REHEARSAL_BOUNDS_EXCEEDED')
    const resources = captureResources(ctx)
    const sourceInputs = inputs(source, options)
    const originalPreserved = preservedHash(source, sourceInputs.map((input) => input.location))
    const backupPath = join(ctx.output, BACKUP)
    if (!existsSync(backupPath)) {
      if (existsSync(join(ctx.output, JOURNAL)) || existsSync(join(ctx.output, CANDIDATE))) fail('REHEARSAL_STATE_CONFLICT')
      const capsule = createCapsule(ctx, snapshot, resources)
      const pending = backupPath + '.pending'
      try {
        removePending(pending)
        writeExclusive(pending, capsule.bytes)
        renameSync(pending, backupPath)
        chmodSync(backupPath, 0o400)
        syncDirectory(ctx.output)
      } finally { capsule.bytes.fill(0) }
      boundary(ctx, 'backup-published')
    }
    const original = readCapsule(ctx)
    try {
      if (original.manifest.sha256 !== hash(snapshot)) fail('REHEARSAL_STATE_CONFLICT')
      verifyResources(ctx, original.manifest.resources)
      let journal = readJournal(ctx, original.manifest, original.backupHash)
      const recovered = !!journal
      if (journal && journal.preservedHash !== originalPreserved) fail('REHEARSAL_STATE_CONFLICT')
      const candidate = join(ctx.output, CANDIDATE)
      const pending = candidate + '.pending'
      if (!journal) {
        if (existsSync(candidate) || existsSync(pending)) fail('REHEARSAL_STATE_CONFLICT')
        journal = { type: 'credential-import-rehearsal', version: 1, fixtureId: ctx.fixtureId, snapshotId: original.manifest.snapshotId, backupHash: original.backupHash, sourceHash: original.manifest.sha256, format: original.manifest.format, state: 'prepared', candidateHash: null, preservedHash: originalPreserved }
        writeJournal(ctx, journal)
        boundary(ctx, 'journal-prepared')
      }
      const locations = sourceInputs.map((input) => input.location)
      if (journal.state === 'prepared') {
        if (existsSync(candidate)) fail('REHEARSAL_STATE_CONFLICT')
        removePending(pending)
        const converted = applyCandidate(ctx, original.snapshot)
        try {
          if (converted.preserved !== journal.preservedHash) fail('REHEARSAL_PRESERVATION_FAILED')
          sourceHeld(); verifyResources(ctx, original.manifest.resources)
          writeExclusive(pending, converted.bytes)
          boundary(ctx, 'candidate-written')
          journal = { ...journal, state: 'candidate-ready', candidateHash: hash(converted.bytes) }
          writeJournal(ctx, journal)
          boundary(ctx, 'journal-ready')
        } finally { converted.bytes.fill(0) }
      }
      if (journal.state === 'candidate-ready') {
        if (existsSync(candidate) === existsSync(pending)) fail('REHEARSAL_STATE_CONFLICT')
        validateCandidate(ctx, existsSync(candidate) ? candidate : pending, journal.candidateHash!, journal.preservedHash, locations)
        sourceHeld(); verifyResources(ctx, original.manifest.resources)
        if (existsSync(pending)) { renameSync(pending, candidate); syncDirectory(ctx.output) }
        boundary(ctx, 'candidate-published')
        journal = { ...journal, state: 'committed' }
        writeJournal(ctx, journal)
        boundary(ctx, 'journal-committed')
      }
      if (existsSync(pending)) fail('REHEARSAL_STATE_CONFLICT')
      validateCandidate(ctx, candidate, journal.candidateHash!, journal.preservedHash, locations)
      sourceHeld(); verifyResources(ctx, original.manifest.resources)
      return Object.freeze({ state: 'committed', candidatePath: candidate, encryptedOriginalPath: backupPath, recovered, credentialChanges: sourceInputs.length })
    } finally { original.snapshot.fill(0) }
  } catch (error) {
    if (error instanceof ProfileMigrationRehearsalError) throw error
    if (error instanceof CredentialMigrationError) fail(error.code === 'LEGACY_UNAVAILABLE' || error.code === 'DESTINATION_UNAVAILABLE' ? 'REHEARSAL_PROVIDER_UNAVAILABLE' : 'REHEARSAL_SOURCE_INVALID')
    const code = (error as { code?: string }).code
    fail(code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ? 'REHEARSAL_SOURCE_BUSY' : 'REHEARSAL_IO_FAILED')
  } finally { snapshot?.fill(0); source?.close() }
}

/** Restore encrypted original credential representations into another owned file, never the source/live DB. */
export function rehearseProfileCredentialRollback(options: RehearsalOptions): string {
  const result = rehearseProfileCredentialImport(options)
  const ctx = context(options)
  const original = readCapsule(ctx)
  try {
    const db = new Database(original.snapshot)
    try {
      integrity(db)
      for (const input of inputs(db, options)) if (input.source.kind === 'setting' ? !input.source.value.startsWith('safeStorage:v1:') : input.source.interpretation !== 'safeStorage') fail('REHEARSAL_ROLLBACK_PLAINTEXT')
    } finally { db.close() }
    held(ctx); verifyResources(ctx, original.manifest.resources)
    const path = join(ctx.output, 'rollback-original.sqlite')
    if (existsSync(path)) {
      const existing = boundedRead(path, ctx.maxBytes)
      try { if (hash(existing) !== original.manifest.sha256) fail('REHEARSAL_STATE_CONFLICT') } finally { existing.fill(0) }
    } else {
      const pending = path + '.pending'
      removePending(pending)
      writeExclusive(pending, original.snapshot)
      renameSync(pending, path)
      syncDirectory(ctx.output)
    }
    if (result.state !== 'committed') fail('REHEARSAL_STATE_CONFLICT')
    return path
  } finally { original.snapshot.fill(0) }
}
