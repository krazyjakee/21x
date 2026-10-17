import { hasExactKeys, isRecord } from './service-protocol'
import { isUiLeaseId } from './ui-desktop-codecs'
import { TASK_ATTACHMENT_LIMITS, taskAttachmentFilename, taskAttachmentId } from './task-attachment-codecs'

export interface AttachmentSelection { selectionId: string; path: string; filename: string; size: number }
export interface AttachmentSelectionOffer { leaseId: string; selections: AttachmentSelection[] }
export interface AttachmentSelectionRead { leaseId: string; selectionId: string; offset: number; length: number }
export interface AttachmentSelectionRetire { leaseId: string; selectionId: string }
export interface AttachmentSelectionBridge {
  read(request: AttachmentSelectionRead): Promise<{ data: string }>
  finish(request: AttachmentSelectionRetire): Promise<{ verified: true }>
  retire(request: AttachmentSelectionRetire): Promise<{ retired: true }>
}
export function selectionPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length > 1 && new TextEncoder().encode(value).length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) && value.slice(1).split('/').every(part => !!part && part !== '.' && part !== '..') && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value
}
export function isAttachmentSelection(value: unknown): value is AttachmentSelection {
  return isRecord(value) && hasExactKeys(value, ['selectionId','path','filename','size']) && taskAttachmentId(value.selectionId) && selectionPath(value.path) && taskAttachmentFilename(value.filename) && value.path.endsWith('/' + value.filename) && Number.isSafeInteger(value.size) && Number(value.size) >= 0 && Number(value.size) <= TASK_ATTACHMENT_LIMITS.openBytes
}
export function isSelectionOffer(value: unknown): value is AttachmentSelectionOffer {
  return isRecord(value) && hasExactKeys(value, ['leaseId','selections']) && isUiLeaseId(value.leaseId) && Array.isArray(value.selections) && value.selections.length >= 1 && value.selections.length <= 16 && value.selections.every(isAttachmentSelection) && new Set(value.selections.map(v => v.selectionId)).size === value.selections.length && new Set(value.selections.map(v => v.path)).size === value.selections.length
}
export function isSelectionRetire(value: unknown): value is AttachmentSelectionRetire {
  return isRecord(value) && hasExactKeys(value, ['leaseId','selectionId']) && isUiLeaseId(value.leaseId) && taskAttachmentId(value.selectionId)
}
export function isSelectionRead(value: unknown): value is AttachmentSelectionRead {
  return isRecord(value) && hasExactKeys(value, ['leaseId','selectionId','offset','length']) && isSelectionRetire({ leaseId: value.leaseId, selectionId: value.selectionId }) && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= TASK_ATTACHMENT_LIMITS.openBytes && Number.isSafeInteger(value.length) && Number(value.length) >= 1 && Number(value.length) <= 65536 && Number(value.offset) + Number(value.length) <= TASK_ATTACHMENT_LIMITS.openBytes
}
export const ATTACHMENT_SELECTION_SCHEMAS = {
  'host.attachment.selection.finish': { validatePayload: isSelectionRetire, validateResult: (v: unknown): boolean => isRecord(v) && hasExactKeys(v, ['verified']) && v.verified === true },
  'host.attachment.selection.read': { validatePayload: isSelectionRead, validateResult: (v: unknown): boolean => isRecord(v) && hasExactKeys(v, ['data']) && typeof v.data === 'string' && v.data.length <= 87384 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.data) },
  'host.attachment.selection.retire': { validatePayload: isSelectionRetire, validateResult: (v: unknown): boolean => isRecord(v) && hasExactKeys(v, ['retired']) && v.retired === true }
} as const
