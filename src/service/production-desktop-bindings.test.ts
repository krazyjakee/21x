import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProductionOwner, ProductionOwnerBootstrap } from './production-owner'
import type { ProductionDesktopBindingOptions } from './production-desktop-bindings'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AGENT_CONFIGURATION_CODECS } from '../shared/agent-configuration-codecs'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { DATABASE_COMMAND_CODECS } from '../shared/database-desktop-codecs'
import { CONFIGURATION_COMMAND_CODECS } from '../shared/configuration-desktop-codecs'
import { CodingAgentType } from '../renderer/src/types'

const owned: Array<{ owner: ProductionOwner; root: string }> = [], finishers: Array<() => void> = []
beforeEach(() => vi.resetModules())
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish()
  for (const { owner, root } of owned.splice(0)) { await owner.close(); rmSync(root, { recursive: true, force: true }) }
  vi.restoreAllMocks()
})
async function fixture() {
  const { ProductionOwner } = await import('./production-owner')
  const { ProductionDesktopBindings } = await import('./production-desktop-bindings')
  const root = mkdtempSync(join(tmpdir(), '21x-production-bindings-')), resourceRoot = join(root, 'resources')
  mkdirSync(resourceRoot)
  const keys = new Map<string, Buffer>(), adapter = new FakeAdapter()
  const bootstrap: ProductionOwnerBootstrap = {
    profileId: 'production-bindings-fixture', paths: { profileRoot: join(root, 'profile'), workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), resourceRoot, tempRoot: join(root, 'temp') },
    credentials: { mode: 'create', store: { create: async (id, key) => { keys.set(id, Buffer.from(key)) }, load: async id => {
      const key = keys.get(id)
      if (!key) throw Object.assign(new Error('KEYSTORE_NO_ENTRY'), { code: 'KEYSTORE_NO_ENTRY' })
      return Buffer.from(key)
    } } },
    managedTaskMcp: { disabled: true }, connectors: { kind: 'disabled', reason: 'No connector resources in this fixture.' },
    native: { agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: 'disabled' },
      prepareRuntime: async () => {}, openExternal: async () => {}, notify: () => {}, emit: () => {}, sendUiCommand: () => ({ ok: false, detail: 'No fixture window.' }), drainOwnedProcesses: async () => ({ acknowledged: true }) }
  }
  const owner = new ProductionOwner(bootstrap, { createAdapter: () => adapter, createProvider: () => ({ id: 'fixture', model: 'fixture', async *stream() { yield { type: 'message_end', stopReason: 'end_turn' } } }) })
  owned.push({ owner, root }); const services = await owner.start(), epoch = owner.snapshot().epoch
  const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: epoch, webviewId: 'main', origin: 'tauri://localhost' }
  const events: Array<{ operation: string; payload: unknown }> = []
  const trusted = (value: DesktopCallerContext) => value.engineEpoch === epoch && value.webviewId === 'main' && value.origin === 'tauri://localhost'
  const options: ProductionDesktopBindingOptions = { authority: {
    isTrustedDesktop: trusted, canAccessProject: (id, value, access) => trusted(value) && !!services.db.getProject(id) && (value.principal === 'trusted-desktop-main') && (access === 'read' || value.webviewId === 'main'),
    canAccessAgent: (_id, value) => trusted(value), canManageGlobalConfiguration: trusted, canQueryBackend: (_type, _url, value) => trusted(value),
    canCreateProject: trusted, canEditSettings: trusted, canAccessGlobalSkills: trusted, canChangeSkillScope: trusted, canReorderProjects: trusted },
    emit: (operation, payload) => events.push({ operation, payload }), fatal: () => {} }
  const backend = await ProductionDesktopBindings.attach(owner, options), signal = new AbortController().signal
  return { owner, services, backend, options, caller, signal, events }
}

describe('reviewed bindings attached to the actual production singleton', () => {
  it('shares one database across task, content and agent mutations without replacing its lifecycle owner', async () => {
    const f = await fixture(), db = f.services.db
    expect(Object.keys(f.backend.operationSchemas(f.caller))).toHaveLength(39)
    const task = await f.backend.invoke('db:createTask', DATABASE_COMMAND_CODECS['db:createTask'].encodeArguments([{ title: 'Shared task' }]), f.caller, f.signal)
    expect(task).toMatchObject({ defined: true, value: { title: 'Shared task' } })
    const skill = await f.backend.invoke('skills:create', CONFIGURATION_COMMAND_CODECS['skills:create'].encodeArguments([{ name: 'Shared skill', description: 'Description', content: 'Instructions' }]), f.caller, f.signal)
    expect(skill).toMatchObject({ defined: true, value: { name: 'Shared skill' } })
    const agent = await f.backend.invoke('agent:create', AGENT_CONFIGURATION_CODECS['agent:create'].encodeArguments([{ name: 'Shared agent', config: { coding_agent: CodingAgentType.CODEX } }]), f.caller, f.signal)
    expect(agent).toMatchObject({ defined: true, value: { name: 'Shared agent' } })
    expect(db.getTasks().some(task => task.title === 'Shared task')).toBe(true)
    expect(db.getSkills().some(skill => skill.name === 'Shared skill')).toBe(true)
    expect(db.getAgents().some(agent => agent.name === 'Shared agent')).toBe(true)
    expect(f.events.map(event => event.operation)).toEqual(expect.arrayContaining(['task:created', 'skills:changed', 'tasks:refresh']))
    expect((await f.owner.start()).db).toBe(db)
    await f.owner.close(); expect(db.db.open).toBe(false)
    await expect(f.backend.invoke('db:getTasks', {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })
  it('denies stale/foreign callers, browser operations and unimplemented lifecycle writes', async () => {
    const f = await fixture()
    await expect(f.backend.invoke('db:getTasks', {}, { ...f.caller, engineEpoch: 'stale' }, f.signal)).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(f.backend.invoke('db:getTasks', {}, { ...f.caller, webviewId: 'artifact' }, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.backend.invoke('browser:create', {}, f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    await expect(f.backend.invoke('db:updateTask', { id: 'invented', data: { status: 'completed' } }, f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    await expect(f.backend.invoke('agentSession:start', { agentId: 'invented', taskId: 'invented' }, f.caller, f.signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  })
  it('keeps a cancelled raw model flight and the database lease until explicit drain retry', async () => {
    const f = await fixture(); let finish!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve }), entry = new Promise<void>(resolve => { entered = resolve })
    finishers.push(finish)
    vi.spyOn(f.services.agents, 'getProviders').mockImplementation(async () => { entered(); await gate; return { providers: [], default: {} } })
    const control = new AbortController()
    const reading = f.backend.invoke('agentConfig:getProviders', AGENT_CONFIGURATION_CODECS['agentConfig:getProviders'].encodeArguments([undefined, 'pi']), f.caller, control.signal)
    const result = expect(reading).rejects.toMatchObject({ code: 'CANCELLED' }); await entry; control.abort()
    await expect(f.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(f.services.db.db.open).toBe(true); expect(f.owner.snapshot().owned).toBe(true)
    finish(); await result; await f.owner.close(); expect(f.services.db.db.open).toBe(false)
  })
  it('requires write authority separately from read authority at the borrowed database boundary', async () => {
    const f = await fixture()
    f.options.authority.canAccessProject = (id, _caller, access) => !!f.services.db.getProject(id) && access === 'read'
    // The root identity is still trusted, but project write ownership is withdrawn.
    await expect(f.backend.invoke('db:createTask', { data: { title: 'Denied write' } }, f.caller, f.signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.backend.invoke('db:getTasks', {}, f.caller, f.signal)).resolves.toMatchObject({ defined: true })
    expect(f.services.db.getTasks().some(task => task.title === 'Denied write')).toBe(false)
  })
})
