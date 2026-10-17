import type { DesktopCommandMap } from './desktop-operations'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

const color = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
const colors = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['color', 'symbolColor']) && color(value.color) && color(value.symbolColor)
const args = (value: unknown): boolean => Array.isArray(value) && value.length === 1 && colors(value[0])
function fail(code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never { throw new ServiceProtocolError(code) }
export const NATIVE_WINDOW_CODECS = { 'app:setTitleBarOverlay': {
  validateArguments: args,
  encodeArguments(value: DesktopCommandMap['app:setTitleBarOverlay']['apiArguments']): JsonValue { if (!args(value)) fail('INVALID_ARGUMENTS'); return { colors: { ...value[0] } } },
  decodeArguments(value: JsonValue): DesktopCommandMap['app:setTitleBarOverlay']['apiArguments'] { if (!isRecord(value) || !hasExactKeys(value, ['colors']) || !colors(value.colors)) fail('INVALID_ARGUMENTS'); return [value.colors as { color: string; symbolColor: string }] },
  validateResult: (value: unknown): boolean => value === undefined,
  encodeResult(value: unknown): { defined: false } { if (value !== undefined) fail('INVALID_RESULT'); return { defined: false } },
  decodeResult(value: JsonValue | undefined): undefined { if (value !== undefined) fail('INVALID_RESULT'); return undefined },
  validateWireResult: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['defined']) && value.defined === false
} } as const
