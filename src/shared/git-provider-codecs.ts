import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const GIT_PROVIDER_OPERATIONS = ['github:checkCli', 'github:fetchOrgs', 'github:fetchOrgRepos', 'github:fetchUserRepos', 'github:fetchPullRequestDetails', 'gitlab:checkCli', 'gitlab:fetchOrgs', 'gitlab:fetchOrgRepos', 'gitlab:fetchUserRepos', 'forgejo:checkCli', 'forgejo:setLogin', 'forgejo:fetchOrgs', 'forgejo:fetchOrgRepos', 'forgejo:fetchUserRepos', 'git:recordRepoProviders'] as const
export type GitProviderOperation = typeof GIT_PROVIDER_OPERATIONS[number]
export const GIT_PROVIDER_LIMITS = { resultBytes: 890_000, repositories: 2048, organizations: 512, logins: 64, checks: 128, requestRepositories: 128, providerMapEntries: 4096, providerMapBytes: 524_288, bodyBytes: 131_072 } as const
export const GIT_PROVIDER_TEA_MESSAGES = {
  ready: undefined,
  'not-installed': 'The tea CLI is unavailable.',
  'no-login': 'No tea login is configured.',
  'login-selection-required': 'Choose a configured tea login.',
  'login-not-found': 'The selected tea login is unavailable.',
  unauthorized: 'The configured tea login was not authorized.',
  unreachable: 'The configured Forgejo server could not be reached.',
  error: 'The Forgejo request failed.'
} as const
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => isRecord(v) && hasExactKeys(v, required, optional)
const text = (v: unknown, max = 256, multiline = false): v is string => typeof v === 'string' && new TextEncoder().encode(v).length <= max && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(v) && !/^(?:gh[pousr]_|github_pat_|glpat-|bearer\s|__21x_)/i.test(v)
const segment = (v: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(v) && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(v)
export const gitProviderActor = (v: unknown): v is string => text(v, 128) && /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\[bot\])?$/.test(v)
export const gitProviderRepository = (v: unknown): v is string => text(v, 512) && v.split('/').length >= 2 && v.split('/').length <= 16 && v.split('/').every(segment)
export const gitProviderOrganization = (v: unknown): v is string => text(v, 512) && v.split('/').length <= 15 && v.split('/').every(segment)
export const gitProviderLoginName = (v: unknown): v is string => text(v, 128) && v === v.trim() && /^[A-Za-z0-9][A-Za-z0-9 ._@-]*$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v)
const provider = (v: unknown): boolean => ['github', 'gitlab', 'forgejo'].includes(v as string)
const count = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0
export function gitProviderAddress(v: unknown): v is string {
  if (!text(v, 2048) || v !== v.trim()) return false
  try { const url = new URL(v); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash } catch { return false }
}
export function gitProviderPullRequestAddress(v: unknown): v is string {
  if (!gitProviderAddress(v)) return false
  const url = new URL(v), parts = url.pathname.split('/').filter(Boolean)
  return parts.length === 4 && parts.slice(0, 2).every(segment) && (url.hostname.toLowerCase() === 'github.com' ? url.protocol === 'https:' && parts[2] === 'pull' && !url.port : parts[2] === 'pulls') && /^[1-9]\d{0,9}$/.test(parts[3]!)
}
/** URL fields cannot carry credential userinfo or signed/token query values. */
function publicAddress(v: unknown): string {
  if (!text(v, 2048)) return fail('INVALID_RESULT')
  try { const url = new URL(v); if (!['http:', 'https:'].includes(url.protocol)) return fail('INVALID_RESULT'); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href } catch { return fail('INVALID_RESULT') }
}
function publicSshHost(v: unknown): string {
  if (!text(v, 512)) return fail('INVALID_RESULT')
  if (!v) return ''
  try { const url = new URL(v.includes('://') ? v : `ssh://${v}`); if (!['ssh:', 'http:', 'https:'].includes(url.protocol) || !url.hostname) return fail('INVALID_RESULT'); return url.host } catch { return fail('INVALID_RESULT') }
}
const cli = (v: unknown): boolean => shape(v, ['installed', 'authenticated'], ['username']) && typeof v.installed === 'boolean' && typeof v.authenticated === 'boolean' && (!v.authenticated || v.installed) && (v.username === undefined || gitProviderActor(v.username))
function cliProjection(v: unknown): unknown { if (!isRecord(v)) return fail('INVALID_RESULT'); return { installed: v.installed, authenticated: v.authenticated, ...(v.username === undefined ? {} : { username: v.username }) } }
const login = (v: unknown): boolean => shape(v, ['name', 'url', 'sshHost', 'user', 'isDefault']) && gitProviderLoginName(v.name) && gitProviderAddress(v.url) && text(v.sshHost, 512) && (!v.sshHost || /^[A-Za-z0-9.[\]:-]+$/.test(v.sshHost)) && text(v.user, 128) && typeof v.isDefault === 'boolean'
const tea = (v: unknown): boolean => shape(v, ['installed', 'authenticated', 'logins', 'code'], ['username', 'login', 'serverUrl', 'message']) && typeof v.installed === 'boolean' && typeof v.authenticated === 'boolean' && (!v.authenticated || v.installed) && (v.username === undefined || text(v.username, 128) && segment(v.username)) && (v.login === undefined || gitProviderLoginName(v.login)) && (v.serverUrl === undefined || gitProviderAddress(v.serverUrl)) && Array.isArray(v.logins) && v.logins.length <= GIT_PROVIDER_LIMITS.logins && v.logins.every(login) && new Set(v.logins.map(row => row.name)).size === v.logins.length && typeof v.code === 'string' && Object.hasOwn(GIT_PROVIDER_TEA_MESSAGES, v.code) && (v.message === undefined || v.message === GIT_PROVIDER_TEA_MESSAGES[v.code as keyof typeof GIT_PROVIDER_TEA_MESSAGES])
function teaProjection(v: unknown): unknown {
  if (!isRecord(v) || !Array.isArray(v.logins) || v.logins.length > GIT_PROVIDER_LIMITS.logins || typeof v.code !== 'string' || !Object.hasOwn(GIT_PROVIDER_TEA_MESSAGES, v.code)) return fail('INVALID_RESULT')
  const message = GIT_PROVIDER_TEA_MESSAGES[v.code as keyof typeof GIT_PROVIDER_TEA_MESSAGES]
  return { installed: v.installed, authenticated: v.authenticated, logins: v.logins.map(row => { if (!isRecord(row)) return fail('INVALID_RESULT'); return { name: row.name, url: publicAddress(row.url), sshHost: publicSshHost(row.sshHost), user: row.user, isDefault: row.isDefault } }), code: v.code,
    ...(v.username === undefined ? {} : { username: v.username }), ...(v.login === undefined ? {} : { login: v.login }), ...(v.serverUrl === undefined ? {} : { serverUrl: publicAddress(v.serverUrl) }), ...(message === undefined ? {} : { message }) }
}
const repo = (v: unknown): boolean => shape(v, ['name', 'fullName', 'defaultBranch', 'cloneUrl', 'description', 'isPrivate']) && text(v.name, 128) && segment(v.name) && gitProviderRepository(v.fullName) && v.fullName.split('/').at(-1) === v.name && text(v.defaultBranch, 256) && v.defaultBranch.length > 0 && gitProviderAddress(v.cloneUrl) && text(v.description, 4096, true) && typeof v.isPrivate === 'boolean'
function reposProjection(v: unknown): unknown { if (!Array.isArray(v) || v.length > GIT_PROVIDER_LIMITS.repositories) return fail('INVALID_RESULT'); return v.map(row => { if (!isRecord(row)) return fail('INVALID_RESULT'); return { name: row.name, fullName: row.fullName, defaultBranch: row.defaultBranch, cloneUrl: publicAddress(row.cloneUrl), description: row.description, isPrivate: row.isPrivate } }) }
const repos = (v: unknown): boolean => Array.isArray(v) && v.length <= GIT_PROVIDER_LIMITS.repositories && v.every(repo) && new Set(v.map(row => row.fullName)).size === v.length
const organizations = (v: unknown): boolean => Array.isArray(v) && v.length <= GIT_PROVIDER_LIMITS.organizations && v.every(gitProviderOrganization) && new Set(v).size === v.length
const check = (v: unknown): boolean => shape(v, ['name', 'state'], ['url']) && text(v.name, 256) && ['passed', 'failed', 'pending', 'skipped'].includes(v.state as string) && (v.url === undefined || gitProviderAddress(v.url))
const author = (v: unknown): boolean => shape(v, ['login'], ['avatarUrl', 'url']) && gitProviderActor(v.login) && (v.avatarUrl === undefined || gitProviderAddress(v.avatarUrl)) && (v.url === undefined || gitProviderAddress(v.url))
const prKeys = ['url', 'repository', 'number', 'title', 'body', 'state', 'isDraft', 'reviewDecision', 'author', 'baseRefName', 'headRefName', 'additions', 'deletions', 'changedFiles', 'commentsCount', 'reviewsCount', 'createdAt', 'updatedAt']
const prOptional = ['mergeStateStatus', 'mergedAt', 'closedAt']
const pr = (v: unknown): boolean => shape(v, [...prKeys, 'checks'], prOptional) && gitProviderPullRequestAddress(v.url) && gitProviderRepository(v.repository) && count(v.number) && Number(v.number) > 0 && text(v.title, 1024) && text(v.body, GIT_PROVIDER_LIMITS.bodyBytes, true) && ['open', 'closed', 'merged'].includes(v.state as string) && typeof v.isDraft === 'boolean' && ['approved', 'changes_requested', 'review_required', 'none'].includes(v.reviewDecision as string) && author(v.author) && ['baseRefName', 'headRefName'].every(key => text(v[key], 256)) && ['additions', 'deletions', 'changedFiles', 'commentsCount', 'reviewsCount'].every(key => count(v[key])) && ['createdAt', 'updatedAt'].every(key => text(v[key], 64)) && prOptional.every(key => v[key] === undefined || text(v[key], key === 'mergeStateStatus' ? 128 : 64)) && Array.isArray(v.checks) && v.checks.length <= GIT_PROVIDER_LIMITS.checks && v.checks.every(check)
function prProjection(v: unknown): unknown {
  if (!isRecord(v) || !isRecord(v.author) || !Array.isArray(v.checks) || v.checks.length > GIT_PROVIDER_LIMITS.checks) return fail('INVALID_RESULT')
  return { ...Object.fromEntries(prKeys.filter(key => key !== 'author' && key !== 'url').map(key => [key, v[key]])), url: publicAddress(v.url), author: { login: v.author.login, ...(v.author.avatarUrl === undefined ? {} : { avatarUrl: publicAddress(v.author.avatarUrl) }), ...(v.author.url === undefined ? {} : { url: publicAddress(v.author.url) }) },
    ...Object.fromEntries(prOptional.filter(key => v[key] !== undefined).map(key => [key, v[key]])), checks: v.checks.map(row => { if (!isRecord(row)) return fail('INVALID_RESULT'); return { name: row.name, state: row.state, ...(row.url === undefined ? {} : { url: publicAddress(row.url) }) } }) }
}
interface Descriptor { keys: string[]; args(v: unknown[]): boolean; result(v: unknown): boolean; project?(v: unknown): unknown; optional?: boolean }
const noArgs = (v: unknown[]): boolean => v.length === 0
const descriptors = Object.fromEntries(GIT_PROVIDER_OPERATIONS.map(op => {
  const descriptor: Descriptor = op === 'git:recordRepoProviders' ? { keys: ['repoFullNames', 'provider'], args: args => args.length === 2 && Array.isArray(args[0]) && args[0].length <= GIT_PROVIDER_LIMITS.requestRepositories && args[0].every(gitProviderRepository) && new Set(args[0]).size === args[0].length && provider(args[1]), result: v => v === undefined, optional: true }
    : op === 'forgejo:setLogin' ? { keys: ['loginName'], args: args => args.length === 1 && (args[0] === null || gitProviderLoginName(args[0])), result: tea, project: teaProjection }
    : op.endsWith(':checkCli') ? { keys: [], args: noArgs, result: op.startsWith('forgejo:') ? tea : cli, project: op.startsWith('forgejo:') ? teaProjection : cliProjection }
    : op.endsWith(':fetchOrgs') ? { keys: [], args: noArgs, result: organizations }
    : op.endsWith(':fetchOrgRepos') ? { keys: ['org'], args: args => args.length === 1 && gitProviderOrganization(args[0]) && (op.startsWith('gitlab:') || !args[0].includes('/')), result: repos, project: reposProjection }
    : op.endsWith(':fetchUserRepos') ? { keys: [], args: noArgs, result: repos, project: reposProjection }
    : { keys: ['url'], args: args => args.length === 1 && gitProviderPullRequestAddress(args[0]), result: pr, project: prProjection }
  return [op, descriptor]
})) as Record<GitProviderOperation, Descriptor>
export interface GitProviderCodec<K extends GitProviderOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends GitProviderOperation>(operation: K): GitProviderCodec<K> {
  const descriptor = descriptors[operation]
  const valid = (v: unknown): boolean => descriptor.result(v) && (descriptor.optional ? v === undefined : isJsonValue(v) && new TextEncoder().encode(JSON.stringify({ defined: true, value: v })).length < GIT_PROVIDER_LIMITS.resultBytes)
  return {
    validateArguments: v => Array.isArray(v) && descriptor.args(v),
    encodeArguments(args) { if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return Object.fromEntries(descriptor.keys.map((key, index) => [key, args[index]])) as JsonValue },
    decodeArguments(payload) { if (!shape(payload, descriptor.keys)) return fail('INVALID_ARGUMENTS'); const args = descriptor.keys.map(key => payload[key]); if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateResult: valid,
    encodeResult(value) { const projected = descriptor.project ? descriptor.project(value) : value; if (!valid(projected)) return fail('INVALID_RESULT'); return descriptor.optional ? { defined: false } : { defined: true, value: projected as JsonValue } },
    decodeResult(value) { if (!valid(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] },
    validateWireResult: value => descriptor.optional ? shape(value, ['defined']) && value.defined === false : shape(value, ['defined', 'value']) && value.defined === true && valid(value.value)
  }
}
export const GIT_PROVIDER_CODECS = Object.fromEntries(GIT_PROVIDER_OPERATIONS.map(operation => [operation, codec(operation)])) as { [K in GitProviderOperation]: GitProviderCodec<K> }
export const GIT_PROVIDER_COMMAND_CODECS = GIT_PROVIDER_CODECS
