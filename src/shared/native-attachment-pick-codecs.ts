import type { DesktopCommandMap } from './desktop-operations'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import { selectionPath } from './attachment-selection-callbacks'
import type { OptionalResult } from './host-services'
type Args = DesktopCommandMap['attachments:pick']['apiArguments']
function result(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 16 && value.every(selectionPath) && new Set(value).size === value.length }
function fail(code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never { throw new ServiceProtocolError(code) }
export const NATIVE_ATTACHMENT_PICK_CODECS = { 'attachments:pick': {
  validateArguments: (value: unknown): boolean => Array.isArray(value) && value.length === 0,
  encodeArguments(value: Args): JsonValue { if (!Array.isArray(value) || value.length) fail('INVALID_ARGUMENTS'); return {} },
  decodeArguments(value: JsonValue): Args { if (!isRecord(value) || !hasExactKeys(value, [])) fail('INVALID_ARGUMENTS'); return [] },
  validateResult: result,
  encodeResult(value: unknown): OptionalResult<JsonValue> { if (!result(value)) fail('INVALID_RESULT'); return { defined: true, value } },
  decodeResult(value: JsonValue | undefined): string[] { if (!result(value)) fail('INVALID_RESULT'); return value },
  validateWireResult: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['defined','value']) && value.defined === true && result(value.value)
} }
