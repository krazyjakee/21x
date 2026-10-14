import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const CONNECTOR_OPERATIONS = ['connectors:bridgePieces', 'connectors:ensureInstance', 'connectors:credentialStatus', 'connectors:setCredentials', 'connectors:clearCredentials', 'connectors:oauthConnect', 'connectors:syncStatus'] as const
export type ConnectorOperation = typeof CONNECTOR_OPERATIONS[number]
export const CONNECTOR_MAPPED_PIECES = ['@activepieces/piece-trello', '@activepieces/piece-todoist'] as const
export const CONNECTOR_LIMITS = { instances: 128, references: 128, tasks: 512, field: 4096, config: 128 * 1024, result: 64 * 1024 } as const
export const CONNECTOR_WRITE_ERROR = 'Connector credentials could not be saved.'
export const CONNECTOR_STORAGE_REMEDIATION = 'Secure persistent storage is unavailable. Use session storage or restore secure storage.'
export const CONNECTOR_SYNC_ERROR = 'Connector sync failed. Open the task source for details.'
export interface ConnectorCodec<K extends ConnectorOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => isRecord(value) && hasExactKeys(value, required, optional)
export const connectorText = (value: unknown, max: number = CONNECTOR_LIMITS.field): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && new TextEncoder().encode(value).length <= max
export const connectorId = (value: unknown): value is string => connectorText(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
export const connectorPiece = (value: unknown): value is string => typeof value === 'string' && CONNECTOR_MAPPED_PIECES.includes(value as typeof CONNECTOR_MAPPED_PIECES[number])
const mode = (value: unknown): boolean => value === 'persistent' || value === 'session'
const count = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0
const time = (value: unknown): boolean => value === null || count(value)
const bounded = (value: unknown): boolean => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).length <= CONNECTOR_LIMITS.result
const strings = (value: unknown, max = 32): boolean => Array.isArray(value) && value.length <= max && value.every(item => connectorText(item, 256))
function piece(value: unknown): boolean {
  return shape(value, ['pieceName', 'label', 'authType', 'authLabels', 'configProps'], ['authHelp', 'oauth']) && connectorPiece(value.pieceName) && connectorText(value.label, 256) && ['basic', 'secret_text', 'oauth2'].includes(value.authType as string) &&
    isRecord(value.authLabels) && Object.keys(value.authLabels).length <= 3 && Object.entries(value.authLabels).every(([key, label]) => ['username', 'password', 'secret', 'clientId', 'clientSecret'].includes(key) && connectorText(label, 256)) &&
    (value.authHelp === undefined || connectorText(value.authHelp)) && Array.isArray(value.configProps) && value.configProps.length <= 32 && value.configProps.every(prop => shape(prop, ['key', 'label'], ['required', 'description', 'placeholder']) && connectorText(prop.key, 128) && connectorText(prop.label, 256) && (prop.required === undefined || typeof prop.required === 'boolean') && (prop.description === undefined || connectorText(prop.description)) && (prop.placeholder === undefined || connectorText(prop.placeholder))) &&
    (value.oauth === undefined || shape(value.oauth, ['mode', 'pkce', 'clientSecretRequired', 'scopes', 'redirectUriHint']) && ['registered', 'user-supplied'].includes(value.oauth.mode as string) && typeof value.oauth.pkce === 'boolean' && typeof value.oauth.clientSecretRequired === 'boolean' && strings(value.oauth.scopes) && connectorText(value.oauth.redirectUriHint, 1024))
}
function input(value: unknown, oauth = false): boolean {
  const fields = oauth ? ['clientId', 'clientSecret'] : ['username', 'password', 'secret']
  return shape(value, [], fields) && Object.values(value).every(field => field === undefined || connectorText(field) && !!field.trim() && !['__21x_api_key_set__', '__21x_mcp_secret_set__'].includes(field.trim()))
}
function writeResult(value: unknown): boolean {
  return shape(value, ['ok'], ['storage', 'error', 'remediation', 'sessionOnlyAvailable']) && (value.ok === true ? shape(value, ['ok', 'storage']) && mode(value.storage)
    : value.ok === false && shape(value, ['ok', 'error'], ['remediation', 'sessionOnlyAvailable']) && value.error === CONNECTOR_WRITE_ERROR && (value.remediation === undefined || value.remediation === CONNECTOR_STORAGE_REMEDIATION) && (value.sessionOnlyAvailable === undefined || typeof value.sessionOnlyAvailable === 'boolean'))
}
export function projectConnectorWriteResult(value: unknown): unknown {
  if (!shape(value, ['ok'], ['storage', 'error', 'remediation', 'sessionOnlyAvailable']) || typeof value.ok !== 'boolean') return fail('INVALID_RESULT')
  if (value.ok) return value
  if (typeof value.error !== 'string') return fail('INVALID_RESULT')
  return { ok: false, error: CONNECTOR_WRITE_ERROR, ...(value.sessionOnlyAvailable === true ? { sessionOnlyAvailable: true, remediation: CONNECTOR_STORAGE_REMEDIATION } : {}) }
}
function syncResult(value: unknown): boolean {
  return shape(value, ['lastError', 'lastSyncedAt', 'attemptCount', 'nextRetryAt', 'deadLetterCount']) && (value.lastError === null || value.lastError === CONNECTOR_SYNC_ERROR) && time(value.lastSyncedAt) && count(value.attemptCount) && time(value.nextRetryAt) && count(value.deadLetterCount)
}
const idArgs = (value: unknown[]): boolean => value.length === 1 && connectorId(value[0])
interface Descriptor { keys: string[]; optional?: string[]; args(args: unknown[]): boolean; result(value: unknown): boolean; project?(value: unknown): unknown }
const credentialArgs = (args: unknown[], oauth: boolean): boolean => args.length >= 2 && args.length <= 3 && connectorId(args[0]) && input(args[1], oauth) && (args[2] === undefined || mode(args[2]))
const descriptors: Record<ConnectorOperation, Descriptor> = {
  'connectors:bridgePieces': { keys: [], args: args => args.length === 0, project: value => {
    if (!Array.isArray(value) || value.length > CONNECTOR_MAPPED_PIECES.length) return fail('INVALID_RESULT')
    return value.map(item => {
      if (!isRecord(item) || !piece(item)) return fail('INVALID_RESULT')
      const clean = (entry: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(entry).filter(([, field]) => field !== undefined))
      return clean({ ...item, configProps: (item.configProps as Record<string, unknown>[]).map(clean) })
    })
  }, result: value => Array.isArray(value) && value.length <= CONNECTOR_MAPPED_PIECES.length && value.every(piece) && new Set(value.map(item => item.pieceName)).size === value.length },
  'connectors:ensureInstance': { keys: ['pieceName'], optional: ['instanceId'], args: args => args.length >= 1 && args.length <= 2 && connectorPiece(args[0]) && (args[1] === undefined || connectorId(args[1])), result: value => shape(value, ['instanceId', 'pieceName']) && connectorId(value.instanceId) && connectorPiece(value.pieceName) },
  'connectors:credentialStatus': { keys: ['instanceId'], args: idArgs, result: value => shape(value, ['storage', 'persistentAvailable'], ['oauth']) && (value.storage === null || mode(value.storage)) && typeof value.persistentAvailable === 'boolean' && (value.oauth === undefined || shape(value.oauth, ['state', 'expiresAt']) && ['none', 'connected', 'revoked'].includes(value.oauth.state as string) && time(value.oauth.expiresAt)) },
  'connectors:setCredentials': { keys: ['instanceId', 'input'], optional: ['storage'], args: args => credentialArgs(args, false), result: writeResult, project: projectConnectorWriteResult },
  'connectors:clearCredentials': { keys: ['instanceId'], args: idArgs, result: value => value === undefined },
  'connectors:oauthConnect': { keys: ['instanceId', 'input'], optional: ['storage'], args: args => credentialArgs(args, true), result: writeResult, project: projectConnectorWriteResult },
  'connectors:syncStatus': { keys: ['instanceId'], args: idArgs, result: syncResult, project: value => {
    if (!isRecord(value) || value.lastError !== null && typeof value.lastError !== 'string') return fail('INVALID_RESULT')
    return { ...value, lastError: value.lastError ? CONNECTOR_SYNC_ERROR : null }
  } }
}
function codec<K extends ConnectorOperation>(operation: K): ConnectorCodec<K> {
  const descriptor = descriptors[operation], keys = [...descriptor.keys, ...(descriptor.optional ?? [])]
  const valid = (value: unknown): boolean => descriptor.result(value) && (value === undefined || bounded(value))
  return {
    validateArguments: value => Array.isArray(value) && descriptor.args(value),
    encodeArguments(args) {
      if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS')
      return Object.fromEntries(keys.flatMap((key, index) => args[index] === undefined ? [] : [[key, key === 'input' && isRecord(args[index]) ? Object.fromEntries(Object.entries(args[index]).filter(([, field]) => field !== undefined)) : args[index]]])) as JsonValue
    },
    decodeArguments(payload) { if (!shape(payload, descriptor.keys, descriptor.optional)) return fail('INVALID_ARGUMENTS'); const args = keys.flatMap(key => Object.hasOwn(payload, key) ? [payload[key]] : []); if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateResult: valid,
    encodeResult(value) { const projected = descriptor.project ? descriptor.project(value) : value; if (!valid(projected)) return fail('INVALID_RESULT'); return projected === undefined ? { defined: false } : { defined: true, value: projected as JsonValue } },
    decodeResult(value) { if (!valid(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult(value) { return shape(value, ['defined'], ['value']) && (value.defined === false ? !Object.hasOwn(value, 'value') && valid(undefined) : value.defined === true && Object.hasOwn(value, 'value') && valid(value.value)) }
  }
}
export const CONNECTOR_CODECS = Object.fromEntries(CONNECTOR_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in ConnectorOperation]: ConnectorCodec<K> }
