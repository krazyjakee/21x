import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_OPERATION_MANIFEST } from './desktop-operations'
import { DesktopOperationRegistry, type DesktopCallerContext } from '../service/transport/desktop-registry'
import { HOST_OPERATION_SCHEMAS, isAbsoluteHostPath, isEncodedByteChunk, isHostPaths, isOptionalResult, optionalResult } from './host-services'
import { isRecord, hasExactKeys } from './service-protocol'

const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'epoch-1', webviewId: 'main', origin: 'tauri://localhost' }
const signal = (): AbortSignal => new AbortController().signal
const registry = (): DesktopOperationRegistry => new DesktopOperationRegistry({ owner: 'service', engineEpoch: 'epoch-1',
  isTrustedDesktop: value => value.webviewId === 'main' && value.origin === 'tauri://localhost' })

function binding(overrides: Record<string, unknown> = {}) {
  return {
    decodeRequest: (payload: unknown) => isRecord(payload) ? payload.args : undefined,
    validateArguments: (args: unknown) => Array.isArray(args) && args.length === 1 && typeof args[0] === 'string',
    authorize: (args: [id: string]) => args[0] === 'allowed-task',
    invoke: vi.fn(() => true),
    validateResult: (value: unknown) => typeof value === 'boolean',
    encodeResult: (value: boolean) => optionalResult(value),
    ...overrides
  }
}

describe('exact desktop contract registry', () => {
  it('maps retained commands and events independently and never retains browser operations', () => {
    expect(DESKTOP_OPERATION_MANIFEST['command/db:getTasks']).toMatchObject({ owner: 'service', caller: 'trusted-desktop-main' })
    expect(DESKTOP_OPERATION_MANIFEST['event/voice:speech:chunk']).toMatchObject({ destination: 'trusted-desktop-main' })
    for (const [key, descriptor] of Object.entries(DESKTOP_OPERATION_MANIFEST)) {
      expect(key).not.toContain('*')
      if (descriptor.name.startsWith('browser:')) expect(descriptor).toMatchObject({ disposition: 'removed-browser', caller: 'none', destination: 'none' })
    }
  })

  it('requires complete binding functions, exact owner, exact name and a retained contract', async () => {
    const service = registry()
    // Deliberate runtime-invalid bindings model an unaudited plugin/adapter.
    expect(() => service.bindCommand('db:deleteTask', {} as never)).toThrow('Invalid operation arguments.')
    expect(() => service.bindCommand('browser:startRecording' as never, binding() as never)).toThrow('Unknown operation.')
    expect(() => service.bindCommand('shell:openExternal', binding() as never)).toThrow('Unknown operation.')
    expect(() => service.bindCommand('db:*' as never, binding() as never)).toThrow('Unknown operation.')
    await expect(service.invoke('db:deleteTask', { args: ['allowed-task'] }, caller, signal())).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(service.missingBindings()).toContain('command/db:deleteTask')
  })

  it('rejects forged native identity, stale epoch and denied task scope before effects', async () => {
    const service = registry()
    const operation = binding()
    service.bindCommand('db:deleteTask', operation)
    for (const identity of [{ ...caller, principal: 'service' as const }, { ...caller, webviewId: 'artifact' },
      { ...caller, origin: 'https://example.com' }]) {
      await expect(service.invoke('db:deleteTask', { args: ['allowed-task'] }, identity, signal())).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    await expect(service.invoke('db:deleteTask', { args: ['allowed-task'] }, { ...caller, engineEpoch: 'old' }, signal())).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(service.invoke('db:deleteTask', { args: ['other-task'] }, caller, signal())).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(operation.invoke).not.toHaveBeenCalled()
    await expect(service.invoke('db:deleteTask', { args: ['allowed-task'] }, caller, signal())).resolves.toEqual({ defined: true, value: true })
    expect(operation.invoke).toHaveBeenCalledTimes(1)
  })

  it('validates codecs/results, suppresses cancelled results and redacts adapter errors', async () => {
    const service = registry()
    service.bindCommand('db:deleteTask', binding({ invoke: () => { throw new Error('secret-token') } }))
    await expect(service.invoke('db:deleteTask', { args: ['allowed-task'] }, caller, signal()))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: 'The operation failed.' })
    await expect(service.invoke('db:deleteTask', { args: [1] }, caller, signal())).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    const malformed = registry()
    malformed.bindCommand('db:deleteTask', binding({ encodeResult: () => undefined }) as never)
    await expect(malformed.invoke('db:deleteTask', { args: ['allowed-task'] }, caller, signal())).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    const cancelled = registry()
    const controller = new AbortController()
    cancelled.bindCommand('db:deleteTask', binding({ invoke: () => { controller.abort(); return true } }))
    await expect(cancelled.invoke('db:deleteTask', { args: ['allowed-task'] }, caller, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('accepts validated events only from their owning epoch and emits no global destination', () => {
    const service = registry()
    service.bindEvent('workspace:cleanup-complete', {
      validatePayload: value => isRecord(value) && hasExactKeys(value, ['cleaned', 'errors']) && Number.isSafeInteger(value.cleaned) &&
        Array.isArray(value.errors) && value.errors.every(error => typeof error === 'string'),
      encodePayload: value => ({ cleaned: value.cleaned, errors: value.errors })
    })
    const producer = { ...caller, principal: 'service' as const }
    expect(service.encodeEvent('workspace:cleanup-complete', { cleaned: 2, errors: [] }, producer)).toEqual({ cleaned: 2, errors: [] })
    expect(() => service.encodeEvent('workspace:cleanup-complete', { cleaned: 'secret', errors: [] }, producer)).toThrow('Invalid operation arguments.')
    expect(() => service.encodeEvent('workspace:cleanup-complete', { cleaned: 2, errors: [] }, caller)).toThrow('Invalid request.')
    expect(() => service.encodeEvent('workspace:cleanup-complete', { cleaned: 2, errors: [] }, { ...producer, engineEpoch: 'old' })).toThrow('The service instance has changed.')
  })
})

describe('validated native callback shapes', () => {
  it('preserves missing/null values and validates canonical bounded byte chunks', () => {
    expect(optionalResult(undefined)).toEqual({ defined: false })
    expect(optionalResult(null)).toEqual({ defined: true, value: null })
    expect(isOptionalResult({ defined: false, value: null })).toBe(false)
    expect(isOptionalResult({ defined: true, value: undefined })).toBe(false)
    expect(isEncodedByteChunk({ encoding: 'base64', data: 'AA==' })).toBe(true)
    expect(isEncodedByteChunk({ encoding: 'base64', data: 'AB==' })).toBe(false)
    expect(isEncodedByteChunk({ encoding: 'base64', data: 'AAA=' })).toBe(true)
    expect(isEncodedByteChunk({ encoding: 'base64', data: 'AAB=' })).toBe(false)
    expect(isEncodedByteChunk({ encoding: 'base64', data: 'AAAA'.repeat(22000) })).toBe(false)
  })

  it('requires absolute injected paths, strict dialog results and retained external URL schemes', () => {
    const paths = { profileRoot: '/fixture/profile', resourceRoot: '/bundle', runtimeExecutable: '/bundle/node', tempRoot: '/tmp', isPackaged: true, buildIdentity: 'build-test' }
    expect(isHostPaths(paths)).toBe(true)
    expect(isHostPaths({ ...paths, extra: 'secret' })).toBe(false)
    expect(isHostPaths({ ...paths, profileRoot: '../live-profile' })).toBe(false)
    expect(isAbsoluteHostPath('C:\\Users\\User\\AppData')).toBe(true)
    expect(isAbsoluteHostPath('\\\\server\\share\\profile')).toBe(true)
    expect(isAbsoluteHostPath('\\\\.\\pipe\\secret')).toBe(false)
    expect(HOST_OPERATION_SCHEMAS['host.dialog.saveFile'].validateResult({ cancelled: true, path: '/secret' })).toBe(false)
    expect(HOST_OPERATION_SCHEMAS['host.dialog.openFiles'].validateRequest({ multiple: true, extensions: ['png', '../exe'] })).toBe(false)
    for (const url of ['https://auth.example.test/login', 'http://localhost:3000/', 'mailto:user@example.test']) {
      expect(HOST_OPERATION_SCHEMAS['host.shell.openExternal'].validateRequest({ url })).toBe(true)
    }
    for (const url of ['file:///secret', 'javascript:alert(1)', 'twentyonex://oauth', 'https://@example.test/', 'https:////example.test/']) {
      expect(HOST_OPERATION_SCHEMAS['host.shell.openExternal'].validateRequest({ url })).toBe(false)
    }
  })
})

it('keeps native-only image admission outside the public Source registry',async()=>{
 const service=registry()
 expect(DESKTOP_OPERATION_MANIFEST['command/attachments:readImage']).toMatchObject({owner:'native-host',caller:'trusted-desktop-main'})
 expect(()=>service.bindCommand('attachments:readImage',binding() as never)).toThrow('Unknown operation.')
 await expect(service.invoke('attachments:readImage',{taskId:'task_fixture',attachmentId:'00000000-0000-4000-8000-000000000001'},caller,signal())).rejects.toMatchObject({code:'UNKNOWN_OPERATION'})
})
