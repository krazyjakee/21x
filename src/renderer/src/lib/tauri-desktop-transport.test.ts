import type { JsonValue } from '@shared/service-protocol'
import { expect, it, vi } from 'vitest'
import { productionBootstrapMessage, getTauriEngineEpoch, getTauriUiDocument, createTauriDesktopTransport, type TauriDesktopApi } from './tauri-desktop-transport'

it('unwraps only the exact three current document notices and revokes old listeners during same-epoch bootstrap', async () => {
  let leaseId = 'document:1'
  const listeners: Array<(event: { payload: unknown }) => void> = []
  const invoke = vi.fn(async () => ({ available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: leaseId }))
  const listen = vi.fn(async (_name: string, receive: (event: { payload: unknown }) => void) => { listeners.push(receive); return () => {} })
  const native = { core: { invoke }, event: { listen } } as unknown as TauriDesktopApi
  await getTauriEngineEpoch(native)
  const transport = createTauriDesktopTransport(native), receive = vi.fn()
  await transport.listen(receive)
  for (const operation of ['agent:incompatible-session', 'task:checkpointAnswered', 'task:source-action-failed']) {
    const frame = { kind: 'event', protocolVersion: 1, engineEpoch: 'engine-1', sequence: 1, operation, payload: {} }
    // Payload validation is DesktopClient's separate responsibility. This
    // boundary grants only the exact captured document, never an event codec.
    listeners[0]({ payload: frame })
    listeners[0]({ payload: { engineEpoch: 'engine-1', leaseId: 'foreign', event: frame } })
    const before = receive.mock.calls.length
    listeners[0]({ payload: { engineEpoch: 'engine-1', leaseId, event: frame } })
    expect(receive).toHaveBeenCalledTimes(before + 1)
    expect(receive).toHaveBeenLastCalledWith(frame)
  }
  const accepted = receive.mock.calls.length
  leaseId = 'document:2'
  const replacement = getTauriEngineEpoch(native)
  const frame = { kind: 'event', protocolVersion: 1, engineEpoch: 'engine-1', sequence: 900, operation: 'task:checkpointAnswered', payload: { taskId: 'task_fixture', approved: false } }
  listeners[0]({ payload: { engineEpoch: 'engine-1', leaseId: 'document:1', event: frame } })
  expect(receive).toHaveBeenCalledTimes(accepted)
  await replacement; await transport.listen(receive)
  listeners[0]({ payload: { engineEpoch: 'engine-1', leaseId, event: frame } })
  listeners[1]({ payload: { engineEpoch: 'engine-1', leaseId: 'document:1', event: frame } })
  expect(receive).toHaveBeenCalledTimes(accepted)
  listeners[1]({ payload: { engineEpoch: 'engine-1', leaseId, event: frame } })
  expect(receive).toHaveBeenCalledTimes(accepted + 1)
  const generic = { ...frame, operation: 'tasks:refresh', payload: {} }
  listeners[1]({ payload: generic })
  expect(receive).toHaveBeenLastCalledWith(generic)
})

it('projects only known startup failures into fixed redacted provisioning guidance', () => {
  const status = (code: string, phase: string) => ({ protocolVersion: 1, production: true, available: false, startupFailure: { code, phase, path: '/private/profile', error: 'private credential detail' } })
  expect(productionBootstrapMessage(status('PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-delegation-missing'))).toBe('Desktop process supervision is unavailable. Provision the native environment and relaunch the app. Changes are paused.')
  expect(productionBootstrapMessage(status('PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-windows-private-fd3-unavailable'))).toContain('Windows yet')
  expect(productionBootstrapMessage(status('INVALID_RESULT', 'production-manifest-digest'))).toContain('resources could not be verified')
  for (const phase of ['production-resources', 'production-manifest-build-digest', 'production-manifest-build-identity']) expect(productionBootstrapMessage(status('INVALID_RESULT', phase))).toContain('resources could not be verified')
  expect(productionBootstrapMessage(status('PROFILE_IN_USE', 'profile-lock'))).toContain('Another desktop service owns this profile')
  expect(productionBootstrapMessage(status('SECRET_STORE_UNAVAILABLE', 'credentials'))).toContain('protected credential store is unavailable')
  for (const [code, phase, text] of [
    ['PROFILE_LOW_DISK', 'resources', 'Free space'], ['PROFILE_DATABASE_LOCKED', 'database-preflight', 'database is busy'],
    ['RESOURCE_UNAVAILABLE', 'resources', 'Repair the preview installation'], ['AGENT_CLI_UNAVAILABLE', 'services', 'configured CLI'],
    ['OWNER_DRAIN_BLOCKED', 'credentials', 'owned work stops'], ['PROFILE_DATABASE_CORRUPT', 'database-preflight', 'opened safely'],
    ['PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-windows-atomic-job-launch', 'Windows process supervision'],
    ['PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-windows-private-pipe-owner', 'Windows process supervision'],
    ['TIMEOUT', 'production-private-bootstrap-write', 'private desktop service channel']
  ]) {
    expect(productionBootstrapMessage(status(code, phase))).toContain(text)
    expect(productionBootstrapMessage(status(code, '/private/canary'))).toBeNull()
  }
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
    await transport.invoke('artifacts:copyFile', { taskId: 'task_1', relativePath: 'report.md' }, { engineEpoch: 'engine-1', signal: new AbortController().signal })
    expect(invoke).toHaveBeenLastCalledWith('desktop_invoke', { operation: 'artifacts:copyFile', payload: { taskId: 'task_1', relativePath: 'report.md' }, engineEpoch: 'engine-1', uiLease: 'document:1' })
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

it('retires an accepted artifact copy result during replacement bootstrap without replay', async () => {
  let finishCopy!: (value: unknown) => void
  const raw = new Promise(resolve => { finishCopy = resolve })
  const invoke = vi.fn().mockResolvedValueOnce({ available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document:1' }).mockReturnValueOnce(raw)
    .mockResolvedValue({ available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document:2' })
  const native = { core: { invoke }, event: { listen: vi.fn() } } as unknown as TauriDesktopApi
  await getTauriEngineEpoch(native)
  const old = createTauriDesktopTransport(native).invoke('artifacts:copyFile', { taskId: 'task_1', relativePath: 'report.md' }, { engineEpoch: 'engine-1', signal: new AbortController().signal })
  const failure = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  await getTauriEngineEpoch(native)
  finishCopy({ engineEpoch: 'engine-1', result: { defined: true, value: { mode: 'file' } } }); await failure
  expect(invoke.mock.calls.filter(([command]) => command === 'desktop_invoke')).toHaveLength(1)
})

it('stamps notification document authority and rejects an old show acknowledgement after reload without replay', async () => {
  let finishShow!: (value: unknown) => void
  const raw = new Promise(resolve => { finishShow = resolve })
  const invoke = vi.fn().mockResolvedValueOnce({ available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document:1' }).mockReturnValueOnce(raw)
    .mockResolvedValue({ available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document:2' })
  const native = { core: { invoke }, event: { listen: vi.fn() } } as unknown as TauriDesktopApi; await getTauriEngineEpoch(native)
  const pending = createTauriDesktopTransport(native).invoke('notifications:show', { title: 'Review', body: '' }, { engineEpoch: 'engine-1', signal: new AbortController().signal })
  const refused = expect(pending).rejects.toMatchObject({ code: 'STALE_EPOCH' }); await getTauriEngineEpoch(native)
  finishShow({ engineEpoch: 'engine-1', result: { defined: false } }); await refused
  expect(invoke.mock.calls.filter(([command]) => command === 'desktop_invoke')).toEqual([['desktop_invoke', { operation: 'notifications:show', payload: { title: 'Review', body: '' }, engineEpoch: 'engine-1', uiLease: 'document:1' }]])
})


it.each(['attachments:pick','attachments:save','attachments:readImage','app:setTitleBarOverlay'] as const)('requires the exact physical document for %s and rejects late results during replacement bootstrap',async operation=>{
 let finish!: (value:unknown)=>void, bootstrap!: (value:unknown)=>void
 const raw=new Promise(resolve=>{finish=resolve}), replacement=new Promise(resolve=>{bootstrap=resolve})
 const invoke=vi.fn().mockResolvedValueOnce({available:true,protocolVersion:1,engineEpoch:'engine-1',uiLeaseId:'document:1'}).mockImplementation((command:string)=>command==='engine_status'?replacement:raw)
 const native={core:{invoke},event:{listen:vi.fn()}} as unknown as TauriDesktopApi;await getTauriEngineEpoch(native)
 const transport=createTauriDesktopTransport(native);const payload:JsonValue=operation==='attachments:pick'?{}:operation==='attachments:readImage'?{taskId:'task_fixture',attachmentId:'00000000-0000-4000-8000-000000000001'}:operation==='attachments:save'?{taskId:'task_fixture',filePath:'/tmp/selected.txt'}:{colors:{color:'#141414',symbolColor:'#8e8d91'}}
 const pending=transport.invoke(operation,payload,{engineEpoch:'engine-1',signal:new AbortController().signal}),failure=expect(pending).rejects.toMatchObject({code:'STALE_EPOCH'})
 expect(invoke).toHaveBeenLastCalledWith('desktop_invoke',{operation,payload,engineEpoch:'engine-1',uiLease:'document:1'})
 const refreshed=getTauriEngineEpoch(native);finish({engineEpoch:'engine-1',result:{defined:true,value:[]}});await failure
 bootstrap({available:true,protocolVersion:1,engineEpoch:'engine-1'});await refreshed
 const before=invoke.mock.calls.length;await expect(transport.invoke(operation,payload,{engineEpoch:'engine-1',signal:new AbortController().signal})).rejects.toMatchObject({code:'DISCONNECTED'});expect(invoke.mock.calls.length).toBe(before)
 expect(invoke.mock.calls.filter(([command])=>command==='desktop_invoke')).toHaveLength(1)
})
