import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const MCP_OPERATIONS = ['mcp:getAll', 'mcp:create', 'mcp:update', 'mcp:delete', 'mcp:testConnection', 'mcp:startOAuthFlow', 'mcp:getOAuthStatus', 'mcp:revokeOAuthToken', 'mcp:probeForAuth', 'mcp:submitManualClientId'] as const
export type McpOperation = typeof MCP_OPERATIONS[number]
export const MCP_SECRET_SET_MARKER = '__21x_mcp_secret_set__'
export const MCP_LIMITS = { servers: 128, entries: 64, args: 128, tools: 256, field: 8192, payload: 128 * 1024, result: 768 * 1024 } as const
export interface McpCodec<K extends McpOperation> {
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
export const mcpText = (value: unknown, max: number = MCP_LIMITS.field): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && new TextEncoder().encode(value).length <= max
export const isMcpId = (value: unknown): value is string => mcpText(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
export function isMcpUrl(value: unknown): value is string {
  if (!mcpText(value, 4096)) return false
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search } catch { return false }
}
const bounded = (value: unknown, limit: number): boolean => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).length <= limit
export function isMcpDictionary(value: unknown, environment = false, masked = false): value is Record<string, string> {
  return isRecord(value) && Object.keys(value).length <= MCP_LIMITS.entries && Object.entries(value).every(([key, entry]) =>
    mcpText(key, 256) && (environment ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) : /^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(key)) &&
    !['__proto__', 'prototype', 'constructor'].includes(key) && mcpText(entry) && (!masked || entry === '' || entry === MCP_SECRET_SET_MARKER))
}
const fields = ['name', 'type', 'command', 'args', 'url', 'headers', 'environment']
export function isMcpData(value: unknown, create: boolean, probe = false): value is Record<string, unknown> {
  if (!shape(value, create ? ['name'] : [], fields.filter(key => !create || key !== 'name').concat(probe ? ['id'] : [])) || !bounded(value, MCP_LIMITS.payload)) return false
  return (value.name === undefined || mcpText(value.name, 256) && !!value.name.trim()) &&
    (value.type === undefined || value.type === 'local' || value.type === 'remote') &&
    (value.command === undefined || mcpText(value.command, 4096)) &&
    (value.args === undefined || Array.isArray(value.args) && value.args.length <= MCP_LIMITS.args && value.args.every(arg => mcpText(arg))) &&
    (value.url === undefined || value.url === '' || isMcpUrl(value.url)) &&
    (value.headers === undefined || isMcpDictionary(value.headers)) &&
    (value.environment === undefined || isMcpDictionary(value.environment, true)) &&
    (value.id === undefined || probe && isMcpId(value.id))
}
const oauthFields = ['resource_url', 'authorization_server_url', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint', 'scopes', 'code_challenge_methods_supported', 'client_id', 'client_secret', 'registration_method', 'discovered_at']
function metadata(value: unknown): boolean {
  if (!shape(value, [], oauthFields)) return false
  return Object.entries(value).every(([key, entry]) => key === 'client_secret' ? entry === '' || entry === MCP_SECRET_SET_MARKER
    : key === 'code_challenge_methods_supported' ? Array.isArray(entry) && entry.length <= 16 && entry.every(item => mcpText(item, 64))
    : mcpText(entry, key.endsWith('_url') || key.endsWith('_endpoint') ? 4096 : 8192))
}
const toolDescription = (value: unknown): boolean => typeof value === 'string' && !value.includes('\0') && new TextEncoder().encode(value).length <= MCP_LIMITS.field
const tools = (value: unknown): boolean => Array.isArray(value) && value.length <= MCP_LIMITS.tools && value.every(tool => shape(tool, ['name', 'description']) && mcpText(tool.name, 256) && !!tool.name && toolDescription(tool.description))
function row(value: unknown): boolean {
  return shape(value, ['id', ...fields, 'tools', 'oauth_metadata', 'source', 'created_at', 'updated_at']) && isMcpId(value.id) &&
    isMcpData(Object.fromEntries(fields.map(key => [key, value[key]])), true) && tools(value.tools) && metadata(value.oauth_metadata) &&
    isMcpDictionary(value.headers, false, true) && isMcpDictionary(value.environment, true, true) &&
    ['user', 'plugin'].includes(value.source as string) && mcpText(value.created_at, 32) && mcpText(value.updated_at, 32)
}
export function projectMcpServer(value: unknown): JsonValue {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const mask = (input: unknown, environment: boolean): Record<string, JsonValue> => {
    if (!isMcpDictionary(input, environment)) return fail('INVALID_RESULT')
    return Object.fromEntries(Object.entries(input).map(([key, secret]) => [key, secret ? MCP_SECRET_SET_MARKER : '']))
  }
  if (!isRecord(value.oauth_metadata)) return fail('INVALID_RESULT')
  const oauth = Object.fromEntries(Object.entries(value.oauth_metadata).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, key === 'client_secret' && entry ? MCP_SECRET_SET_MARKER : entry]))
  const projected = { ...value, headers: mask(value.headers, false), environment: mask(value.environment, true), oauth_metadata: oauth }
  if (!row(projected) || !bounded(projected, MCP_LIMITS.result)) return fail('INVALID_RESULT')
  return projected as JsonValue
}
interface Descriptor { args(value: unknown[]): boolean; keys: string[]; result(value: unknown): boolean; project?(value: unknown): unknown }
const id = (args: unknown[]): boolean => args.length === 1 && isMcpId(args[0])
const optional = (value: unknown): boolean => shape(value, [], ['needsManualClientId']) && (value.needsManualClientId === undefined || typeof value.needsManualClientId === 'boolean')
const descriptors: Record<McpOperation, Descriptor> = {
  'mcp:getAll': { args: args => args.length === 0, keys: [], result: value => Array.isArray(value) && value.length <= MCP_LIMITS.servers && value.every(row), project: value => Array.isArray(value) && value.length <= MCP_LIMITS.servers ? value.map(projectMcpServer) : fail('INVALID_RESULT') },
  'mcp:create': { args: args => args.length === 1 && isMcpData(args[0], true), keys: ['data'], result: row, project: projectMcpServer },
  'mcp:update': { args: args => args.length === 2 && isMcpId(args[0]) && isMcpData(args[1], false), keys: ['id', 'data'], result: value => value === undefined || row(value), project: value => value === undefined ? undefined : projectMcpServer(value) },
  'mcp:delete': { args: id, keys: ['id'], result: value => typeof value === 'boolean' },
  'mcp:testConnection': { args: args => args.length === 1 && isMcpData(args[0], true, true), keys: ['data'], result: value => shape(value, ['status'], ['error', 'toolCount', 'tools']) && ['connected', 'failed'].includes(value.status as string) && (value.error === undefined || value.error === 'MCP probe failed') && (value.toolCount === undefined || Number.isSafeInteger(value.toolCount) && Number(value.toolCount) >= 0 && Number(value.toolCount) <= MCP_LIMITS.tools) && (value.tools === undefined || tools(value.tools)) },
  'mcp:startOAuthFlow': { args: id, keys: ['id'], result: optional },
  'mcp:getOAuthStatus': { args: id, keys: ['id'], result: value => shape(value, ['connected'], ['expiresAt']) && typeof value.connected === 'boolean' && (value.expiresAt === undefined || mcpText(value.expiresAt, 32)) },
  'mcp:revokeOAuthToken': { args: id, keys: ['id'], result: value => value === undefined },
  'mcp:probeForAuth': { args: args => args.length === 1 && isMcpUrl(args[0]), keys: ['url'], result: value => shape(value, ['requiresAuth']) && typeof value.requiresAuth === 'boolean' },
  'mcp:submitManualClientId': { args: args => args.length === 2 && isMcpId(args[0]) && mcpText(args[1], 1024) && !!args[1], keys: ['id', 'clientId'], result: optional }
}
function codec<K extends McpOperation>(operation: K): McpCodec<K> {
  const descriptor = descriptors[operation]
  const valid = (value: unknown): boolean => value === undefined ? descriptor.result(value) : bounded(value, MCP_LIMITS.result) && descriptor.result(value)
  return {
    validateArguments: value => Array.isArray(value) && descriptor.args(value),
    encodeArguments(args) { if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return Object.fromEntries(descriptor.keys.map((key, index) => [key, args[index]])) as JsonValue },
    decodeArguments(payload) { if (!shape(payload, descriptor.keys)) return fail('INVALID_ARGUMENTS'); const args = descriptor.keys.map(key => payload[key]); if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateResult: valid,
    encodeResult(value) { const projected = descriptor.project ? descriptor.project(value) : value; if (!valid(projected)) return fail('INVALID_RESULT'); return projected === undefined ? { defined: false } : { defined: true, value: projected as JsonValue } },
    decodeResult(value) { if (!valid(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult(value) { return shape(value, ['defined'], ['value']) && (value.defined === false ? !Object.hasOwn(value, 'value') && valid(undefined) : value.defined === true && Object.hasOwn(value, 'value') && valid(value.value)) }
  }
}
export const MCP_CODECS = Object.fromEntries(MCP_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in McpOperation]: McpCodec<K> }
