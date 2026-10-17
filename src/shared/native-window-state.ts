import { hasExactKeys, isRecord } from './service-protocol'

/** Private native observation. Coordinates and sizes are physical pixels;
 * scale preserves logical size when restoring onto a different DPI monitor. */
export interface NativeWindowState {
  version: 1
  x: number
  y: number
  width: number
  height: number
  scale: number
  maximized: boolean
  fullscreen: boolean
}
const integer = (value: unknown, min: number, max: number): boolean => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
export function isNativeWindowState(value: unknown): value is NativeWindowState {
  return isRecord(value) && hasExactKeys(value, ['version', 'x', 'y', 'width', 'height', 'scale', 'maximized', 'fullscreen']) &&
    value.version === 1 && integer(value.x, -1_000_000, 1_000_000) && integer(value.y, -1_000_000, 1_000_000) &&
    integer(value.width, 64, 32768) && integer(value.height, 64, 32768) && typeof value.scale === 'number' &&
    Number.isFinite(value.scale) && value.scale >= 0.5 && value.scale <= 8 && typeof value.maximized === 'boolean' && typeof value.fullscreen === 'boolean'
}
export const NATIVE_WINDOW_STATE_SCHEMAS = {
  'engine.windowState.load': {
    validatePayload: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, []),
    validateResult: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['state']) && (value.state === null || isNativeWindowState(value.state))
  },
  'engine.windowState.save': {
    validatePayload: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['state']) && isNativeWindowState(value.state),
    validateResult: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['saved']) && value.saved === true
  }
} as const
