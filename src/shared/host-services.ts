import { hasExactKeys, isRecord, isJsonValue, type JsonValue } from './service-protocol'
import type { DesktopEventMap } from './desktop-operations'

export const HOST_CALLBACK_VERSION = 1 as const
export const HOST_BYTE_CHUNK_LIMIT = 64 * 1024
export interface HostPaths {
  profileRoot: string
  resourceRoot: string
  runtimeExecutable: string
  tempRoot: string
  isPackaged: boolean
  buildIdentity: string
}
export type MicrophonePermission = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unsupported'
export interface EncodedByteChunk { encoding: 'base64'; data: string }
export type OptionalResult<T> = { defined: false } | { defined: true; value: T }

/** Explicit retained native callbacks. No generic shell, file-read, eval or credential dispatcher. */
export interface HostCommandMap {
  'host.paths.get': { request: null; result: HostPaths }
  'host.dialog.openFiles': { request: { multiple: boolean; extensions: string[] }; result: { cancelled: boolean; paths: string[] } }
  'host.dialog.saveFile': { request: { suggestedName: string; extension: string }; result: { cancelled: boolean; path: string | null } }
  'host.shell.openExternal': { request: { url: string }; result: { opened: true } }
  'host.shell.revealFile': { request: { path: string }; result: { revealed: true } }
  'host.notification.show': { request: { title: string; body: string }; result: { shown: boolean } }
  'host.voice.permission.get': { request: null; result: { status: MicrophonePermission } }
  'host.voice.permission.request': { request: null; result: { status: MicrophonePermission } }
  'host.shortcut.set': { request: { accelerator: string | null }; result: { registered: boolean } }
  'host.sleep.set': { request: { enabled: boolean }; result: { enabled: boolean } }
}
export interface HostServices {
  /** Injected/canonicalized during trusted bootstrap, before opening SQLite. */
  readonly paths: Readonly<HostPaths>
  invoke<K extends keyof HostCommandMap>(operation: K, request: HostCommandMap[K]['request'], signal: AbortSignal): Promise<HostCommandMap[K]['result']>
}
export interface DesktopEventSink {
  /** Target the trusted main WebView; mobile remains a separate authenticated sink. */
  publish<K extends keyof DesktopEventMap>(operation: K, payload: DesktopEventMap[K], sequence?: number): Promise<void>
}

const bounded = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !value.includes('\0')
const extension = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9]{1,16}$/.test(value)
const booleanResult = (key: string) => (value: unknown): boolean => isRecord(value) && hasExactKeys(value, [key]) && typeof value[key] === 'boolean'
const trueResult = (key: string) => (value: unknown): boolean => isRecord(value) && hasExactKeys(value, [key]) && value[key] === true

/** Shape validation only; native owners must canonicalize, contain and authorize actual paths. */
export function isAbsoluteHostPath(value: unknown): value is string {
  if (!bounded(value, 4096) || value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) return false
  const absolute = value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+\\[^\\/]+/.test(value)
  return absolute && !value.split(/[\\/]/).some(segment => segment === '.' || segment === '..')
}
export function isHostPaths(value: unknown): value is HostPaths {
  return isRecord(value) && hasExactKeys(value, ['profileRoot', 'resourceRoot', 'runtimeExecutable', 'tempRoot', 'isPackaged', 'buildIdentity']) &&
    ['profileRoot', 'resourceRoot', 'runtimeExecutable', 'tempRoot'].every(key => isAbsoluteHostPath(value[key])) &&
    typeof value.isPackaged === 'boolean' && bounded(value.buildIdentity, 128)
}
export function isExternalHostUrl(value: unknown): value is string {
  if (!bounded(value, 8192) || /[\u0000-\u0020\u007f\\]/.test(value) ||
    /^https?:/i.test(value) && !/^https?:\/\/[^/]/i.test(value)) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password &&
      !/^https?:\/\/[^/?#]*@/i.test(value) && (url.protocol === 'mailto:' ? !!url.pathname : !!url.hostname)
  } catch { return false }
}
export function isEncodedByteChunk(value: unknown): value is EncodedByteChunk {
  if (!isRecord(value) || !hasExactKeys(value, ['encoding', 'data']) || value.encoding !== 'base64' || typeof value.data !== 'string') return false
  const encoded = value.data
  if (encoded.length > Math.ceil(HOST_BYTE_CHUNK_LIMIT / 3) * 4) return false
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (padding && alphabet.indexOf(encoded[encoded.length - padding - 1]) % (padding === 2 ? 16 : 4) !== 0) return false
  return encoded.length / 4 * 3 - padding <= HOST_BYTE_CHUNK_LIMIT
}
export function optionalResult(value: JsonValue | undefined): OptionalResult<JsonValue> {
  return value === undefined ? { defined: false } : { defined: true, value }
}
export function isOptionalResult(value: unknown): value is OptionalResult<JsonValue> {
  return isRecord(value) && (value.defined === false && hasExactKeys(value, ['defined']) ||
    value.defined === true && hasExactKeys(value, ['defined', 'value']) && isJsonValue(value.value))
}

const permissionResult = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['status']) &&
  ['granted', 'denied', 'not-determined', 'restricted', 'unsupported'].includes(value.status as string)

/** Mandatory shape validators; task/path/approval authority is additional, never inferred here. */
export const HOST_OPERATION_SCHEMAS: { [K in keyof HostCommandMap]: { validateRequest: (value: unknown) => boolean; validateResult: (value: unknown) => boolean } } = {
  'host.paths.get': { validateRequest: value => value === null, validateResult: isHostPaths },
  'host.dialog.openFiles': {
    validateRequest: value => isRecord(value) && hasExactKeys(value, ['multiple', 'extensions']) && typeof value.multiple === 'boolean' &&
      Array.isArray(value.extensions) && value.extensions.length <= 32 && value.extensions.every(extension),
    validateResult: value => isRecord(value) && hasExactKeys(value, ['cancelled', 'paths']) && typeof value.cancelled === 'boolean' &&
      Array.isArray(value.paths) && value.paths.length <= 128 && value.paths.every(isAbsoluteHostPath) && (!value.cancelled || value.paths.length === 0)
  },
  'host.dialog.saveFile': {
    validateRequest: value => isRecord(value) && hasExactKeys(value, ['suggestedName', 'extension']) && bounded(value.suggestedName, 255) &&
      !/[\\/]/.test(value.suggestedName) && !['.', '..'].includes(value.suggestedName) && extension(value.extension),
    validateResult: value => isRecord(value) && hasExactKeys(value, ['cancelled', 'path']) && typeof value.cancelled === 'boolean' &&
      (value.cancelled ? value.path === null : isAbsoluteHostPath(value.path))
  },
  'host.shell.openExternal': { validateRequest: value => isRecord(value) && hasExactKeys(value, ['url']) && isExternalHostUrl(value.url), validateResult: trueResult('opened') },
  'host.shell.revealFile': { validateRequest: value => isRecord(value) && hasExactKeys(value, ['path']) && isAbsoluteHostPath(value.path), validateResult: trueResult('revealed') },
  'host.notification.show': { validateRequest: value => isRecord(value) && hasExactKeys(value, ['title', 'body']) && bounded(value.title, 160) && bounded(value.body, 2048, true), validateResult: booleanResult('shown') },
  'host.voice.permission.get': { validateRequest: value => value === null, validateResult: permissionResult },
  'host.voice.permission.request': { validateRequest: value => value === null, validateResult: permissionResult },
  'host.shortcut.set': { validateRequest: value => isRecord(value) && hasExactKeys(value, ['accelerator']) && (value.accelerator === null || bounded(value.accelerator, 128)), validateResult: booleanResult('registered') },
  'host.sleep.set': { validateRequest: booleanResult('enabled'), validateResult: booleanResult('enabled') }
}
