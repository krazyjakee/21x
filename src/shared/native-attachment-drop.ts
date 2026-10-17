import { hasExactKeys, isRecord, ServiceProtocolError } from './service-protocol'
import { selectionPath } from './attachment-selection-callbacks'
import { isUiLeaseId } from './ui-desktop-codecs'

export const NATIVE_ATTACHMENT_DROP = Object.freeze({
  context: 'attachments:setNativeDropContext', accept: 'native.attachment.drop.accept',
  close: 'native.attachment.drop.close', event: 'desktop:attachment-drop'
} as const)
/** Paths are display names referring to private one-shot native selections. */
export interface NativeAttachmentDrop { dropId: string; contextId: string; paths: string[] }
export interface NativeAttachmentDropReceipt extends NativeAttachmentDrop {
  accept(): Promise<void>
  close(): Promise<void>
}
export interface NativeAttachmentDropEvent {
  engineEpoch: string
  leaseId: string
  drop: NativeAttachmentDrop
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
export function isNativeDropContext(value: unknown): value is string | null {
  return value === null || uuid(value)
}
export function isNativeAttachmentDrop(value: unknown): value is NativeAttachmentDrop {
  return isRecord(value) && hasExactKeys(value, ['dropId', 'contextId', 'paths']) && uuid(value.dropId) && uuid(value.contextId)
    && Array.isArray(value.paths) && value.paths.length >= 1 && value.paths.length <= 16 && value.paths.every(selectionPath)
    && new Set(value.paths).size === value.paths.length
}
export function isNativeAttachmentDropEvent(value: unknown): value is NativeAttachmentDropEvent {
  return isRecord(value) && hasExactKeys(value, ['engineEpoch', 'leaseId', 'drop'])
    && typeof value.engineEpoch === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.engineEpoch)
    && isUiLeaseId(value.leaseId) && isNativeAttachmentDrop(value.drop)
}
export function validateNativeDropContext(value: unknown): asserts value is string | null {
  if (!isNativeDropContext(value)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
}
