import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireProfileLock, type ProfileLock } from './platform/profile-lock'
import { DatabaseBackend } from '../service/database-backend'
import type { DesktopCallerContext } from '../service/transport/desktop-registry'
import { ServiceProtocolError } from '../shared/service-protocol'

let backend: DatabaseBackend
let lock: ProfileLock
let profile: string
let taskId: string
let allowed: boolean
let closing: boolean
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'page-proof', webviewId: 'main' }
const payload = () => ({ taskId, page: { version: 1, mode: 'snapshot', after: 0 } })
beforeEach(() => {
  allowed = true
  closing = false
  profile = mkdtempSync(join(tmpdir(), '21x-page-authority-'))
  lock = acquireProfileLock(profile)
  backend = new DatabaseBackend({ engineEpoch: caller.engineEpoch, lock,
    runtime: { paths: { profileRoot: lock.profileRoot, workspaceRoot: join(profile, 'workspaces'), attachmentRoot: join(profile, 'attachments') },
      managedTaskMcp: { disabled: true }, logger: { log() {}, error() {} } },
    isTrustedDesktop: identity => identity.webviewId === 'main', canAccessProject: () => allowed,
    assertOwnerAvailable: () => { if (closing) throw new ServiceProtocolError('DISCONNECTED') },
    canCreateProject: () => false, canEditSettings: () => false, emit() {} })
  taskId = backend.database.createTask({ title: 'Authority fixture' })!.id
  backend.database.upsertTranscriptParts(taskId, [{ id: 'part', role: 'assistant', content: 'Private fixture transcript' }])
})
afterEach(() => { backend.close(); lock.release(); rmSync(profile, { recursive: true, force: true }) })

describe('actual transcript page binding authority', () => {
  it('denies a closing owner after authorization before reading or mutating SQLite', async () => {
    const query = vi.spyOn(backend.database, 'getTranscriptPage')
    const write = vi.spyOn(backend.database, 'updateTask')
    const reading = backend.registry.invoke('agentSession:getTranscriptPage', payload(), caller, new AbortController().signal)
    const updating = backend.registry.invoke('db:updateTask', { id: taskId, data: { title: 'Late write' } }, caller, new AbortController().signal)
    closing = true
    await expect(reading).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(updating).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(query).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    expect(backend.database.getTask(taskId)?.title).toBe('Authority fixture')
  })

  it('rejects duplicate fixture part IDs before durable writes or event delivery', () => {
    const write = vi.spyOn(backend.database, 'upsertTranscriptParts')
    const part = { id: 'duplicate', role: 'assistant', content: 'fixture' }
    expect(() => backend.fixtureTranscriptUpsert({ taskId, parts: [part, part] }, caller, new AbortController().signal)).toThrow()
    expect(write).not.toHaveBeenCalled()
  })

  it('returns a validated page only for a trusted caller with project access', async () => {
    const result = await backend.registry.invoke('agentSession:getTranscriptPage', payload(), caller, new AbortController().signal)
    expect(result).toMatchObject({ defined: true, value: { taskId, version: 1, parts: [{ partId: 'part' }], hasMore: false } })
  })

  it('rejects denied projects and missing tasks before querying transcript rows', async () => {
    const query = vi.spyOn(backend.database, 'getTranscriptPage')
    allowed = false
    await expect(backend.registry.invoke('agentSession:getTranscriptPage', payload(), caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    allowed = true
    await expect(backend.registry.invoke('agentSession:getTranscriptPage', { ...payload(), taskId: 'missing' }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(query).not.toHaveBeenCalled()
  })

  it('rechecks project access after the authorization await boundary', async () => {
    const query = vi.spyOn(backend.database, 'getTranscriptPage')
    const pending = backend.registry.invoke('agentSession:getTranscriptPage', payload(), caller, new AbortController().signal)
    allowed = false
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects foreign labels/principals, stale epochs and cancelled requests before a read', async () => {
    const query = vi.spyOn(backend.database, 'getTranscriptPage')
    for (const identity of [{ ...caller, webviewId: 'artifact' }, { ...caller, principal: 'service' as const }]) {
      await expect(backend.registry.invoke('agentSession:getTranscriptPage', payload(), identity, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    await expect(backend.registry.invoke('agentSession:getTranscriptPage', payload(), { ...caller, engineEpoch: 'old' }, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(backend.registry.invoke('agentSession:getTranscriptPage', payload(), caller, aborted.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(query).not.toHaveBeenCalled()
  })
})
