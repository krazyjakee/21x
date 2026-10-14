import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { gitProviderOrganization, gitProviderRepository, gitProviderAddress } from './git-provider-codecs'
import { workspaceFileAbsolutePath } from './workspace-file-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const WORKTREE_RUNTIME_OPERATIONS = ['worktree:setup', 'worktree:changes', 'worktree:files', 'worktree:readFile', 'worktree:cleanup', 'workspace:runCleanupNow'] as const
export type WorktreeRuntimeOperation = typeof WORKTREE_RUNTIME_OPERATIONS[number]
export const WORKTREE_RUNTIME_LIMITS = { repositories: 128, files: 4096, pathBytes: 4096, previewBytes: 128 * 1024, diffBytes: 128 * 1024, stdoutBytes: 128 * 1024, aggregateBytes: 512 * 1024, scannedEntries: 8192, depth: 64, resultBytes: 890000, requests: 16, errors: 128 } as const
export const WORKTREE_RUNTIME_ERROR = 'The worktree operation could not be completed.'
export const WORKSPACE_RUNTIME_ERROR = 'The workspace cleanup could not be completed.'
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => isRecord(v) && hasExactKeys(v, required, optional)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && new TextEncoder().encode(v).length <= max && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(v)) === v
const label = (v: unknown, max = 512): v is string => text(v, max) && !/[\u0000-\u001f\u007f]/.test(v)
const count = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0
export const worktreeRuntimeFilePath = (v: unknown): v is string => label(v, WORKTREE_RUNTIME_LIMITS.pathBytes) && !!v && !/^(?:[\\/]|[A-Za-z]:)/.test(v) && v.replace(/\\/g, '/').replace(/^\.\//, '').split('/').length <= WORKTREE_RUNTIME_LIMITS.depth && v.replace(/\\/g, '/').replace(/^\.\//, '').split('/').every(segment => !!segment && segment !== '.' && segment !== '..')
export const worktreeRuntimeBranch = (v: unknown): v is string => label(v, 1024) && !!v && !/^[-/]/.test(v) && !/[\u0020~^:?*\[\\]/.test(v) && !v.includes('..') && !v.includes('@{') && !v.includes('//') && v.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
const repos = (v: unknown, setup = false): boolean => Array.isArray(v) && v.length <= WORKTREE_RUNTIME_LIMITS.repositories && v.every(row => shape(row, setup ? ['fullName', 'defaultBranch'] : ['fullName']) && gitProviderRepository(row.fullName) && (!setup || worktreeRuntimeBranch(row.defaultBranch))) && new Set(v.map(row => row.fullName)).size === v.length && new Set(v.map(row => row.fullName.split('/').at(-1))).size === v.length
const files = (v: unknown): boolean => Array.isArray(v) && v.length <= WORKTREE_RUNTIME_LIMITS.files && v.every(worktreeRuntimeFilePath) && new Set(v).size === v.length
function row(v: unknown, diff: boolean): boolean {
  return shape(v, diff ? ['repo', 'diff'] : ['repo', 'allFiles'], diff ? ['allFiles', 'workspace', 'error', 'noWorktree', 'path', 'branch', 'pushed', 'prNumber', 'prUrl', 'prState', 'prTitle', 'ciStatus'] : ['workspace', 'error', 'noWorktree', 'path']) && (v.repo === 'Task workspace' && v.workspace === true || gitProviderRepository(v.repo)) && (!diff || text(v.diff, WORKTREE_RUNTIME_LIMITS.diffBytes)) && (v.allFiles === undefined || files(v.allFiles)) && ['workspace', 'noWorktree', 'pushed'].every(key => v[key] === undefined || typeof v[key] === 'boolean') && (v.error === undefined || v.error === WORKTREE_RUNTIME_ERROR) && (v.path === undefined || workspaceFileAbsolutePath(v.path)) && (v.branch === undefined || worktreeRuntimeBranch(v.branch)) && (v.prNumber === undefined || count(v.prNumber) && Number(v.prNumber) > 0) && (v.prUrl === undefined || gitProviderAddress(v.prUrl)) && (v.prState === undefined || ['OPEN', 'CLOSED', 'MERGED', 'open', 'closed', 'merged', 'locked'].includes(v.prState as string)) && (v.prTitle === undefined || label(v.prTitle, 4096)) && (v.ciStatus === undefined || ['passing', 'failing', 'pending', 'none'].includes(v.ciStatus as string))
}
const preview = (v: unknown): boolean => v === null || shape(v, ['content', 'size', 'binary', 'truncated']) && text(v.content, WORKTREE_RUNTIME_LIMITS.previewBytes) && count(v.size) && typeof v.binary === 'boolean' && typeof v.truncated === 'boolean' && (!v.binary || v.content === '')
const cleanup = (v: unknown): boolean => shape(v, ['cleaned', 'errors', 'nodeModulesCleaned']) && count(v.cleaned) && count(v.nodeModulesCleaned) && Array.isArray(v.errors) && v.errors.length <= WORKTREE_RUNTIME_LIMITS.errors && v.errors.every(error => error === WORKSPACE_RUNTIME_ERROR || error === 'Cleanup is already in progress')
const keys: Record<WorktreeRuntimeOperation, string[]> = { 'worktree:setup': ['taskId', 'repos', 'org', 'provider'], 'worktree:changes': ['taskId', 'repos'], 'worktree:files': ['taskId', 'repos'], 'worktree:readFile': ['taskId', 'repoFullName', 'filePath'], 'worktree:cleanup': ['taskId', 'repos', 'org', 'removeTaskDir'], 'workspace:runCleanupNow': [] }
function args(op: WorktreeRuntimeOperation, value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  if (op === 'workspace:runCleanupNow') return value.length === 0
  if (!isDatabaseId(value[0])) return false
  if (op === 'worktree:readFile') return value.length === 3 && (value[1] === null || gitProviderRepository(value[1])) && worktreeRuntimeFilePath(value[2])
  if (!repos(value[1], op === 'worktree:setup')) return false
  if (op === 'worktree:changes' || op === 'worktree:files') return value.length === 2
  if (!(value[2] === '' || gitProviderOrganization(value[2]))) return false
  return (value.length === 3 || value.length === 4) && (value[3] === undefined || (op === 'worktree:cleanup' ? typeof value[3] === 'boolean' : ['github', 'gitlab', 'forgejo'].includes(value[3] as string)))
}
function result(op: WorktreeRuntimeOperation, value: unknown): boolean {
  if (op === 'worktree:cleanup') return value === undefined
  if (!isJsonValue(value) || new TextEncoder().encode(JSON.stringify({ defined: true, value })).length >= WORKTREE_RUNTIME_LIMITS.resultBytes) return false
  if (op === 'worktree:setup') return workspaceFileAbsolutePath(value)
  if (op === 'worktree:readFile') return preview(value)
  if (op === 'workspace:runCleanupNow') return cleanup(value)
  return Array.isArray(value) && value.length <= WORKTREE_RUNTIME_LIMITS.repositories + 1 && value.every(v => row(v, op === 'worktree:changes')) && new Set(value.map(v => (v as Record<string, unknown>).repo)).size === value.length
}
function projection(op: WorktreeRuntimeOperation, value: unknown): unknown {
  if (op !== 'worktree:changes' && op !== 'worktree:files') return value
  if (!Array.isArray(value) || value.length > WORKTREE_RUNTIME_LIMITS.repositories + 1) return fail('INVALID_RESULT')
  return value.map(v => {
    if (!isRecord(v)) return fail('INVALID_RESULT')
    const projected = Object.fromEntries(Object.entries(v).filter(([, field]) => field !== undefined))
    if (projected.error !== undefined) projected.error = WORKTREE_RUNTIME_ERROR
    if (projected.prUrl !== undefined) {
      if (typeof projected.prUrl !== 'string') return fail('INVALID_RESULT')
      try { const url = new URL(projected.prUrl); if (!['http:', 'https:'].includes(url.protocol)) return fail('INVALID_RESULT'); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; projected.prUrl = url.href } catch { return fail('INVALID_RESULT') }
    }
    return projected
  })
}
export interface WorktreeRuntimeCodec<K extends WorktreeRuntimeOperation> {
  encodeArguments(value: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(value: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(value: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
function codec<K extends WorktreeRuntimeOperation>(op: K): WorktreeRuntimeCodec<K> {
  const optional = op === 'worktree:setup' ? ['provider'] : op === 'worktree:cleanup' ? ['removeTaskDir'] : []
  return { validateArguments: value => args(op, value), encodeArguments(value) { if (!args(op, value)) return fail('INVALID_ARGUMENTS'); return Object.fromEntries(keys[op].flatMap((key, index) => value[index] === undefined ? [] : [[key, value[index]]])) as JsonValue }, decodeArguments(value) { if (!shape(value, keys[op].filter(key => !optional.includes(key)), optional) || optional.some(key => Object.hasOwn(value, key) && value[key] === undefined)) return fail('INVALID_ARGUMENTS'); const decoded = keys[op].map(key => value[key]); if (!args(op, decoded)) return fail('INVALID_ARGUMENTS'); return decoded as DesktopCommandMap[K]['apiArguments'] }, validateResult: value => result(op, value), encodeResult(value) { const projected = projection(op, value); if (!result(op, projected)) return fail('INVALID_RESULT'); return op === 'worktree:cleanup' ? { defined: false } : { defined: true, value: projected as JsonValue } }, decodeResult(value) { if (!result(op, value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap[K]['result'] }, validateWireResult: value => op === 'worktree:cleanup' ? shape(value, ['defined']) && value.defined === false : shape(value, ['defined', 'value']) && value.defined === true && result(op, value.value) }
}
export const WORKTREE_RUNTIME_CODECS = Object.fromEntries(WORKTREE_RUNTIME_OPERATIONS.map(op => [op, codec(op)])) as { [K in WorktreeRuntimeOperation]: WorktreeRuntimeCodec<K> }
export const WORKTREE_RUNTIME_EVENTS = ['worktree:progress', 'workspace:cleanup-progress', 'workspace:cleanup-complete'] as const
type WorktreeRuntimeEvent = typeof WORKTREE_RUNTIME_EVENTS[number]
const event = (op: WorktreeRuntimeEvent, v: unknown): boolean => op === 'worktree:progress' ? shape(v, ['taskId', 'repo', 'step', 'done'], ['error']) && isDatabaseId(v.taskId) && label(v.repo, 512) && ['cloning', 'fetching', 'creating worktree', 'done', 'error'].includes(v.step as string) && typeof v.done === 'boolean' && (v.error === undefined || v.error === WORKTREE_RUNTIME_ERROR)
  : op === 'workspace:cleanup-complete' ? shape(v, ['cleaned', 'errors']) && count(v.cleaned) && Array.isArray(v.errors) && v.errors.length <= WORKTREE_RUNTIME_LIMITS.errors && v.errors.every(x => x === WORKSPACE_RUNTIME_ERROR)
  : shape(v, ['phase', 'current', 'total'], ['message', 'cleaned', 'nodeModulesCleaned', 'errors']) && ['starting', 'scanning', 'cleaning', 'pruning', 'done'].includes(v.phase as string) && count(v.current) && count(v.total) && (v.message === undefined || label(v.message, 4096)) && ['cleaned', 'nodeModulesCleaned'].every(key => v[key] === undefined || count(v[key])) && (v.errors === undefined || Array.isArray(v.errors) && v.errors.length <= WORKTREE_RUNTIME_LIMITS.errors && v.errors.every(x => x === WORKSPACE_RUNTIME_ERROR))
export const WORKTREE_RUNTIME_EVENT_CODECS = Object.fromEntries(WORKTREE_RUNTIME_EVENTS.map(op => [op, {
  validatePayload: (value: unknown): boolean => event(op, value) && isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).length < WORKTREE_RUNTIME_LIMITS.resultBytes,
  encodePayload(value: DesktopEventMap[typeof op]): JsonValue { if (!isRecord(value)) return fail('INVALID_RESULT'); const projected = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)); if (projected.error !== undefined) projected.error = WORKTREE_RUNTIME_ERROR; if (Array.isArray(projected.errors)) projected.errors = projected.errors.map(() => WORKSPACE_RUNTIME_ERROR); if (!event(op, projected) || !isJsonValue(projected)) return fail('INVALID_RESULT'); return projected },
  decodePayload(value: JsonValue): DesktopEventMap[typeof op] { if (!event(op, value)) return fail('INVALID_RESULT'); return value as unknown as DesktopEventMap[typeof op] }
}])) as { [K in WorktreeRuntimeEvent]: { validatePayload(value: unknown): boolean; encodePayload(value: DesktopEventMap[K]): JsonValue; decodePayload(value: JsonValue): DesktopEventMap[K] } }
