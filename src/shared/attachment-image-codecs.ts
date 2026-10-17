import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { isDatabaseId } from './database-desktop-codecs'
import { taskAttachmentId } from './task-attachment-codecs'
import { isAttachmentImage, type AttachmentImage } from './attachment-image'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

type Arguments = DesktopCommandMap['attachments:readImage']['apiArguments']
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const valid = (value: unknown): value is Arguments => Array.isArray(value) && value.length === 2 && isDatabaseId(value[0]) && taskAttachmentId(value[1])
export const NATIVE_ATTACHMENT_IMAGE_CODECS = { 'attachments:readImage': {
  validateArguments: valid,
  encodeArguments(value: Arguments): JsonValue { if (!valid(value)) return fail('INVALID_ARGUMENTS'); return { taskId: value[0], attachmentId: value[1] } },
  decodeArguments(value: JsonValue): Arguments { if (!isRecord(value) || !hasExactKeys(value, ['taskId', 'attachmentId']) || !valid([value.taskId, value.attachmentId])) return fail('INVALID_ARGUMENTS'); return [value.taskId as string, value.attachmentId as string] },
  validateResult: isAttachmentImage,
  encodeResult(value: unknown): OptionalResult<JsonValue> { if (!isAttachmentImage(value)) return fail('INVALID_RESULT'); return { defined: true, value: { mimeType: value.mimeType, data: value.data } } },
  decodeResult(value: JsonValue | undefined): AttachmentImage { if (!isAttachmentImage(value)) return fail('INVALID_RESULT'); return Object.freeze({ mimeType: value.mimeType, data: value.data }) },
  validateWireResult(value: unknown): boolean { return isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && isAttachmentImage(value.value) }
} }
