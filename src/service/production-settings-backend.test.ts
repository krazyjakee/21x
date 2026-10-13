import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { RecurrenceSchedulerCore } from '../main/recurrence-scheduler-core'
import { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import { TaskAutomationScheduler } from '../main/task-automation-scheduler'
import { ScheduledCoordination } from '../main/scheduled-coordination-core'
import { WorkspaceCleanupSchedulerCore } from '../main/workspace-cleanup-scheduler-core'
import { WorktreeManager } from '../main/worktree-manager-core'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { SecretBroker } from '../main/secret-broker-core'
import { writeSecretShellWrapper } from '../main/secret-shell'
import { setTaskAutomationTrigger, setTaskSchedulers } from '../main/task-updates'
import { ProductionSettingsBackend, type ProductionSettingsBackendOptions, type SettingsOwners } from './production-settings-backend'
import { PRODUCTION_SETTINGS_CODECS, PRODUCTION_API_KEY_SET_MARKER as marker, type ProductionSettingsCodec, type ProductionSettingsOperation } from '../shared/production-settings-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'

class SettingsAdapter extends FakeAdapter { readonly notifyConfigChanged = vi.fn(async (): Promise<void> => undefined) }
let db: ReturnType<typeof createPortableTestDb>
let manager: AgentManager
let adapter: SettingsAdapter
let recurrence: RecurrenceSchedulerCore
let heartbeat: HeartbeatSchedulerCore
let automation: TaskAutomationScheduler
let coordination: ScheduledCoordination
let cleanup: WorkspaceCleanupSchedulerCore
let worktrees: WorktreeManager
let storage: AuthenticatedSecretStorage
let broker: SecretBroker
let backend: ProductionSettingsBackend
let options: ProductionSettingsBackendOptions
let events: Array<{ operation: string; payload: JsonValue }>
let root: string
let priorStorage: SecretStorage
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'settings-epoch', webviewId: 'main', origin: 'app://settings' }
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture')))
  priorStorage = getSecretStorage(); releaseSecretStorage(priorStorage)
  storage = new AuthenticatedSecretStorage(Buffer.alloc(32, 41), 'settings-unit-profile'); configureSecretStorage(storage)
  adapter = new SettingsAdapter(); events = []; broker = new SecretBroker(db)
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'broker', getPort: () => broker.port, register: (token, id, secretIds) => broker.register(token, id, secretIds), unregister: token => broker.unregister(token), writeShellWrapper: () => writeSecretShellWrapper(root) },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
  manager = new AgentManager(db, host)
  recurrence = new RecurrenceSchedulerCore(db, 'UTC'); heartbeat = new HeartbeatSchedulerCore(db, manager); automation = new TaskAutomationScheduler(db, manager)
  setTaskSchedulers({ recurrence, heartbeat }); setTaskAutomationTrigger(() => { void automation.runNow() }, automation)
  coordination = new ScheduledCoordination({ db, agents: manager })
  worktrees = new WorktreeManager({ reposRoot: join(root, 'repos'), workspaceRoot: join(root, 'workspaces'), emitProgress: data => { events.push({ operation: 'fixture:worktree-progress', payload: { taskId: data.taskId, repo: data.repo, step: data.step, done: data.done, ...(data.error === undefined ? {} : { error: data.error }) } }) } })
  cleanup = new WorkspaceCleanupSchedulerCore(db, worktrees, { workspacesRoot: join(root, 'workspaces'), listWorkspaceDirs: () => existsSync(join(root, 'workspaces')) ? readdirSync(join(root, 'workspaces')) : [] })
  const owners: SettingsOwners = { database: db, manager, recurrence, heartbeat, automation, coordination, cleanup, secretStorage: storage }
  options = { ...owners, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed profile') },
    assertSettingsOwners(actual) { for (const key of Object.keys(owners) as Array<keyof SettingsOwners>) if (actual[key] !== owners[key]) throw new Error('Wrong application owner') },
    // This fixture exercises real coding-owner fences. The root production
    // composition separately proves the Chat/Commander provider-turn fence.
    runCredentialMutation: (input, mutation) => manager.runProductionCredentialMutation(input, mutation),
    isTrustedDesktop: value => value.webviewId === 'main' && value.origin === caller.origin,
    canReadSetting: () => true, canWriteSetting: () => true, canManageGlobalConfiguration: () => true,
    canAccessAgent: () => true, canAccessProject: () => true, canAccessSecret: () => true, canCreateSecret: () => true, canUseSecretEnvironment: () => true, canReadEnvironment: () => true,
    environment: { OPENAI_API_KEY: 'private-environment-value', ANTHROPIC_API_KEY: '' },
    emit: (operation, payload) => { events.push({ operation, payload }) }, onFatalEvent: vi.fn() }
  backend = new ProductionSettingsBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  await backend.close(); await coordination.close(); await cleanup.close(); await automation.close(); await recurrence.close(); await heartbeat.close(); await manager.stopAllSessions(); await broker.close(); await worktrees.close()
  setTaskSchedulers({ recurrence: null, heartbeat: null }); setTaskAutomationTrigger(null)
  db.close(); releaseSecretStorage(storage); storage.dispose(); configureSecretStorage(priorStorage); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends ProductionSettingsOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = PRODUCTION_SETTINGS_CODECS[operation] as ProductionSettingsCodec<K>
  const result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(result)).toBe(true)
  return codec.decodeResult((result as { defined: boolean; value?: JsonValue }).value)
}
function agent(name = 'Owner') { return db.createAgent({ name, config: { coding_agent: 'opencode', concurrency_cap: 2, max_parallel_sessions: 2 } })! }
async function live(agentId: string, title = 'Owned work') {
  const task = db.createTask({ title })!; db.updateTask(task.id, { agent_id: agentId })
  const result = await manager.requestSession(agentId, task.id)
  expect(result.status).toBe('started')
  if (result.status !== 'started') throw new Error('Fixture did not start')
  return { task, sessionId: result.sessionId }
}
describe('production settings actual-owner bindings', () => {
  it('encrypts provider keys with the registered format and preserves marker/empty/missing semantics', async () => {
    const value = '\uFEFFprovider-key-雪\nsecond-line'
    await call('settings:set', ['openai_api_key', value])
    const row = db.db.prepare('SELECT value FROM settings WHERE key=?').get('openai_api_key') as { value: string }
    expect(row.value).toMatch(/^21x-credential:21x\.aes256gcm\.v1:/)
    expect(row.value).not.toContain('provider-key-雪'); expect(db.getSetting('openai_api_key')).toBe(value)
    expect(await call('settings:get', ['openai_api_key'])).toBe(marker)
    expect(await call('settings:getAll', [])).toEqual({ openai_api_key: marker })
    await call('settings:set', ['openai_api_key', marker])
    expect((db.db.prepare('SELECT value FROM settings WHERE key=?').get('openai_api_key') as { value: string }).value).toBe(row.value)
    expect(events).toHaveLength(1)
    await call('settings:set', ['openai_api_key', ''])
    expect(await call('settings:get', ['openai_api_key'])).toBe('')
    expect(await call('settings:get', ['google_api_key'])).toBeNull()
    expect(JSON.stringify(events)).not.toContain('provider-key')
  })

  it('does not read/export auth, pairing or unrelated malformed credential rows', async () => {
    db.setSetting('theme', 'dark')
    for (const [key, value] of [['mobile_auth_token', 'live-token'], ['mobile_init_code_current', 'pairing-code'], ['sessions.commander_memory', 'private-conversation']]) db.setSetting(key, value)
    db.db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('private_api_key', '21x-credential:unsupported:private')
    const read = vi.spyOn(db, 'getSetting')
    expect(await call('settings:getAll', [])).toEqual({ theme: 'dark' })
    expect(read.mock.calls.map(([key]) => key)).toEqual(['theme'])
    for (const key of ['mobile_auth_token', 'mobile_init_code_current', 'private_api_key']) await expect(backend.registry.invoke('settings:get', { key }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  })

  it('encrypts stored Google/Cursor credentials without inventing a consumed provider or stopping coding work', async () => {
    const owner = agent(), active = await live(owner.id)
    const fence = vi.spyOn(manager, 'runProductionCredentialMutation')
    for (const key of ['google_api_key', 'cursor_api_key']) {
      const value = `\uFEFFstored-${key}-雪\nsecond-line`
      await call('settings:set', [key, value])
      const row = db.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string }
      expect(row.value).toMatch(/^21x-credential:21x\.aes256gcm\.v1:/)
      expect(row.value).not.toContain(`stored-${key}`)
      expect(db.getSetting(key)).toBe(value)
      expect(await call('settings:get', [key])).toBe(marker)
    }
    expect(fence).not.toHaveBeenCalled()
    expect(manager.getSession(active.sessionId)).toBeDefined()
    expect(adapter.destroySession).not.toHaveBeenCalled(); expect(adapter.notifyConfigChanged).not.toHaveBeenCalled()
    expect(await call('settings:getAll', [])).toEqual({ google_api_key: marker, cursor_api_key: marker })
    expect(JSON.stringify(events)).not.toContain('stored-')
  })

  it('allows read grants independently and masks actual environment presence', async () => {
    db.setSetting('theme', 'light')
    options.canWriteSetting = () => false; options.canManageGlobalConfiguration = (_caller, access) => access === 'read'
    expect(await call('settings:get', ['theme'])).toBe('light')
    expect(await call('env:get', ['OPENAI_API_KEY'])).toBe(marker)
    expect(await call('env:get', ['ANTHROPIC_API_KEY'])).toBe('')
    expect(await call('env:get', ['CURSOR_API_KEY'])).toBeNull()
    await expect(call('settings:set', ['theme', 'dark'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('secrets:create', [{ name: 'Forbidden', description: '', env_var_name: 'DATABASE_URL', value: 'private' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getSetting('theme')).toBe('light'); expect(db.getSecrets()).toEqual([])
    options.canReadEnvironment = () => false
    await expect(call('env:get', ['OPENAI_API_KEY'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('uses the actual global admission owner to drain queued work when the cap changes', async () => {
    const owner = agent(); db.setSetting('max_concurrent_agent_sessions', '1')
    const first = await live(owner.id)
    // This case isolates the global cap; Captain-controlled project levels
    // remain independently enforced by the real admission owner.
    db.updateProject(first.task.project_id, { settings: { concurrency: { captain_control: false } } })
    const waiting = db.createTask({ title: 'Queued work' })!; db.updateTask(waiting.id, { agent_id: owner.id })
    expect((await manager.requestSession(owner.id, waiting.id)).status).toBe('queued')
    await call('settings:set', ['max_concurrent_agent_sessions', '2'])
    // Join the actual accepted queue-start flight, rather than counting a
    // mocked drain callback as evidence that the task started.
    expect((await manager.requestSession(owner.id, waiting.id)).status).toBe('started')
    expect(manager.findSessionByTaskId(waiting.id)).toBeDefined()
    expect(adapter.createSession).toHaveBeenCalledTimes(2)
    await call('settings:set', ['all_projects_paused', '1'])
    expect(manager.isAllProjectsPaused()).toBe(true)
    await call('settings:set', ['all_projects_paused', '0'])
    expect(manager.isAllProjectsPaused()).toBe(false)
  })

  it('preflights actual target references and scope before credential or native effects', async () => {
    const owner = agent(), active = await live(owner.id), other = db.createProject({ name: 'Foreign project' })!
    options.canAccessProject = id => id !== other.id
    for (const [key, value] of [['current_project_id', other.id], ['default_agent_id', owner.id]]) await expect(call('settings:set', [key, value])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canWriteSetting = key => key !== 'openai_api_key'
    await expect(call('settings:set', ['openai_api_key', 'new-private-key'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessProject = () => true
    for (const key of ['default_agent_id', 'chat_agent_id']) await expect(call('settings:set', [key, 'missing-agent'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('settings:set', ['current_project_id', 'missing-project'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('settings:set', ['canvas_state:missing-project', '{}'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    for (const [key, value] of [['voice_enabled', 'true'], ['voice_custom_model_dir', '/tmp/untrusted'], ['voice_global_shortcut', 'Ctrl+X'], ['elevenlabs_api_key', 'new-private-key'], ['minimize_to_tray', 'true']]) {
      await expect(call('settings:set', [key, value])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(db.getSetting(key)).toBeUndefined()
    }
    expect(manager.getSession(active.sessionId)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled(); expect(adapter.notifyConfigChanged).not.toHaveBeenCalled()
  })

  it('preserves unrelated coding owners when global chat credentials or future default selection changes', async () => {
    const first = agent('First'), other = agent('Other')
    const firstLive = await live(first.id), otherLive = await live(other.id, 'Other accepted work')
    await call('settings:set', ['openai_api_key', 'chat-provider-only-key'])
    await call('settings:set', ['default_agent_id', other.id])
    expect(manager.getSession(firstLive.sessionId)).toBeDefined(); expect(manager.getSession(otherLive.sessionId)).toBeDefined()
    expect(adapter.destroySession).not.toHaveBeenCalled(); expect(adapter.notifyConfigChanged).not.toHaveBeenCalled()
    expect(db.getSetting('default_agent_id')).toBe(other.id)
    expect(await call('settings:get', ['openai_api_key'])).toBe(marker)
    options.canAccessAgent = id => id !== other.id
    await expect(call('settings:get', ['default_agent_id'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await call('settings:getAll', [])).not.toHaveProperty('default_agent_id')
  })

  it('stores bounded scoped/UI/scheduler settings without triggering destructive cleanup or a paid briefing', async () => {
    const project = db.createProject({ name: 'Scoped content' })!
    await call('settings:set', [`drawing_state:${project.id}`, '{"objects":[],"nextZIndex":1}'])
    expect(await call('settings:get', [`drawing_state:${project.id}`])).toBe('{"objects":[],"nextZIndex":1}')
    await call('settings:set', ['heartbeat_default_interval', '15'])
    await call('settings:set', ['workspace_autocleanup_days', '14'])
    await call('settings:set', ['commander_briefing', '{"enabled":true,"cron":"0 8 * * 1-5","speak":false}'])
    await call('settings:set', ['voice_advanced_stt', 'true'])
    expect(db.getSetting('heartbeat_default_interval')).toBe('15')
    expect(db.getSetting('workspace_autocleanup_days')).toBe('14')
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
    options.canAccessProject = id => id !== project.id
    await expect(call('settings:get', [`drawing_state:${project.id}`])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await call('settings:getAll', [])).not.toHaveProperty(`drawing_state:${project.id}`)
  })

  it('encrypts secret BLOBs and returns exact metadata while preserving omitted/empty updates', async () => {
    const value = '\uFEFFprivate-secret-雪\nsecond-line'
    const secret = await call('secrets:create', [{ name: 'Database', description: 'Access', env_var_name: 'DATABASE_URL', value }])
    const row = db.db.prepare('SELECT value FROM secrets WHERE id=?').get(secret.id) as { value: Buffer }
    expect(Buffer.isBuffer(row.value)).toBe(true); expect(row.value.toString('utf8')).not.toContain('private-secret')
    expect(storage.decryptString(row.value)).toBe(value)
    expect(secret).not.toHaveProperty('value')
    expect(await call('secrets:getAll', [])).toEqual([secret])
    const updated = await call('secrets:update', [secret.id, { name: 'Renamed' }])
    expect(updated?.name).toBe('Renamed')
    expect((db.db.prepare('SELECT value FROM secrets WHERE id=?').get(secret.id) as { value: Buffer }).value.equals(row.value)).toBe(true)
    await call('secrets:update', [secret.id, { value: '' }])
    expect(db.getSecretsWithValues([secret.id])[0].value).toBe('')
    expect(JSON.stringify(await call('secrets:getAll', []))).not.toMatch(/private-secret|value|ciphertext/)
    expect(await call('secrets:update', ['missing-secret', { name: 'Missing' }])).toBeUndefined()
    expect(await call('secrets:delete', ['missing-secret'])).toBe(false)
  })

  it('checks every referenced owner before secret mutation and scrubs authorized references after deletion', async () => {
    const secret = db.createSecret({ name: 'Reference', description: '', env_var_name: 'SERVICE_TOKEN', value: 'private' })!
    const owner = agent(); db.updateAgent(owner.id, { config: { ...owner.config, secret_ids: [secret.id], api_keys: { openai: 'legacy-saved-agent-key' } } })
    const active = await live(owner.id)
    options.canAccessAgent = () => false
    await expect(call('secrets:update', [secret.id, { value: 'new-private' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('secrets:delete', [secret.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(manager.getSession(active.sessionId)).toBeDefined(); expect(adapter.destroySession).not.toHaveBeenCalled()
    options.canAccessAgent = () => true
    expect(await call('secrets:delete', [secret.id])).toBe(true)
    expect(manager.getSession(active.sessionId)).toBeUndefined()
    expect(adapter.destroySession).toHaveBeenCalledWith(active.sessionId, expect.any(Object))
    expect(db.getAgent(owner.id)?.config.secret_ids).toEqual([])
    expect(db.getAgent(owner.id)?.config.api_keys?.openai).toBe('legacy-saved-agent-key')
    expect(db.getSecret(secret.id)).toBeUndefined()
  })

  it('preflights an actual shared-adapter expansion before stopping an unrelated scoped owner', async () => {
    const secret = db.createSecret({ name: 'Shared cache', description: '', env_var_name: 'SERVICE_TOKEN', value: 'original' })!
    const primary = agent('Secret owner'), other = agent('Shared backend owner')
    db.updateAgent(primary.id, { config: { ...primary.config, secret_ids: [secret.id] } })
    const primaryLive = await live(primary.id), otherLive = await live(other.id, 'Shared accepted work')
    expect(manager.getProductionCredentialAffectedAgents({ kind: 'secret', secretId: secret.id })).toEqual(expect.arrayContaining([primary.id, other.id]))
    options.canAccessAgent = id => id !== other.id
    await expect(call('secrets:update', [secret.id, { value: 'replacement' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(manager.getSession(primaryLive.sessionId)).toBeDefined(); expect(manager.getSession(otherLive.sessionId)).toBeDefined()
    expect(adapter.destroySession).not.toHaveBeenCalled(); expect(db.getSecretsWithValues([secret.id])[0].value).toBe('original')
  })

  it('refuses reserved process-control env names and foreign secret grants before encryption/effects', async () => {
    for (const name of ['PATH', 'NODE_OPTIONS', 'TASK_API_TOKEN', 'LD_PRELOAD', 'GIT_ASKPASS']) await expect(call('secrets:create', [{ name: 'Forbidden', description: '', env_var_name: name, value: 'private' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canUseSecretEnvironment = () => false
    await expect(call('secrets:create', [{ name: 'Denied', description: '', env_var_name: 'DATABASE_URL', value: 'private' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getSecrets()).toEqual([])
    const secret = db.createSecret({ name: 'Hidden', description: '', env_var_name: 'SERVICE_TOKEN', value: 'private' })!
    options.canAccessSecret = () => false
    expect(await call('secrets:getAll', [])).toEqual([])
    await expect(call('secrets:delete', [secret.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getSecret(secret.id)).toBeDefined()
  })

  it('retains accepted Stop through cancellation and suppresses the credential write before its effect', async () => {
    const secret = db.createSecret({ name: 'Pending mutation', description: '', env_var_name: 'SERVICE_TOKEN', value: 'original' })!
    const owner = agent(); db.updateAgent(owner.id, { config: { ...owner.config, secret_ids: [secret.id] } }); await live(owner.id)
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), pending = new Promise<void>(resolve => { release = resolve })
    adapter.destroySession.mockImplementationOnce(async () => { entered(); await pending })
    const controller = new AbortController(), flight = call('secrets:update', [secret.id, { value: 'must-not-be-written' }], controller.signal)
    await started; controller.abort()
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(backend.inflightCount).toBe(1); expect(db.db.open).toBe(true); expect(storage.isEncryptionAvailable()).toBe(true)
    release(); await expect(flight).rejects.toMatchObject({ code: 'CANCELLED' }); await backend.close()
    expect(db.getSecretsWithValues([secret.id])[0].value).toBe('original'); expect(adapter.destroySession).toHaveBeenCalledOnce(); expect(events).toEqual([])
  })

  it('retains an accepted credential write through late notification cancellation without replay', async () => {
    const secret = db.createSecret({ name: 'Accepted mutation', description: '', env_var_name: 'SERVICE_TOKEN', value: 'original' })!
    const owner = agent(); db.updateAgent(owner.id, { config: { ...owner.config, secret_ids: [secret.id] } }); await live(owner.id)
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), pending = new Promise<void>(resolve => { release = resolve })
    adapter.notifyConfigChanged.mockImplementationOnce(async () => { entered(); await pending })
    const controller = new AbortController(), flight = call('secrets:update', [secret.id, { value: 'accepted-private-key' }], controller.signal)
    await started; controller.abort()
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(db.getSecretsWithValues([secret.id])[0].value).toBe('accepted-private-key')
    release(); await expect(flight).rejects.toMatchObject({ code: 'CANCELLED' }); await backend.close()
    expect(adapter.notifyConfigChanged).toHaveBeenCalledOnce(); expect(events).toEqual([{ operation: 'tasks:refresh', payload: {} }])
    expect(db.getSecretsWithValues([secret.id])[0].value).toBe('accepted-private-key')
  })

  it('rejects changed secret references after acknowledged Stop instead of mutating an unfenced owner', async () => {
    const secret = db.createSecret({ name: 'Changing references', description: '', env_var_name: 'SERVICE_TOKEN', value: 'original' })!
    const owner = agent(); db.updateAgent(owner.id, { config: { ...owner.config, secret_ids: [secret.id] } }); await live(owner.id)
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), pending = new Promise<void>(resolve => { release = resolve })
    adapter.destroySession.mockImplementationOnce(async () => { entered(); await pending })
    const flight = call('secrets:update', [secret.id, { value: 'replacement' }])
    await started
    const other = agent('New reference'); db.updateAgent(other.id, { config: { ...other.config, secret_ids: [secret.id] } })
    release()
    await expect(flight).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(db.getSecretsWithValues([secret.id])[0].value).toBe('original')
    expect(db.getAgent(other.id)?.config.secret_ids).toEqual([secret.id])
    expect(events).toEqual([])
  })

  it('latches accepted invalidation failure, denies stale callers and preserves incompatible stored formats', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(call('settings:set', ['theme', 'dark'], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(call('settings:set', ['theme', 'dark'], new AbortController().signal, { ...caller, engineEpoch: 'stale' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(call('settings:set', ['theme', 'dark'], new AbortController().signal, { ...caller, webviewId: 'foreign' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    db.db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('openai_api_key', 'safeStorage:v1:incompatible')
    await expect(call('settings:get', ['openai_api_key'])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect((db.db.prepare('SELECT value FROM settings WHERE key=?').get('openai_api_key') as { value: string }).value).toBe('safeStorage:v1:incompatible')
    options.emit = () => { throw new Error('Sink disconnected') }
    await expect(call('settings:set', ['theme', 'dark'])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(db.getSetting('theme')).toBe('dark'); expect(options.onFatalEvent).toHaveBeenCalledOnce()
    await expect(call('settings:set', ['theme', 'light'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getSetting('theme')).toBe('dark')
  })

  it('fails closed on absent/replaced actual storage or scheduler identities', () => {
    const wrong = new AuthenticatedSecretStorage(Buffer.alloc(32, 99), 'wrong-profile')
    expect(() => new ProductionSettingsBackend({ ...options, secretStorage: wrong })).toThrow('owner')
    wrong.dispose()
    setTaskAutomationTrigger(null)
    expect(() => new ProductionSettingsBackend(options)).toThrow('owners')
  })
})
