import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { AUTHENTICATED_SECRET_STORAGE_FORMAT } from './secret-storage'
import { CREDENTIAL_MIGRATION_LIMITS, isRecordCredentialLocation, type LegacyCredentialInput, type PreparedCredentialChange, type RecordCredentialInterpretation, type RecordCredentialLocation } from './credential-migration'

export type RecordCredentialProvenance = { readonly location: RecordCredentialLocation } & RecordCredentialInterpretation
export class RecordCredentialConversionError extends Error {
  constructor(readonly code: 'RECORD_COVERAGE_INCOMPLETE' | 'RECORD_INVALID_JSON' | 'RECORD_BOUNDS_EXCEEDED' | 'RECORD_PRESERVATION_FAILED') { super(code); this.name = 'RecordCredentialConversionError' }
}
function fail(code: RecordCredentialConversionError['code']): never { throw new RecordCredentialConversionError(code) }
const keyOf = (location: RecordCredentialLocation) => JSON.stringify([location.table, location.rowId, location.column, ...location.jsonPath])
const quote = (key: string) => '"' + key.replaceAll('"', '""') + '"'
interface Token { start: number; end: number; value: string }
interface Parsed { object: Record<string, unknown>; strings: Map<string, Token> }

/** Full JSON validation plus a bounded lexical walk. Duplicate decoded keys
 * are refused rather than silently discarded by JSON.parse. Token offsets
 * allow credential replacement without normalizing any surrounding bytes. */
function parse(text: string): Parsed {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > CREDENTIAL_MIGRATION_LIMITS.maxRecordBytes * 2) fail('RECORD_BOUNDS_EXCEEDED')
  let object: unknown
  try { object = JSON.parse(text) } catch { fail('RECORD_INVALID_JSON') }
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail('RECORD_INVALID_JSON')
  const strings = new Map<string, Token>()
  let at = 0, nodes = 0
  const whitespace = () => { while (/[\t\r\n ]/.test(text[at] ?? '') && at < text.length) at++ }
  const string = (): Token => {
    const start = at++
    while (at < text.length && text[at] !== '"') { if (text[at] === '\\') at++; at++ }
    const end = ++at
    return { start, end, value: JSON.parse(text.slice(start, end)) as string }
  }
  const visit = (path: string[], depth: number): void => {
    if (++nodes > 100_000 || depth > 64) fail('RECORD_BOUNDS_EXCEEDED')
    whitespace()
    if (text[at] === '"') { const token = string(); strings.set(JSON.stringify(path), token); return }
    if (text[at] === '{') {
      at++; whitespace(); const keys = new Set<string>()
      if (text[at] === '}') { at++; return }
      do {
        whitespace(); const key = string().value
        if (keys.has(key)) fail('RECORD_INVALID_JSON')
        keys.add(key); whitespace(); at++; visit([...path, key], depth + 1); whitespace()
        if (text[at] === '}') { at++; return }
        at++
      } while (at < text.length)
    } else if (text[at] === '[') {
      at++; whitespace(); let index = 0
      if (text[at] === ']') { at++; return }
      do { visit([...path, String(index++)], depth + 1); whitespace(); if (text[at] === ']') { at++; return }; at++ } while (at < text.length)
    } else { while (at < text.length && !/[\t\r\n ,}\]]/.test(text[at])) at++ }
  }
  visit([], 0)
  return { object: object as Record<string, unknown>, strings }
}
function dictionary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RECORD_INVALID_JSON')
  return value as Record<string, unknown>
}
function locations(table: RecordCredentialLocation['table'], column: RecordCredentialLocation['column'], rowId: string, parsed: Parsed): RecordCredentialLocation[] {
  let paths: string[][]
  if (table === 'agents') paths = Object.hasOwn(parsed.object, 'api_keys') ? Object.keys(dictionary(parsed.object.api_keys)).map(key => ['api_keys', key]) : []
  else if (table === 'mcp_servers' && (column === 'headers' || column === 'environment')) paths = Object.keys(parsed.object).map(key => [key])
  else if (table === 'mcp_servers') paths = Object.hasOwn(parsed.object, 'client_secret') ? [['client_secret']] : []
  else paths = ['client_secret', 'access_token', 'api_token'].filter(key => Object.hasOwn(parsed.object, key)).map(key => [key])
  return paths.map(jsonPath => {
    const location = { table, column, rowId, jsonPath }
    if (!isRecordCredentialLocation(location) || !parsed.strings.has(JSON.stringify(jsonPath))) fail('RECORD_INVALID_JSON')
    return location
  })
}

/** Trusted exporter evidence is required for every nonempty protected leaf.
 * Missing old tables/columns are not invented or migrated by this helper. */
export function collectRecordCredentialInputs(db: Database.Database, provenance: readonly RecordCredentialProvenance[] = []): LegacyCredentialInput[] {
  if (!Array.isArray(provenance) || provenance.length > CREDENTIAL_MIGRATION_LIMITS.maxRecords) fail('RECORD_COVERAGE_INCOMPLETE')
  const proofs = new Map<string, RecordCredentialProvenance>()
  for (const entry of provenance) {
    if (!entry || !isRecordCredentialLocation(entry.location) || !entry.location.rowId || entry.location.rowId.length > 256 ||
      entry.interpretation !== 'plaintext-utf8' && entry.interpretation !== 'authenticated-record' ||
      entry.interpretation === 'authenticated-record' && entry.formatId !== AUTHENTICATED_SECRET_STORAGE_FORMAT ||
      entry.interpretation === 'plaintext-utf8' && 'formatId' in entry) fail('RECORD_COVERAGE_INCOMPLETE')
    const key = keyOf(entry.location)
    if (proofs.has(key)) fail('RECORD_COVERAGE_INCOMPLETE')
    proofs.set(key, entry)
  }
  const tables = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name))
  const inputs: LegacyCredentialInput[] = []
  let totalBytes = 0, totalRows = 0
  const columns: Record<RecordCredentialLocation['table'], RecordCredentialLocation['column'][]> = { agents: ['config'], mcp_servers: ['headers', 'environment', 'oauth_metadata'], task_sources: ['config'] }
  for (const [table, configured] of Object.entries(columns) as Array<[RecordCredentialLocation['table'], RecordCredentialLocation['column'][]]>) {
    if (!tables.has(table)) continue
    const available = new Set((db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map(row => row.name))
    for (const column of configured.filter(column => available.has(column))) {
      const sizes = db.prepare(`SELECT COUNT(*) AS count, MAX(length(CAST(id AS BLOB))) AS id_bytes, MAX(length(CAST(${quote(column)} AS BLOB))) AS largest,
        COALESCE(SUM(length(CAST(${quote(column)} AS BLOB))),0) AS bytes FROM ${quote(table)}`).get() as { count: number; id_bytes: number | null; largest: number | null; bytes: number }
      totalBytes += sizes.bytes; totalRows += sizes.count
      if (!Number.isSafeInteger(totalBytes) || totalBytes > CREDENTIAL_MIGRATION_LIMITS.maxInputBytes || totalRows > CREDENTIAL_MIGRATION_LIMITS.maxRecords || (sizes.id_bytes ?? 0) > 256 || (sizes.largest ?? 0) > CREDENTIAL_MIGRATION_LIMITS.maxRecordBytes) fail('RECORD_BOUNDS_EXCEEDED')
      for (const row of db.prepare(`SELECT id,${quote(column)} AS value FROM ${quote(table)} ORDER BY id`).iterate() as Iterable<{ id: string; value: string }>) {
        const parsed = parse(row.value)
        for (const location of locations(table, column, row.id, parsed)) {
          const value = parsed.strings.get(JSON.stringify(location.jsonPath))!.value, key = keyOf(location), proof = proofs.get(key)
          if (!value && !proof) continue
          if (!proof) fail('RECORD_COVERAGE_INCOMPLETE')
          proofs.delete(key)
          if (!value) { if (proof.interpretation !== 'plaintext-utf8') fail('RECORD_COVERAGE_INCOMPLETE'); continue }
          inputs.push({ location, source: { kind: 'record', value, ...(proof.interpretation === 'authenticated-record' ? { interpretation: proof.interpretation, formatId: proof.formatId } : { interpretation: proof.interpretation }) } })
          if (inputs.length > CREDENTIAL_MIGRATION_LIMITS.maxRecords) fail('RECORD_BOUNDS_EXCEEDED')
        }
      }
    }
  }
  if (proofs.size) fail('RECORD_COVERAGE_INCOMPLETE')
  return inputs
}
function replace(text: string, replacements: Array<{ token: Token; replacement: string }>): string {
  let result = text
  for (const item of replacements.sort((a, b) => b.token.start - a.token.start)) result = result.slice(0, item.token.start) + item.replacement + result.slice(item.token.end)
  if (Buffer.byteLength(result, 'utf8') > CREDENTIAL_MIGRATION_LIMITS.maxRecordBytes * 2) fail('RECORD_BOUNDS_EXCEEDED')
  return result
}
export function normalizedRecordCredentialText(text: string, excluded: readonly RecordCredentialLocation[]): string {
  const parsed = parse(text)
  return replace(text, excluded.map(location => {
    const token = parsed.strings.get(JSON.stringify(location.jsonPath))
    if (!token) fail('RECORD_PRESERVATION_FAILED')
    return { token, replacement: '"<converted-credential>"' }
  }))
}
export function recordCredentialColumnKey(location: RecordCredentialLocation): string { return JSON.stringify([location.table, location.rowId, location.column]) }
export function applyRecordCredentialChanges(db: Database.Database, changes: readonly PreparedCredentialChange[], destinationFormat: string): void {
  const groups = new Map<string, PreparedCredentialChange[]>()
  for (const change of changes) if (isRecordCredentialLocation(change.location)) {
    const key = recordCredentialColumnKey(change.location), group = groups.get(key) ?? []; group.push(change); groups.set(key, group)
  }
  for (const group of groups.values()) {
    const location = group[0].location as RecordCredentialLocation
    const row = db.prepare(`SELECT ${quote(location.column)} AS value FROM ${quote(location.table)} WHERE id=?`).get(location.rowId) as { value: string } | undefined
    if (!row) fail('RECORD_PRESERVATION_FAILED')
    const parsed = parse(row.value)
    const updated = replace(row.value, group.map(change => {
      const token = parsed.strings.get(JSON.stringify((change.location as RecordCredentialLocation).jsonPath))
      if (!token) fail('RECORD_PRESERVATION_FAILED')
      return { token, replacement: JSON.stringify(`21x-record-credential:v1:21x-credential:${destinationFormat}:${change.ciphertextBase64}`) }
    }))
    if (db.prepare(`UPDATE ${quote(location.table)} SET ${quote(location.column)}=? WHERE id=?`).run(updated, location.rowId).changes !== 1) fail('RECORD_PRESERVATION_FAILED')
  }
  // Triggers cannot swap another credential while remaining hidden by the
  // noncredential preservation hash. Compare every exact planned envelope.
  for (const group of groups.values()) {
    const location = group[0].location as RecordCredentialLocation
    const row = db.prepare(`SELECT ${quote(location.column)} AS value FROM ${quote(location.table)} WHERE id=?`).get(location.rowId) as { value: string } | undefined
    if (!row) fail('RECORD_PRESERVATION_FAILED')
    const parsed = parse(row.value)
    for (const change of group) if (parsed.strings.get(JSON.stringify((change.location as RecordCredentialLocation).jsonPath))?.value !== `21x-record-credential:v1:21x-credential:${destinationFormat}:${change.ciphertextBase64}`) fail('RECORD_PRESERVATION_FAILED')
  }
}
/** Hash binds interpretation/path evidence to recovery without exporting row
 * IDs, raw config or credentials into the plaintext rehearsal result. */
export function recordCredentialProvenanceHash(provenance: readonly RecordCredentialProvenance[] = []): string {
  return createHash('sha256').update(JSON.stringify([...provenance].map(entry => [keyOf(entry.location), entry.interpretation, entry.interpretation === 'authenticated-record' ? entry.formatId : null]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))).digest('hex')
}
