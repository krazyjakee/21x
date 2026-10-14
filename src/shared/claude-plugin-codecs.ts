import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const CLAUDE_PLUGIN_OPERATIONS = ['claudePlugin:getMarketplaceSources', 'claudePlugin:addMarketplaceSource', 'claudePlugin:removeMarketplaceSource', 'claudePlugin:fetchCatalog', 'claudePlugin:discoverPlugins', 'claudePlugin:getInstalledPlugins', 'claudePlugin:installPlugin', 'claudePlugin:uninstallPlugin', 'claudePlugin:enablePlugin', 'claudePlugin:disablePlugin', 'claudePlugin:getPluginResources'] as const
export type ClaudePluginOperation = typeof CLAUDE_PLUGIN_OPERATIONS[number]
export const CLAUDE_PLUGIN_LIMITS = { rows: 128, entries: 512, resources: 256, field: 8192, result: 768 * 1024 } as const
export const CLAUDE_PLUGIN_LOCAL_SOURCE = '__21x_local_source__'
export interface ClaudePluginCodec<K extends ClaudePluginOperation> {
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
export const pluginText = (value: unknown, max: number = CLAUDE_PLUGIN_LIMITS.field): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && new TextEncoder().encode(value).length <= max
export const pluginId = (value: unknown): value is string => pluginText(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
export const pluginName = (value: unknown): value is string => pluginText(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
const list = (value: unknown, max = 64, field = 256): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => pluginText(item, field))
const bounded = (value: unknown): boolean => isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).length <= CLAUDE_PLUGIN_LIMITS.result
export function pluginRelative(value: unknown): value is string {
  if (!pluginText(value, 4096) || /^[\/]/.test(value) || value.includes('\\')) return false
  const path = value.replace(/^\.\//, '')
  return path === '' || path.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[\/:%]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}
export function pluginUrl(value: unknown): value is string {
  if (!pluginText(value, 4096)) return false
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search } catch { return false }
}
export function pluginRepo(value: unknown): value is string {
  if (!pluginText(value, 4096)) return false
  const [slug, ref, extra] = value.split('#')
  return extra === undefined && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) && slug.split('/').every(pluginName) && (ref === undefined || !!ref && pluginRelative(ref))
}
export function pluginMarketplaceInput(value: unknown): value is Record<string, unknown> {
  if (!shape(value, ['name', 'source_url'], ['source_type', 'auto_update']) || !(pluginText(value.name, 256) && !!value.name.trim()) || value.auto_update !== undefined && typeof value.auto_update !== 'boolean') return false
  const type = value.source_type ?? 'github'
  return type === 'github' ? pluginRepo(value.source_url) : type === 'url' ? pluginUrl(value.source_url) : type === 'local' && pluginText(value.source_url, 4096) && !!value.source_url && value.source_url !== CLAUDE_PLUGIN_LOCAL_SOURCE
}
function source(value: unknown): boolean {
  return shape(value, [], ['source', 'repo', 'url', 'ref', 'sha', 'path', 'version']) && Object.entries(value).every(([key, entry]) => key === 'source' ? ['github', 'url', 'local'].includes(entry as string) : key === 'repo' ? pluginRepo(entry) : key === 'url' ? pluginUrl(entry) : key === 'path' || key === 'ref' ? pluginRelative(entry) : pluginText(entry, 256))
}
export function publicPluginSource(value: unknown): JsonValue {
  if (typeof value === 'string') return pluginRelative(value) ? value : fail('INVALID_RESULT')
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const allowed = ['source', 'repo', 'url', 'ref', 'sha', 'path', 'version']
  const projected = Object.fromEntries(allowed.flatMap(key => value[key] === undefined ? [] : [[key, value[key]]]))
  if (!source(projected) || !isJsonValue(projected)) return fail('INVALID_RESULT')
  return projected
}
function author(value: unknown): { name: string } {
  const name = typeof value === 'string' ? value : isRecord(value) ? value.name : undefined
  if (!pluginText(name, 256)) return fail('INVALID_RESULT')
  return { name }
}
const safeLink = (value: unknown): string => value === undefined || value === '' ? '' : pluginUrl(value) ? value : fail('INVALID_RESULT')
function publicManifest(value: unknown): JsonValue {
  if (!isRecord(value) || !pluginName(value.name)) return fail('INVALID_RESULT')
  const out: Record<string, JsonValue> = { name: value.name }
  for (const key of ['version', 'description', 'license'] as const) if (value[key] !== undefined) { if (!pluginText(value[key], key === 'description' ? 8192 : 256)) return fail('INVALID_RESULT'); out[key] = value[key] }
  if (value.author !== undefined) out.author = author(value.author)
  for (const key of ['homepage', 'repository'] as const) if (value[key] !== undefined) out[key] = safeLink(value[key])
  if (value.keywords !== undefined) { if (!list(value.keywords)) return fail('INVALID_RESULT'); out.keywords = value.keywords }
  return out
}
function marketplace(value: unknown): boolean {
  return shape(value, ['id', 'name', 'source_type', 'source_url', 'metadata', 'auto_update', 'created_at', 'updated_at']) && pluginId(value.id) && pluginText(value.name, 256) && !!value.name.trim() &&
    (value.source_type === 'local' ? value.source_url === CLAUDE_PLUGIN_LOCAL_SOURCE : value.source_type === 'github' ? pluginRepo(value.source_url) : value.source_type === 'url' && pluginUrl(value.source_url)) && shape(value.metadata, []) && typeof value.auto_update === 'boolean' && pluginText(value.created_at, 32) && pluginText(value.updated_at, 32)
}
function projectMarketplace(value: unknown): unknown {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  return { id: value.id, name: value.name, source_type: value.source_type, source_url: value.source_type === 'local' ? CLAUDE_PLUGIN_LOCAL_SOURCE : value.source_url, metadata: {}, auto_update: value.auto_update, created_at: value.created_at, updated_at: value.updated_at }
}
function installed(value: unknown): boolean {
  if (!shape(value, ['id', 'name', 'marketplace_id', 'manifest', 'source', 'scope', 'enabled', 'version', 'installed_at', 'updated_at']) || !pluginId(value.id) || !pluginName(value.name) || !(value.marketplace_id === null || pluginId(value.marketplace_id)) || value.scope !== 'user' || typeof value.enabled !== 'boolean' || !pluginText(value.version, 256) || !pluginText(value.installed_at, 32) || !pluginText(value.updated_at, 32) || !source(value.source)) return false
  if (!shape(value.manifest, ['name'], ['version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'])) return false
  try { return canonical(publicManifest(value.manifest)) === canonical(value.manifest) } catch { return false }
}
function projectInstalled(value: unknown): unknown {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const projectedSource = publicPluginSource(value.source)
  if (typeof projectedSource === 'string') return fail('INVALID_RESULT')
  return { id: value.id, name: value.name, marketplace_id: value.marketplace_id, manifest: publicManifest(value.manifest), source: projectedSource, scope: value.scope, enabled: value.enabled, version: value.version, installed_at: value.installed_at, updated_at: value.updated_at }
}
function catalogEntry(value: unknown): unknown {
  if (!isRecord(value) || !pluginName(value.name)) return fail('INVALID_RESULT')
  const out: Record<string, unknown> = { name: value.name, source: publicPluginSource(value.source) }
  for (const key of ['description', 'version', 'category', 'license'] as const) if (value[key] !== undefined) { if (!pluginText(value[key], key === 'description' ? 8192 : 256)) return fail('INVALID_RESULT'); out[key] = value[key] }
  if (value.author !== undefined) out.author = author(value.author)
  for (const key of ['homepage', 'repository'] as const) if (value[key] !== undefined) out[key] = safeLink(value[key])
  for (const key of ['tags', 'keywords'] as const) if (value[key] !== undefined) { if (!list(value[key])) return fail('INVALID_RESULT'); out[key] = value[key] }
  return out
}
function projectCatalog(value: unknown): unknown {
  if (value === null) return null
  if (!isRecord(value) || !pluginText(value.name, 256) || !Array.isArray(value.plugins) || value.plugins.length > CLAUDE_PLUGIN_LIMITS.entries) return fail('INVALID_RESULT')
  const out: Record<string, unknown> = { name: value.name, owner: author(value.owner), plugins: value.plugins.map(catalogEntry) }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) return fail('INVALID_RESULT')
    const metadata: Record<string, string> = {}
    for (const key of ['description', 'version']) if (value.metadata[key] !== undefined) { if (!pluginText(value.metadata[key], key === 'description' ? 8192 : 256)) return fail('INVALID_RESULT'); metadata[key] = value.metadata[key] }
    out.metadata = metadata
  }
  return out
}
function publicDiscovery(value: unknown): unknown {
  if (!isRecord(value)) return fail('INVALID_RESULT')
  const out: Record<string, unknown> = {}
  for (const key of ['name', 'description', 'version', 'author', 'category', 'tags', 'homepage', 'repository', 'license', 'marketplace_id', 'marketplace_name', 'installed', 'installed_plugin_id', 'enabled']) if (value[key] !== undefined) out[key] = value[key]
  out.source = publicPluginSource(value.source)
  return out
}
function discovery(value: unknown): boolean {
  return shape(value, ['name', 'description', 'version', 'author', 'category', 'tags', 'homepage', 'repository', 'license', 'marketplace_id', 'marketplace_name', 'source', 'installed'], ['installed_plugin_id', 'enabled']) && pluginName(value.name) && pluginText(value.description) && pluginText(value.version, 256) && pluginText(value.author, 256) && pluginText(value.category, 256) && list(value.tags) && (value.homepage === '' || pluginUrl(value.homepage)) && (value.repository === '' || pluginUrl(value.repository)) && pluginText(value.license, 256) && pluginId(value.marketplace_id) && pluginText(value.marketplace_name, 256) && (typeof value.source === 'string' ? pluginRelative(value.source) : source(value.source)) && typeof value.installed === 'boolean' && (value.installed_plugin_id === undefined || pluginId(value.installed_plugin_id)) && (value.enabled === undefined || typeof value.enabled === 'boolean')
}
export function projectPluginResources(value: unknown): unknown {
  if (!shape(value, ['skills', 'mcpServers', 'agents', 'commands'])) return fail('INVALID_RESULT')
  const resources = (input: unknown, kind: string): unknown[] => {
    if (!Array.isArray(input) || input.length > CLAUDE_PLUGIN_LIMITS.resources) return fail('INVALID_RESULT')
    return input.map(item => {
      if (!isRecord(item) || !pluginId(item.id) || !pluginText(item.name, 256)) return fail('INVALID_RESULT')
      return kind === 'mcp' ? { id: item.id, name: item.name, command: '', args: [] } : { id: item.id, name: item.name, description: kind === 'agent' ? '' : pluginText(item.description) ? item.description : fail('INVALID_RESULT') }
    })
  }
  if (!Array.isArray(value.commands) || value.commands.length > CLAUDE_PLUGIN_LIMITS.resources) return fail('INVALID_RESULT')
  const commands = value.commands.map(command => { const name = typeof command === 'string' ? command : isRecord(command) ? command.name : undefined; return pluginRelative(name) ? name : fail('INVALID_RESULT') })
  return { skills: resources(value.skills, 'skill'), mcpServers: resources(value.mcpServers, 'mcp'), agents: resources(value.agents, 'agent'), commands }
}
interface Descriptor { keys: string[]; optional?: string[]; args(value: unknown[]): boolean; result(value: unknown): boolean; project?(value: unknown): unknown }
const array = (value: unknown, validate: (entry: unknown) => boolean, maximum: number = CLAUDE_PLUGIN_LIMITS.rows): boolean => Array.isArray(value) && value.length <= maximum && value.every(validate)
const idArgs = (args: unknown[]): boolean => args.length === 1 && pluginId(args[0])
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) return fail('INVALID_RESULT')
  if (Array.isArray(value)) return '[' + value.map(entry => canonical(entry, depth + 1)).join(',') + ']'
  if (isRecord(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}'
  if (!isJsonValue(value)) return fail('INVALID_RESULT')
  return JSON.stringify(value)
}
const unchanged = (value: unknown, projection: (entry: unknown) => unknown): boolean => { try { return canonical(projection(value)) === canonical(value) } catch { return false } }
const descriptors: Record<ClaudePluginOperation, Descriptor> = {
  'claudePlugin:getMarketplaceSources': { keys: [], args: args => !args.length, result: value => array(value, marketplace), project: value => Array.isArray(value) && value.length <= CLAUDE_PLUGIN_LIMITS.rows ? value.map(projectMarketplace) : fail('INVALID_RESULT') },
  'claudePlugin:addMarketplaceSource': { keys: ['data'], args: args => args.length === 1 && pluginMarketplaceInput(args[0]), result: marketplace, project: projectMarketplace },
  'claudePlugin:removeMarketplaceSource': { keys: ['id'], args: idArgs, result: value => typeof value === 'boolean' },
  'claudePlugin:fetchCatalog': { keys: ['sourceId'], args: idArgs, result: value => unchanged(value, projectCatalog), project: projectCatalog },
  'claudePlugin:discoverPlugins': { keys: [], optional: ['searchQuery'], args: args => args.length <= 1 && (args[0] === undefined || pluginText(args[0], 256)), result: value => array(value, discovery, CLAUDE_PLUGIN_LIMITS.entries), project: value => Array.isArray(value) && value.length <= CLAUDE_PLUGIN_LIMITS.entries ? value.map(publicDiscovery) : fail('INVALID_RESULT') },
  'claudePlugin:getInstalledPlugins': { keys: [], args: args => !args.length, result: value => array(value, installed), project: value => Array.isArray(value) && value.length <= CLAUDE_PLUGIN_LIMITS.rows ? value.map(projectInstalled) : fail('INVALID_RESULT') },
  'claudePlugin:installPlugin': { keys: ['pluginName', 'marketplaceId'], optional: ['scope'], args: args => args.length >= 2 && args.length <= 3 && pluginName(args[0]) && pluginId(args[1]) && (args[2] === undefined || args[2] === 'user'), result: installed, project: projectInstalled },
  'claudePlugin:uninstallPlugin': { keys: ['pluginId'], args: idArgs, result: value => typeof value === 'boolean' },
  'claudePlugin:enablePlugin': { keys: ['pluginId'], args: idArgs, result: value => value === undefined || installed(value), project: value => value === undefined ? undefined : projectInstalled(value) },
  'claudePlugin:disablePlugin': { keys: ['pluginId'], args: idArgs, result: value => value === undefined || installed(value), project: value => value === undefined ? undefined : projectInstalled(value) },
  'claudePlugin:getPluginResources': { keys: ['pluginId'], args: idArgs, result: value => unchanged(value, projectPluginResources), project: projectPluginResources }
}
function codec<K extends ClaudePluginOperation>(operation: K): ClaudePluginCodec<K> {
  const descriptor = descriptors[operation], keys = [...descriptor.keys, ...(descriptor.optional ?? [])]
  const valid = (value: unknown): boolean => descriptor.result(value) && (value === undefined || bounded(value))
  return {
    validateArguments: value => Array.isArray(value) && descriptor.args(value),
    encodeArguments(args) { if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return Object.fromEntries(keys.flatMap((key, index) => args[index] === undefined ? [] : [[key, key === 'data' && isRecord(args[index]) ? Object.fromEntries(Object.entries(args[index]).filter(([, entry]) => entry !== undefined)) : args[index]]])) as JsonValue },
    decodeArguments(payload) { if (!shape(payload, descriptor.keys, descriptor.optional)) return fail('INVALID_ARGUMENTS'); const args = keys.flatMap(key => Object.hasOwn(payload, key) ? [payload[key]] : []); if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateResult: valid,
    encodeResult(value) { const projected = descriptor.project ? descriptor.project(value) : value; if (!valid(projected)) return fail('INVALID_RESULT'); return projected === undefined ? { defined: false } : { defined: true, value: projected as JsonValue } },
    decodeResult(value) { if (!valid(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult(value) { return shape(value, ['defined'], ['value']) && (value.defined === false ? !Object.hasOwn(value, 'value') && valid(undefined) : value.defined === true && Object.hasOwn(value, 'value') && valid(value.value)) }
  }
}
export const CLAUDE_PLUGIN_CODECS = Object.fromEntries(CLAUDE_PLUGIN_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in ClaudePluginOperation]: ClaudePluginCodec<K> }
