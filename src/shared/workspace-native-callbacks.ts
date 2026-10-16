import { isAbsoluteHostPath } from './host-services'
import { hasExactKeys, isRecord } from './service-protocol'

/** Private captured identities, never renderer-supplied path permission. */
export interface WorkspacePathIdentity {
  path: string
  dev: string
  ino: string
  kind: 'file' | 'directory'
  size: string
  nlink: string
}
export interface WorkspacePathReceipt {
  version: 1
  taskId: string
  workspaceRoot: string
  path: string
  root: WorkspacePathIdentity
  ancestors: WorkspacePathIdentity[]
  target: WorkspacePathIdentity
}
export const WORKSPACE_NATIVE_LIMITS = { pathBytes: 4096, ancestors: 64, receiptBytes: 300_000 } as const
const uint64 = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n
const path = (v: unknown): v is string => isAbsoluteHostPath(v) && new TextEncoder().encode(v).byteLength <= WORKSPACE_NATIVE_LIMITS.pathBytes && !/[\u0000-\u001f\u007f]/.test(v)
function identity(v: unknown): v is WorkspacePathIdentity {
  return isRecord(v) && hasExactKeys(v, ['path', 'dev', 'ino', 'kind', 'size', 'nlink']) && path(v.path) &&
    ['dev', 'ino', 'size', 'nlink'].every(key => uint64(v[key])) && BigInt(v.nlink as string) > 0n && ['file', 'directory'].includes(v.kind as string)
}
/** Shape is checked again in native code against its own descriptor/root FDs. */
export function isWorkspacePathReceipt(v: unknown): v is WorkspacePathReceipt {
  if (!isRecord(v) || !hasExactKeys(v, ['version', 'taskId', 'workspaceRoot', 'path', 'root', 'ancestors', 'target']) || v.version !== 1 ||
    typeof v.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.taskId) || !path(v.workspaceRoot) || !path(v.path) ||
    !identity(v.root) || v.root.kind !== 'directory' || v.root.path !== v.workspaceRoot ||
    !Array.isArray(v.ancestors) || v.ancestors.length > WORKSPACE_NATIVE_LIMITS.ancestors || !v.ancestors.every(row => identity(row) && row.kind === 'directory') ||
    !identity(v.target) || v.target.path !== v.path || v.target.kind === 'file' && v.target.nlink !== '1') return false
  try { return new TextEncoder().encode(JSON.stringify(v)).byteLength <= WORKSPACE_NATIVE_LIMITS.receiptBytes } catch { return false }
}
const payload = (v: unknown): boolean => isRecord(v) && hasExactKeys(v, ['receipt']) && isWorkspacePathReceipt(v.receipt)
const result = (v: unknown): boolean => isRecord(v) && hasExactKeys(v, [])
export const WORKSPACE_NATIVE_CALLBACK_SCHEMAS = {
  'host.workspace.openPath': { validatePayload: payload, validateResult: result },
  'host.workspace.showItemInFolder': { validatePayload: payload, validateResult: result }
} as const

/** Private cleanup observer: task IDs select only descriptor-owned workspaces.
 * No request can supply a path, PID or an idle assertion. */
export type WorkspaceCleanupObservationRequest =
  | { version: 1; action: 'acquire'; taskId: string }
  | { version: 1; action: 'check' | 'release'; taskId: string; leaseId: string }
export type WorkspaceCleanupObservationResult =
  | { status: 'idle'; leaseId?: string }
  | { status: 'busy' | 'unknown' }
  | { released: true }
export type WorkspaceCleanupObserver = (request: WorkspaceCleanupObservationRequest, signal: AbortSignal) => Promise<WorkspaceCleanupObservationResult>
const cleanupLeaseId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)
export function isWorkspaceCleanupObservationRequest(v: unknown): v is WorkspaceCleanupObservationRequest {
  return isRecord(v) && v.version === 1 && typeof v.taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v.taskId) &&
    (v.action === 'acquire' ? hasExactKeys(v, ['version', 'action', 'taskId']) :
      (v.action === 'check' || v.action === 'release') && hasExactKeys(v, ['version', 'action', 'taskId', 'leaseId']) && cleanupLeaseId(v.leaseId))
}
export function isWorkspaceCleanupObservationResult(v: unknown): v is WorkspaceCleanupObservationResult {
  return isRecord(v) && (hasExactKeys(v, ['released']) && v.released === true ||
    hasExactKeys(v, ['status']) && ['idle', 'busy', 'unknown'].includes(v.status as string) ||
    hasExactKeys(v, ['status', 'leaseId']) && v.status === 'idle' && cleanupLeaseId(v.leaseId))
}
export function matchesWorkspaceCleanupObservation(request: WorkspaceCleanupObservationRequest, v: unknown): v is WorkspaceCleanupObservationResult {
  if (!isWorkspaceCleanupObservationResult(v)) return false
  if (request.action === 'release') return 'released' in v
  return 'status' in v && (v.status !== 'idle' || (request.action === 'acquire' ? typeof v.leaseId === 'string' : !Object.hasOwn(v, 'leaseId')))
}
export const WORKSPACE_CLEANUP_CALLBACK_SCHEMA = { validatePayload: isWorkspaceCleanupObservationRequest, validateResult: isWorkspaceCleanupObservationResult } as const
