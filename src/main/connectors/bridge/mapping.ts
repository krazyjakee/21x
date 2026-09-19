import { TaskStatus } from '../../../shared/constants'
import type { UpdateTaskData } from '../../database'
import { CONNECTOR_PIECE_ALLOWLIST, getAllowedPiece, type ConnectorPieceAllowlist } from '../allowlist'
import { redactCredentials, type ConnectorCredentials } from '../credentials'

/**
 * Declarative mapping from an allowlisted piece's output to canonical 21x task
 * fields (issue #13, docs/connectors.md "Connector bridge").
 *
 * A mapping names one allowlisted list/search action or polling trigger to
 * import through, the dot paths that pick task fields out of each item, and
 * (optionally) one allowlisted update action for round-tripping title, due date
 * and status. Adding a long-tail source takes a bundled piece, an allowlist
 * entry and a mapping; no provider-specific client code.
 *
 * Every mapped value is validated (type, length) and run through
 * redactCredentials() before it can reach a task.
 */

// ── Limits ────────────────────────────────────────────────────

/** Largest JSON-encoded piece output one sync accepts. */
export const BRIDGE_MAX_OUTPUT_BYTES = 5 * 1024 * 1024
/** Largest JSON-encoded single item; bigger items are rejected, not truncated. */
export const BRIDGE_MAX_ITEM_BYTES = 256 * 1024
/** Items imported per sync; the rest are reported and picked up by the next one. */
export const BRIDGE_MAX_ITEMS_PER_SYNC = 1000
export const BRIDGE_MAX_EXTERNAL_ID_CHARS = 256
export const BRIDGE_MAX_TITLE_CHARS = 500
export const BRIDGE_MAX_DESCRIPTION_CHARS = 64 * 1024
export const BRIDGE_MAX_LABELS = 20
export const BRIDGE_MAX_LABEL_CHARS = 64
export const BRIDGE_MAX_URL_CHARS = 2048
// Attachments are out of scope (#13): mappings cannot name an attachment
// field, so nothing is downloaded.

// ── Mapping types ─────────────────────────────────────────────

/**
 * A value passed as a piece prop: either a constant, or a value the user
 * entered in the task source config (`config.props[key]`).
 */
export type MappedPropValue = { value: string | number | boolean } | { config: string }

export interface BridgeConfigProp {
  /** Key in the task source's `config.props`. */
  key: string
  label: string
  required?: boolean
  description?: string
  placeholder?: string
}

export type BridgeImportTarget =
  | { type: 'action'; name: string }
  | { type: 'trigger'; name: string }

export interface BridgeStatusMapping {
  /** Path of the field that says whether the item is closed at the source. */
  path: string
  /** The item is completed at the source when the field equals one of these. */
  completedValues: (string | number | boolean)[]
}

export interface BridgeFieldMapping {
  /** Stable source identity; used as the task's external_id for idempotent upserts. */
  externalId: string
  title: string
  description?: string
  dueDate?: string
  /** Shown as a link under the description. Only http(s) URLs are kept. */
  url?: string
  /** Path to an array of strings, or `path[].field` for an array of objects. */
  labels?: string
  status?: BridgeStatusMapping
}

/** A dedicated allowlisted action that closes or reopens one item. */
export interface BridgeStatusAction {
  action: string
  /** Prop that receives the item's external id. */
  idProp: string
  staticProps?: Record<string, MappedPropValue>
}

export interface BridgeUpdateMapping {
  /** Allowlisted action that updates one item. */
  action: string
  /** Prop that receives the item's external id. */
  idProp: string
  titleProp?: string
  /** Receives the due date: an ISO 8601 timestamp, or `YYYY-MM-DD` when `dueDateFormat` is `date`. */
  dueDateProp?: string
  /** `date` for providers whose due dates are calendar days (default `iso`). */
  dueDateFormat?: 'iso' | 'date'
  /**
   * Prop that opens/closes the item. Only a local Completed (close) or Not
   * Started (reopen) is pushed; the other workflow states belong to 21x.
   */
  status?: { prop: string; completedValue: string | number | boolean; openValue: string | number | boolean }
  /**
   * For pieces whose update action cannot change completion: separate
   * close / reopen actions. Mutually exclusive with `status`. A status change
   * runs the status action first, then the update action for other fields.
   */
  statusActions?: { complete: BridgeStatusAction; reopen?: BridgeStatusAction }
  staticProps?: Record<string, MappedPropValue>
}

export interface ConnectorTaskMapping {
  pieceName: string
  /** Shown as the task's source label. */
  label: string
  /** Credential shape the piece expects; drives the config form. */
  auth: {
    /** `oauth2` pieces connect through the browser flow; the allowlist entry holds the provider settings. */
    type: 'secret_text' | 'basic' | 'oauth2'
    /** Field labels for the form (basic: username/password; secret_text: secret; oauth2: clientId/clientSecret). */
    labels: Record<string, string>
    help?: string
    /** oauth2: the subset of the allowlisted scopes this mapping needs; the allowlist scopes when omitted. */
    scopes?: string[]
  }
  configProps: BridgeConfigProp[]
  import: {
    target: BridgeImportTarget
    props: Record<string, MappedPropValue>
    /** Path to the item array in the output; omit when the output is the array. */
    itemsPath?: string
  }
  fields: BridgeFieldMapping
  update?: BridgeUpdateMapping
}

export type ConnectorTaskMappings = Record<string, ConnectorTaskMapping>

// ── Paths ─────────────────────────────────────────────────────

const SEGMENT = /^[A-Za-z_$][\w$-]*$/
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

/** `a.b.c` or `a.b[].c`; at most one `[]` step. */
export function isValidPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
  const parts = path.split('.')
  let arrays = 0
  for (const raw of parts) {
    const part = raw.endsWith('[]') ? raw.slice(0, -2) : raw
    if (raw.endsWith('[]')) arrays++
    if (!SEGMENT.test(part) || FORBIDDEN_SEGMENTS.has(part)) return false
  }
  return arrays <= 1
}

function ownGet(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

/** Reads a mapping path. `[]` maps the rest of the path over an array. */
export function readPath(value: unknown, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = value
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]
    if (raw.endsWith('[]')) {
      const arr = ownGet(current, raw.slice(0, -2))
      if (!Array.isArray(arr)) return undefined
      const rest = parts.slice(i + 1).join('.')
      return rest ? arr.map((el) => readPath(el, rest)) : arr
    }
    current = ownGet(current, raw)
    if (current === undefined) return undefined
  }
  return current
}

// ── Mapping validation ────────────────────────────────────────

/**
 * Checks a mapping against the allowlist: the import target and update action
 * must be allowlisted for the piece, and every path well-formed. Returns the
 * problems found (empty when valid).
 */
export function validateMapping(
  mapping: ConnectorTaskMapping,
  allowlist: ConnectorPieceAllowlist = CONNECTOR_PIECE_ALLOWLIST
): string[] {
  const problems: string[] = []
  const piece = getAllowedPiece(mapping.pieceName, allowlist)
  if (!piece) return [`${mapping.pieceName} is not in the connector allowlist`]

  const { target } = mapping.import
  if (target.type === 'action') {
    if (!Object.prototype.hasOwnProperty.call(piece.actions, target.name)) {
      problems.push(`import action "${target.name}" is not allowlisted`)
    }
  } else if (target.type === 'trigger') {
    const trigger = Object.prototype.hasOwnProperty.call(piece.triggers, target.name) ? piece.triggers[target.name] : undefined
    if (!trigger) problems.push(`import trigger "${target.name}" is not allowlisted`)
    else if (trigger.strategy !== 'POLLING') problems.push(`import trigger "${target.name}" is not a polling trigger`)
  } else {
    problems.push('import target must be an action or a polling trigger')
  }

  if (mapping.import.itemsPath !== undefined && !isValidPath(mapping.import.itemsPath)) {
    problems.push(`invalid items path "${mapping.import.itemsPath}"`)
  }

  const configKeys = new Set(mapping.configProps.map((p) => p.key))
  const checkProps = (props: Record<string, MappedPropValue> | undefined, where: string): void => {
    for (const [prop, v] of Object.entries(props ?? {})) {
      if ('config' in v && !configKeys.has(v.config)) problems.push(`${where} prop "${prop}" reads unknown config "${v.config}"`)
    }
  }
  checkProps(mapping.import.props, 'import')

  const { fields } = mapping
  for (const [name, path] of Object.entries({
    externalId: fields.externalId,
    title: fields.title,
    description: fields.description,
    dueDate: fields.dueDate,
    url: fields.url,
    labels: fields.labels,
    status: fields.status?.path
  })) {
    if (path === undefined && name !== 'externalId' && name !== 'title') continue
    if (!isValidPath(path as string)) problems.push(`invalid ${name} path "${String(path)}"`)
    else if (name !== 'labels' && (path as string).includes('[]')) problems.push(`${name} path cannot use []`)
  }

  if (mapping.update) {
    if (!Object.prototype.hasOwnProperty.call(piece.actions, mapping.update.action)) {
      problems.push(`update action "${mapping.update.action}" is not allowlisted`)
    }
    checkProps(mapping.update.staticProps, 'update')
    const { statusActions } = mapping.update
    if (statusActions) {
      if (mapping.update.status) problems.push('update cannot declare both status and statusActions')
      for (const [name, sa] of Object.entries({ complete: statusActions.complete, reopen: statusActions.reopen })) {
        if (!sa) continue
        if (!Object.prototype.hasOwnProperty.call(piece.actions, sa.action)) problems.push(`${name} action "${sa.action}" is not allowlisted`)
        checkProps(sa.staticProps, name)
      }
    }
  }

  if (mapping.auth.type === 'oauth2') {
    if (!piece.oauth) problems.push(`${mapping.pieceName} has no OAuth2 settings in the allowlist`)
    else if (mapping.auth.scopes?.some((s) => !piece.oauth!.scopes.includes(s))) {
      problems.push('auth.scopes must be a subset of the allowlisted OAuth2 scopes')
    }
  } else if (piece.oauth) {
    problems.push(`${mapping.pieceName} is an OAuth2 piece; auth.type must be "oauth2"`)
  }
  return problems
}

// ── Item mapping ──────────────────────────────────────────────

export interface MappedItem {
  externalId: string
  fields: UpdateTaskData
  /** Closed at the source. */
  completed: boolean
}

export type MapItemResult =
  | { ok: true; item: MappedItem }
  | { ok: false; externalId: string | null; error: string }

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const HAS_CONTROL_CHARS = /[\u0000-\u001F\u007F]/

function cleanText(value: string, creds: ConnectorCredentials | null): string {
  return redactCredentials(value.replace(CONTROL_CHARS, ''), creds)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Best-effort external id for error reporting; null when the item has no usable id. */
export function readExternalId(item: unknown, mapping: ConnectorTaskMapping): string | null {
  const raw = readPath(item, mapping.fields.externalId)
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  if (!id || id.length > BRIDGE_MAX_EXTERNAL_ID_CHARS || HAS_CONTROL_CHARS.test(id)) return null
  return id
}

/**
 * Maps one piece item to task fields. Rejects wrong types and oversized items;
 * truncates over-long text. All text is credential-redacted.
 */
export function mapItem(item: unknown, mapping: ConnectorTaskMapping, creds: ConnectorCredentials | null = null): MapItemResult {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { ok: false, externalId: null, error: 'item is not an object' }
  }
  const externalId = readExternalId(item, mapping)
  const fail = (error: string): MapItemResult => ({ ok: false, externalId, error })
  if (!externalId) return fail(`missing or invalid id at "${mapping.fields.externalId}"`)

  const size = jsonByteLength(item)
  if (size > BRIDGE_MAX_ITEM_BYTES) return fail(`item is ${size} bytes; the limit is ${BRIDGE_MAX_ITEM_BYTES}`)

  const { fields: f } = mapping
  const fields: UpdateTaskData = {}

  const title = readPath(item, f.title)
  if (typeof title !== 'string' || !title.trim()) return fail(`missing or non-text title at "${f.title}"`)
  fields.title = truncate(cleanText(title.trim(), creds), BRIDGE_MAX_TITLE_CHARS)

  let description: string | undefined
  if (f.description) {
    const raw = readPath(item, f.description)
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'string') return fail(`description at "${f.description}" is not text`)
      description = cleanText(raw, creds)
    }
  }
  if (f.url) {
    const raw = readPath(item, f.url)
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'string') return fail(`url at "${f.url}" is not text`)
      if (raw.length <= BRIDGE_MAX_URL_CHARS && /^https?:\/\//i.test(raw)) {
        try {
          const url = new URL(raw)
          // Never show userinfo; it can carry credentials.
          url.username = ''
          url.password = ''
          const link = `[Open in ${mapping.label}](${cleanText(url.toString(), creds)})`
          description = description ? `${description}\n\n${link}` : link
        } catch {
          /* not a URL: dropped */
        }
      }
    }
  }
  if (description !== undefined) fields.description = truncate(description, BRIDGE_MAX_DESCRIPTION_CHARS)

  if (f.dueDate) {
    const raw = readPath(item, f.dueDate)
    if (raw === null) fields.due_date = null
    else if (raw !== undefined) {
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail(`due date at "${f.dueDate}" is not a date`)
      const date = new Date(raw)
      if (Number.isNaN(date.getTime())) return fail(`due date at "${f.dueDate}" is not a valid date`)
      fields.due_date = date.toISOString()
    }
  }

  if (f.labels) {
    const raw = readPath(item, f.labels)
    if (raw !== undefined && raw !== null) {
      if (!Array.isArray(raw)) return fail(`labels at "${f.labels}" are not a list`)
      const labels: string[] = []
      for (const l of raw) {
        if (typeof l !== 'string') continue
        const label = truncate(cleanText(l.trim(), creds), BRIDGE_MAX_LABEL_CHARS)
        if (label && !labels.includes(label)) labels.push(label)
        if (labels.length >= BRIDGE_MAX_LABELS) break
      }
      fields.labels = labels
    }
  }

  let completed = false
  if (f.status) {
    const raw = readPath(item, f.status.path)
    if (raw !== undefined && raw !== null && !['string', 'number', 'boolean'].includes(typeof raw)) {
      return fail(`status at "${f.status.path}" is not a scalar`)
    }
    completed = f.status.completedValues.includes(raw as string | number | boolean)
    fields.status = completed ? TaskStatus.Completed : TaskStatus.NotStarted
  }

  return { ok: true, item: { externalId, fields, completed } }
}

/** Picks the item array out of a piece output. */
export function extractItems(output: unknown, mapping: ConnectorTaskMapping): unknown[] | null {
  const list = mapping.import.itemsPath ? readPath(output, mapping.import.itemsPath) : output
  return Array.isArray(list) ? list : null
}

// ── Props ─────────────────────────────────────────────────────

/** Resolves mapped props against the source's `config.props`. Throws on a missing required value. */
export function resolveProps(
  props: Record<string, MappedPropValue> | undefined,
  configProps: Record<string, unknown>,
  mapping: ConnectorTaskMapping
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [prop, v] of Object.entries(props ?? {})) {
    if ('value' in v) {
      out[prop] = v.value
      continue
    }
    const raw = configProps[v.config]
    const value = typeof raw === 'string' ? raw.trim() : raw
    const def = mapping.configProps.find((p) => p.key === v.config)
    if (value === undefined || value === null || value === '') {
      if (def?.required) throw new Error(`${def.label} is required`)
      continue
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`${def?.label ?? v.config} must be text`)
    }
    if (typeof value === 'string' && value.length > 512) throw new Error(`${def?.label ?? v.config} is too long`)
    out[prop] = value
  }
  return out
}

/**
 * Builds the update action's props from the changed task fields, or null when
 * nothing the mapping can round-trip changed.
 */
export function buildUpdateProps(
  mapping: ConnectorTaskMapping,
  externalId: string,
  changed: Record<string, unknown>,
  configProps: Record<string, unknown>
): Record<string, unknown> | null {
  const u = mapping.update
  if (!u) return null
  const props: Record<string, unknown> = {}
  if (u.titleProp && typeof changed.title === 'string' && changed.title.trim()) {
    props[u.titleProp] = truncate(changed.title.trim(), BRIDGE_MAX_TITLE_CHARS)
  }
  if (u.dueDateProp && typeof changed.due_date === 'string' && changed.due_date) {
    const date = new Date(changed.due_date)
    if (!Number.isNaN(date.getTime())) {
      const iso = date.toISOString()
      props[u.dueDateProp] = u.dueDateFormat === 'date' ? iso.slice(0, 10) : iso
    }
  }
  if (u.status && typeof changed.status === 'string') {
    if (changed.status === TaskStatus.Completed) props[u.status.prop] = u.status.completedValue
    else if (changed.status === TaskStatus.NotStarted) props[u.status.prop] = u.status.openValue
  }
  if (Object.keys(props).length === 0) return null
  return { ...resolveProps(u.staticProps, configProps, mapping), ...props, [u.idProp]: externalId }
}

/** One allowlisted action call the bridge makes to push a change. */
export interface BridgeUpdateCall {
  action: string
  props: Record<string, unknown>
}

/**
 * The action calls that push the changed fields: a dedicated close / reopen
 * call when the mapping has `statusActions`, then the update action for the
 * remaining fields. Null when nothing the mapping can round-trip changed.
 */
export function buildUpdateCalls(
  mapping: ConnectorTaskMapping,
  externalId: string,
  changed: Record<string, unknown>,
  configProps: Record<string, unknown>
): BridgeUpdateCall[] | null {
  const u = mapping.update
  if (!u) return null
  const calls: BridgeUpdateCall[] = []
  const sa = u.statusActions
  if (sa && typeof changed.status === 'string') {
    const target = changed.status === TaskStatus.Completed ? sa.complete : changed.status === TaskStatus.NotStarted ? sa.reopen : undefined
    if (target) calls.push({ action: target.action, props: { ...resolveProps(target.staticProps, configProps, mapping), [target.idProp]: externalId } })
  }
  const rest = sa ? Object.fromEntries(Object.entries(changed).filter(([k]) => k !== 'status')) : changed
  const props = buildUpdateProps(mapping, externalId, rest, configProps)
  if (props) calls.push({ action: u.action, props })
  return calls.length ? calls : null
}

/** The task fields a pending update covers; import leaves them alone until it lands. */
export function fieldsCoveredByUpdate(changed: Record<string, unknown>): (keyof UpdateTaskData)[] {
  const out: (keyof UpdateTaskData)[] = []
  if ('title' in changed) out.push('title')
  if ('due_date' in changed) out.push('due_date')
  if ('status' in changed) out.push('status')
  return out
}

/** Deep-redacts credential values from any JSON value (dead-letter payloads). */
export function redactValue(value: unknown, creds: ConnectorCredentials | null): unknown {
  if (!creds) return value
  if (typeof value === 'string') return redactCredentials(value, creds)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, creds))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, creds)
    return out
  }
  return value
}
