import { hasExactKeys, isRecord } from './service-protocol'
import { isWorkspacePathReceipt, WORKSPACE_NATIVE_LIMITS, type WorkspacePathIdentity } from './workspace-native-callbacks'
import { taskAttachmentFilename, taskAttachmentId, TASK_ATTACHMENT_LIMITS } from './task-attachment-codecs'
import { isUiLeaseId } from './ui-desktop-codecs'
import { isDatabaseId } from './database-desktop-codecs'

export interface AttachmentPathReceipt {
  version: 1
  taskId: string
  attachmentId: string
  filename: string
  attachmentRoot: string
  path: string
  root: WorkspacePathIdentity
  ancestors: WorkspacePathIdentity[]
  target: WorkspacePathIdentity
}
/** This schema constrains a receipt, never grants a path: native compares its
 * separately captured attachment descriptor root and current document lease. */
export function isAttachmentPathReceipt(value: unknown): value is AttachmentPathReceipt {
  if (!isRecord(value) || !hasExactKeys(value,['version','taskId','attachmentId','filename','attachmentRoot','path','root','ancestors','target']) || value.version!==1 || typeof value.taskId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.taskId) || !taskAttachmentId(value.attachmentId) || !taskAttachmentFilename(value.filename) || typeof value.attachmentRoot!=='string') return false
  const root=value.attachmentRoot, separator=root.startsWith('/') ? '/' : root.includes('\\') ? '\\' : '/'
  const segments=root.split(separator)
  if (segments.some(part=>part==='.' || part==='..') || root!==separator && !/^[A-Za-z]:[\\/]$/.test(root) && root.endsWith(separator)) return false
  if (root.startsWith('/') ? root!=='/' && (root.startsWith('//') || segments.slice(1).some(part=>!part)) : root.includes('/') && root.includes('\\') || segments.slice(root.startsWith('\\\\') ? 2 : 1).some(part=>!part) && !/^[A-Za-z]:[\\/]$/.test(root)) return false
  if (new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(root))!==root) return false
  const base=root.endsWith(separator) ? root : root+separator
  const taskPath=base+value.taskId, path=taskPath+separator+value.attachmentId+'-'+value.filename
  if (value.path!==path || !Array.isArray(value.ancestors) || value.ancestors.length!==1 || !isRecord(value.ancestors[0]) || value.ancestors[0].path!==taskPath || !isRecord(value.target) || value.target.kind!=='file' || value.target.nlink!=='1') return false
  if (!isWorkspacePathReceipt({version:value.version,taskId:value.taskId,workspaceRoot:root,path:value.path,root:value.root,ancestors:value.ancestors,target:value.target})) return false
  if (BigInt(value.target.size as string)>BigInt(TASK_ATTACHMENT_LIMITS.openBytes)) return false
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength<=WORKSPACE_NATIVE_LIMITS.receiptBytes } catch { return false }
}
export const ATTACHMENT_NATIVE_CALLBACK_SCHEMAS = {
  'host.attachment.download': {
    validatePayload(value: unknown): boolean { return isRecord(value) && hasExactKeys(value,['receipt','leaseId','authorizationId']) && isAttachmentPathReceipt(value.receipt) && isUiLeaseId(value.leaseId) && taskAttachmentId(value.authorizationId) },
    validateResult(value: unknown): boolean { return isRecord(value) && hasExactKeys(value,[]) }
  },
  'host.attachment.open': {
    validatePayload(value: unknown): boolean { return isRecord(value) && hasExactKeys(value,['receipt','leaseId']) && isAttachmentPathReceipt(value.receipt) && isUiLeaseId(value.leaseId) },
    validateResult(value: unknown): boolean { return isRecord(value) && hasExactKeys(value,[]) }
  }
} as const
/** Native-stamped private command, distinct from public attachment ID args. */
export function isPrivateAttachmentOpen(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value,['taskId','attachmentId','leaseId']) && isDatabaseId(value.taskId) && taskAttachmentId(value.attachmentId) && isUiLeaseId(value.leaseId)
}

/** Save-dialog command uses the same exact source identity, with no destination. */
export function isPrivateAttachmentDownload(value: unknown): boolean {
  return isPrivateAttachmentOpen(value)
}
export function isPrivateAttachmentDownloadCheck(value: unknown): value is { authorizationId: string } {
  return isRecord(value) && hasExactKeys(value, ['authorizationId']) && taskAttachmentId(value.authorizationId)
}
