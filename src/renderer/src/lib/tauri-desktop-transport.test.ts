import { expect, it, vi } from 'vitest'
import { productionBootstrapMessage, getTauriEngineEpoch, getTauriUiDocument, createTauriDesktopTransport, type TauriDesktopApi } from './tauri-desktop-transport'

it('projects only known startup failures into fixed redacted provisioning guidance', () => {
  const status = (code: string, phase: string) => ({ protocolVersion: 1, production: true, available: false, startupFailure: { code, phase, path: '/private/profile', error: 'private credential detail' } })
  expect(productionBootstrapMessage(status('PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-delegation-missing'))).toBe('Desktop process supervision is unavailable. Provision the native environment and relaunch the app. Changes are paused.')
  expect(productionBootstrapMessage(status('PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-windows-private-fd3-unavailable'))).toContain('Windows yet')
  expect(productionBootstrapMessage(status('INVALID_RESULT', 'production-manifest-digest'))).toContain('resources could not be verified')
  for (const phase of ['production-resources', 'production-manifest-build-digest', 'production-manifest-build-identity']) expect(productionBootstrapMessage(status('INVALID_RESULT', phase))).toContain('resources could not be verified')
  expect(productionBootstrapMessage(status('PROFILE_IN_USE', 'profile-lock'))).toContain('Another desktop service owns this profile')
  expect(productionBootstrapMessage(status('SECRET_STORE_UNAVAILABLE', 'credentials'))).toContain('protected credential store is unavailable')
  expect(productionBootstrapMessage(status('PRIVATE:/path', 'private credential detail'))).toBeNull()
  expect(productionBootstrapMessage(status('PRODUCTION_CONTAINMENT_UNAVAILABLE', '/private/profile'))).toBeNull()
  expect(productionBootstrapMessage({ ...status('PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-delegation-missing'), production: false })).toBeNull()
  expect(JSON.stringify(productionBootstrapMessage(status('PROFILE_IN_USE', 'profile-lock')))).not.toContain('private')
})

it('waits for native page completion before capturing a private publication receipt', async () => {
  vi.useFakeTimers()
  try {
    const invoke = vi.fn().mockResolvedValueOnce({ available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiSupported: true })
      .mockResolvedValueOnce({ available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiSupported: true, uiLeaseId: 'document:1' })
      .mockResolvedValue({ engineEpoch: 'engine-1', result: { defined: false } })
    const native = { core: { invoke }, event: { listen: vi.fn() } } as unknown as TauriDesktopApi
    const status = getTauriEngineEpoch(native)
    await vi.advanceTimersByTimeAsync(25)
    expect(await status).toBe('engine-1'); expect(getTauriUiDocument(native)).toEqual({ engineEpoch: 'engine-1', leaseId: 'document:1' })
    const transport = createTauriDesktopTransport(native)
    await transport.invoke('ui:publishState', { state: {} }, { engineEpoch: 'engine-1', signal: new AbortController().signal })
    expect(invoke).toHaveBeenLastCalledWith('desktop_invoke', { operation: 'ui:publishState', payload: { state: {} }, engineEpoch: 'engine-1', uiLease: 'document:1' })
    await transport.invoke('project:getAll', {}, { engineEpoch: 'engine-1', signal: new AbortController().signal })
    expect(invoke).toHaveBeenLastCalledWith('desktop_invoke', { operation: 'project:getAll', payload: {}, engineEpoch: 'engine-1' })
    await transport.invoke('chatImages:readClipboard', {}, { engineEpoch: 'engine-1', signal: new AbortController().signal })
    expect(invoke).toHaveBeenLastCalledWith('desktop_invoke', { operation: 'chatImages:readClipboard', payload: {}, engineEpoch: 'engine-1', uiLease: 'document:1' })
    await transport.invoke('attachments:download', { taskId: 'task_1', attachmentId: '00000000-0000-4000-8000-000000000001' }, { engineEpoch: 'engine-1', signal: new AbortController().signal })
    expect(invoke).toHaveBeenLastCalledWith('desktop_invoke', { operation: 'attachments:download', payload: { taskId: 'task_1', attachmentId: '00000000-0000-4000-8000-000000000001' }, engineEpoch: 'engine-1', uiLease: 'document:1' })
    invoke.mockResolvedValue({ available: true, protocolVersion: 1, engineEpoch: 'engine-2' })
    expect(await getTauriEngineEpoch(native)).toBe('engine-2'); expect(getTauriUiDocument(native)).toBeUndefined()
    await expect(transport.invoke('ui:publishState', { state: {} }, { engineEpoch: 'engine-2', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(transport.invoke('chatImages:readClipboard', {}, { engineEpoch: 'engine-2', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(transport.invoke('attachments:download', { taskId: 'task_1', attachmentId: '00000000-0000-4000-8000-000000000001' }, { engineEpoch: 'engine-2', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  } finally { vi.useRealTimers() }
})

it('revokes clipboard delivery as soon as replacement bootstrap starts, before its response arrives', async () => {
  let finishRead!: (value: unknown) => void, finishBootstrap!: (value: unknown) => void
  const read = new Promise(resolve => { finishRead = resolve }), bootstrap = new Promise(resolve => { finishBootstrap = resolve })
  const invoke = vi.fn().mockResolvedValueOnce({ available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document:1' })
    .mockImplementation((command: string) => command === 'engine_status' ? bootstrap : read)
  const native = { core: { invoke }, event: { listen: vi.fn() } } as unknown as TauriDesktopApi
  await getTauriEngineEpoch(native)
  const old = createTauriDesktopTransport(native).invoke('chatImages:readClipboard', {}, { engineEpoch: 'engine-1', signal: new AbortController().signal })
  const failure = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  const replacement = getTauriEngineEpoch(native)
  finishRead({ engineEpoch: 'engine-1', result: { defined: true, value: { images: [], errors: [] } } })
  await failure
  finishBootstrap({ available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document:2' })
  await replacement
  expect(invoke.mock.calls.filter(([command]) => command === 'desktop_invoke')).toHaveLength(1)
})
