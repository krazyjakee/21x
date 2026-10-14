import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { GitHubManager } from '../main/github-manager'
import { GitLabManager } from '../main/gitlab-manager'
import { ForgejoManager } from '../main/forgejo-manager'
import { PluginRegistry } from '../main/plugins/registry'
import { SyncManager } from '../main/sync-manager'
import { RecurrenceSchedulerCore } from '../main/recurrence-scheduler-core'
import { HeartbeatSchedulerCore } from '../main/heartbeat-scheduler-core'
import { TaskAutomationScheduler } from '../main/task-automation-scheduler'
import { setTaskAutomationTrigger, setTaskSchedulers } from '../main/task-updates'
import { applyMobileAccessSettings, assertMobileApiDeps, broadcastToMobileClients, closeMobileApiServer, getMobileApiBinding, revalidateMobileClients, setMobileApiDeps, setMobileApiNotifier, stopMobileApiServer, type MobileApiDeps } from '../main/mobile-api-server'
import { MOBILE_CODECS, MOBILE_OPERATIONS, type MobileCodec, type MobileOperation } from '../shared/mobile-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { MobileBackend, type MobileBackendOptions } from './mobile-backend'

class Adapter extends FakeAdapter {
  pending: Array<{ requestId: string; responseType: 'permission' | 'question' }> = []
  getPendingRequests = vi.fn(async () => this.pending)
  constructor() {
    super()
    this.respondToApproval!.mockImplementation(async (_id, _approved, _option, requestId) => {
      const index = this.pending.findIndex(item => item.requestId === requestId)
      if (index < 0) return false
      this.pending.splice(index, 1); return true
    })
  }
}
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'mobile-production-fixture', webviewId: 'main', origin: 'app://mobile-fixture' }
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, adapter: Adapter, sync: SyncManager, deps: MobileApiDeps, options: MobileBackendOptions, backend: MobileBackend, root: string, dist: string
let recurrence: RecurrenceSchedulerCore, heartbeat: HeartbeatSchedulerCore, automation: TaskAutomationScheduler
let notifications: Array<{ name: string; value: unknown }>, releases: Array<() => void>
let read = true, write = true, sessions = true
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture'))); dist = join(root, 'mobile'); mkdirSync(dist, { recursive: true }); writeFileSync(join(dist, 'index.html'), '<main>Synthetic mobile SPA without desktop bridge</main>')
  adapter = new Adapter(); manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false })
  recurrence = new RecurrenceSchedulerCore(db, 'UTC'); heartbeat = new HeartbeatSchedulerCore(db, manager); automation = new TaskAutomationScheduler(db, manager)
  setTaskSchedulers({ recurrence, heartbeat }); setTaskAutomationTrigger(() => { void automation.runNow() }, automation)
  const registry = new PluginRegistry(); sync = new SyncManager(db, registry)
  deps = { db, agentManager: manager, githubManager: new GitHubManager(), gitlabManager: new GitLabManager(), forgejoManager: new ForgejoManager(key => db.getSetting(key)), syncManager: sync, pluginRegistry: registry, mobileDistRoot: dist, taskOwners: { recurrence, heartbeat, automation } }
  setMobileApiDeps(deps); notifications = []; releases = []; read = write = sessions = true
  setMobileApiNotifier((name, value) => notifications.push({ name, value }))
  options = { deps, tunnel: null, engineEpoch: caller.engineEpoch, port: 0, lanAddress: () => '192.0.2.10',
    assertAvailable() { if (!db.db.open) throw new Error('Fixture closed') }, assertMobileOwners(actual, tunnel) { if (actual !== deps || tunnel !== null) throw new Error('Wrong owner'); assertMobileApiDeps(actual) },
    isTrustedDesktop: identity => identity.origin === caller.origin && identity.webviewId === caller.webviewId,
    canManageMobile: (_caller, access) => read && (access === 'read' || write), canAccessSession: () => sessions }
  backend = new MobileBackend(options)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const release of releases) release()
  await Promise.all([backend.close(), closeMobileApiServer()]); await automation.close(); await recurrence.close(); await heartbeat.close(); await sync.close(); await manager.stopAllSessions()
  setTaskSchedulers({ recurrence: null, heartbeat: null }); setTaskAutomationTrigger(null); setMobileApiNotifier(() => {})
  db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
function held() { let release!: () => void; const promise = new Promise<void>(done => { release = done }); return { promise, release } }
async function call<K extends MobileOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = MOBILE_CODECS[operation] as MobileCodec<K>, result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(result)).toBe(true); return codec.decodeResult((result as { value?: JsonValue }).value)
}
async function enable() { await call('mobile:setAccess', [{ enabled: true }]); return `http://127.0.0.1:${getMobileApiBinding()!.port}` }
async function post(base: string, path: string, value: unknown, token?: string, signal?: AbortSignal) {
  return fetch(base + path, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) })
}
async function pair(base: string) {
  const info = await call('mobile:getInfo', []), code = new URL(info.url).searchParams.get('code')!
  const response = await post(base, '/api/auth/pair/initiate', { code }); expect(response.status).toBe(200)
  const initiated = await response.json() as { pairCodeId: string }, pin = await call('mobile:getPendingPin', [])
  expect(pin?.pairCodeId).toBe(initiated.pairCodeId)
  const verify = await post(base, '/api/auth/pair/verify', { pairCodeId: initiated.pairCodeId, pin: pin!.pin }); expect(verify.status).toBe(200)
  return await verify.json() as { sessionToken: string; sessionId: string; deviceName: string }
}
async function websocket(base: string, token: string) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + `/ws?token=${token}`); ws.on('error', () => {}); await once(ws, 'open'); return ws
}
describe('production mobile controls and actual loopback owners', () => {
  it('binds ten exact operations, keeps access opt-in, and refuses unavailable quick tunnels before any effect', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual([...MOBILE_OPERATIONS]); expect(getMobileApiBinding()).toBeNull()
    expect(await call('mobile:getInfo', [])).toMatchObject({ enabled: false, lanAccess: false, tunnelActive: false, port: 20620 })
    await expect(call('mobile:startTunnel', [])).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' }); expect(getMobileApiBinding()).toBeNull()
    const base = await enable(); expect(getMobileApiBinding()).toMatchObject({ host: '127.0.0.1' })
    expect((await fetch(base + '/')).status).toBe(200); expect(await (await fetch(base + '/')).text()).toContain('without desktop bridge')
    const enabled = await call('mobile:getInfo', []); expect(enabled.port).toBe(Number(new URL(base).port))
    await call('mobile:setAccess', [{ lanAccess: true }]); expect(getMobileApiBinding()?.host).toBe('0.0.0.0')
    expect((await call('mobile:getInfo', [])).lanUrl).toContain('192.0.2.10')
    await call('mobile:setAccess', [{ enabled: false }]); expect(getMobileApiBinding()).toBeNull()
  })
  it('pairs once, stores only SHA256 session credential, retains PIN expiry/attempt/rate limits, and projects only metadata', async () => {
    const base = await enable(), info = await call('mobile:getInfo', []), code = new URL(info.url).searchParams.get('code')!
    const init = await post(base, '/api/auth/pair/initiate', { code }); const { pairCodeId } = await init.json() as { pairCodeId: string }
    expect((await post(base, '/api/auth/pair/initiate', { code })).status).toBe(401)
    const pin = (await call('mobile:getPendingPin', []))!
    const verified = await post(base, '/api/auth/pair/verify', { pairCodeId, pin: pin.pin }); const device = await verified.json() as { sessionToken: string; sessionId: string }
    const row = db.db.prepare('SELECT token_hash FROM mobile_sessions WHERE id=?').get(device.sessionId) as { token_hash: string }
    expect(row.token_hash).toBe(createHash('sha256').update(device.sessionToken).digest('hex')); expect(row.token_hash).not.toBe(device.sessionToken)
    const publicRows = await call('mobile:getSessions', []); expect(publicRows).toHaveLength(1); expect(Object.keys(publicRows[0]!)).toEqual(['id', 'device_name', 'paired_at', 'last_seen'])
    expect(JSON.stringify(publicRows)).not.toContain(device.sessionToken); expect(JSON.stringify(publicRows)).not.toContain(row.token_hash)
    db.createMobilePairCode('expired-fixture', '123456', 1)
    expect((await post(base, '/api/auth/pair/verify', { pairCodeId: 'expired-fixture', pin: '123456' })).status).toBe(401)
    db.createMobilePairCode('limited-fixture', '123456', Math.floor(Date.now() / 1000) + 60)
    for (let i = 0; i < 4; i++) expect((await post(base, '/api/auth/pair/verify', { pairCodeId: 'limited-fixture', pin: '000000' })).status).toBe(401)
    expect(db.getMobilePairCode('limited-fixture')).toBeUndefined()
    for (let i = 0; i < 20; i++) await post(base, '/api/auth/pair/initiate', { code: `invalid-${i}` })
    expect((await post(base, '/api/auth/pair/initiate', { code: 'invalid-limited' })).status).toBe(429)
  })
  it('immediately terminates revoked sockets and refuses HTTP/WS auth; expiry checks never extend last_seen', async () => {
    const base = await enable(), device = await pair(base), ws = await websocket(base, device.sessionToken), closed = once(ws, 'close')
    expect((await fetch(base + '/api/tasks')).status).toBe(401)
    await call('mobile:revokeSession', [device.sessionId]); await closed
    expect(ws.readyState).toBe(WebSocket.CLOSED); expect((await fetch(base + '/api/tasks', { headers: { Authorization: `Bearer ${device.sessionToken}` } })).status).toBe(401)
    const again = await pair(base), ws2 = await websocket(base, again.sessionToken), closed2 = once(ws2, 'close')
    db.db.prepare('UPDATE mobile_sessions SET last_seen=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 100, again.sessionId)
    const before = db.db.prepare('SELECT last_seen FROM mobile_sessions WHERE id=?').get(again.sessionId)
    revalidateMobileClients(); expect(db.db.prepare('SELECT last_seen FROM mobile_sessions WHERE id=?').get(again.sessionId)).toEqual(before)
    db.db.prepare('UPDATE mobile_sessions SET last_seen=1 WHERE id=?').run(again.sessionId); revalidateMobileClients(); await closed2
    expect(db.getMobileSessionByTokenHash(createHash('sha256').update(again.sessionToken).digest('hex'))).toBeUndefined()
  })
  it('uses actual admission/HITL and durable projection on reconnect without another provider/session', async () => {
    const base = await enable(), device = await pair(base), agent = db.createAgent({ name: 'Controlled coding owner', is_default: true, config: { coding_agent: 'pi', max_parallel_sessions: 1 } })!, task = db.createTask({ title: 'Actual mobile owned task' })!, queued = db.createTask({ title: 'Queued task' })!
    db.updateTask(task.id, { agent_id: agent.id }); db.updateTask(queued.id, { agent_id: agent.id })
    const started = await post(base, '/api/sessions/start', { taskId: task.id, agentId: agent.id }, device.sessionToken); const live = await started.json() as { sessionId: string }
    expect(started.status).toBe(200); expect(manager.getSession(live.sessionId)?.taskId).toBe(task.id)
    const waiting = await post(base, '/api/sessions/start', { taskId: queued.id, agentId: agent.id }, device.sessionToken)
    expect(await waiting.json()).toMatchObject({ queued: true, queuePosition: 1, queueReason: 'agent_limit' }); expect(adapter.createSession).toHaveBeenCalledOnce()
    adapter.pending = [{ requestId: 'exact-fixture-approval', responseType: 'permission' }]
    const approved = await post(base, `/api/sessions/${live.sessionId}/approve`, { approved: true, responseType: 'permission', requestId: 'exact-fixture-approval' }, device.sessionToken)
    expect(approved.status).toBe(200); expect(adapter.respondToApproval).toHaveBeenCalledWith(expect.any(String), true, undefined, 'exact-fixture-approval')
    db.upsertTranscriptParts(task.id, [{ id: 'persisted-mobile-part', role: 'assistant', partType: 'text', content: 'Durable actual projection' }])
    const ws = await websocket(base, device.sessionToken), notice = once(ws, 'message')
    broadcastToMobileClients('transcript:changed', { taskId: task.id, parts: db.getTranscriptParts(task.id), maxRev: 1 })
    expect(String((await notice)[0])).toContain('Durable actual projection')
    await stopMobileApiServer(); await applyMobileAccessSettings(0)
    const secondBase = `http://127.0.0.1:${getMobileApiBinding()!.port}`
    const response = await fetch(secondBase + `/api/tasks/${task.id}/transcript`, { headers: { Authorization: `Bearer ${device.sessionToken}` } })
    expect(await response.json()).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Durable actual projection' })])); expect(adapter.createSession).toHaveBeenCalledOnce()
  })
  it('refuses unreviewed task resources and learning edits before touching the actual task', async () => {
    const base = await enable(), device = await pair(base), task = db.createTask({ title: 'Preserved phone task' })!
    const before = db.getTask(task.id)
    for (const data of [{ status: 'agent_learning' }, { project_id: task.project_id }, { heartbeat_enabled: true }, { skill_ids: ['unknown'] }]) {
      expect((await post(base, `/api/tasks/${task.id}`, data, device.sessionToken)).status).toBeGreaterThanOrEqual(400)
      expect(db.getTask(task.id)).toEqual(before)
    }
    expect((await post(base, '/api/tasks', { title: 'Unreviewed repository', repos: [{ full_name: 'outside/project' }] }, device.sessionToken)).status).toBeGreaterThanOrEqual(400)
    expect(db.getTasks().some(task => task.title === 'Unreviewed repository')).toBe(false)
    expect((await post(base, `/api/tasks/${task.id}`, { title: 'Safe ordinary edit' }, device.sessionToken)).status).toBe(200)
    expect(db.getTask(task.id)?.title).toBe('Safe ordinary edit')
  })
  it('rejects stale/foreign scopes and disabled dependency replacement, requires write grant for the live PIN, and preserves hidden secrets', async () => {
    expect(() => setMobileApiDeps({ ...deps, githubManager: new GitHubManager() })).toThrow('OWNER_MISMATCH')
    read = true; write = false
    await expect(call('mobile:getInfo', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); await expect(call('mobile:getPendingPin', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    write = true
    await expect(call('mobile:setAccess', [{ enabled: true }], undefined, { ...caller, engineEpoch: 'old' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(call('mobile:setAccess', [{ enabled: true }], undefined, { ...caller, origin: 'https://foreign' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const base = await enable(), device = await pair(base); sessions = false
    expect(await call('mobile:getSessions', [])).toEqual([])
    await expect(call('mobile:revokeSession', [device.sessionId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); await expect(call('mobile:revokeAllSessions', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getMobileSessions()).toHaveLength(1)
  })
  it('drains actual source work before safe metadata writes and refuses source binding edits and task/group injection', async () => {
    const base = await enable(), device = await pair(base), source = db.createTaskSource({ name: 'Owned source', plugin_id: 'github-issues', mcp_server_id: null, config: { owner: 'synthetic', repo: 'fixture' } })!
    const pending = held(), entered = held(); releases.push(pending.release)
    const raw = sync.runSourceWork(source.id, async () => { entered.release(); await pending.promise }); await entered.promise
    const admission = vi.spyOn(sync, 'runSourceMutation')
    const change = post(base, `/api/task-sources/${source.id}`, { name: 'Drained source' }, device.sessionToken)
    await vi.waitFor(() => expect(admission).toHaveBeenCalledWith(source.id, expect.any(Function)))
    expect(db.getTaskSource(source.id)?.name).toBe('Owned source'); pending.release(); await raw; expect((await change).status).toBe(200); expect(db.getTaskSource(source.id)?.name).toBe('Drained source')
    expect((await post(base, `/api/task-sources/${source.id}`, { config: { owner: 'foreign' } }, device.sessionToken)).status).toBe(400)
    expect((await post(base, '/api/tasks', { title: 'Injected Captain', role: 'captain' }, device.sessionToken)).status).toBe(400)
    const groupAgent = db.createAgent({ name: 'Actual group fixture', config: { coding_agent: 'pi' } })!
    const task = db.createTask({ title: 'Member' })!, other = db.createTask({ title: 'Other member' })!, group = db.createTaskGroup({ title: 'Actual group', agent_id: groupAgent.id, task_ids: [task.id, other.id] })
    expect((await post(base, `/api/tasks/${task.id}`, { status: 'completed' }, device.sessionToken)).status).toBe(409)
    expect(db.getTaskGroup(group.id)?.task_ids).toContain(task.id)
  })
  it('bounds legacy JSON before parsing, rejects escaped SPA assets, and canonicalizes empty URL query/hash delimiters', async () => {
    const base = await enable(), device = await pair(base), agent = db.createAgent({ name: 'Large fixture', config: {} })!
    db.db.prepare('UPDATE agents SET config=? WHERE id=?').run('x'.repeat(512 * 1024 + 1), agent.id)
    const deserialize = vi.spyOn(db, 'getAgents'); expect((await fetch(base + '/api/agents', { headers: { Authorization: `Bearer ${device.sessionToken}` } })).status).toBe(413); expect(deserialize).not.toHaveBeenCalled()
    writeFileSync(join(root, 'private-fixture.txt'), 'private-content'); symlinkSync(join(root, 'private-fixture.txt'), join(dist, 'escaped.txt'))
    const escaped = await fetch(base + '/escaped.txt'); expect(escaped.status).toBe(404); expect(await escaped.text()).not.toContain('private-content')
    expect(await call('mobile:setCustomUrl', ['https://example.test/mobile/#'])).toMatchObject({ url: expect.stringMatching(/^https:\/\/example\.test\/mobile\/pair\?code=/) })
    expect((await call('mobile:getInfo', [])).customUrl).toBe('https://example.test/mobile'); await call('mobile:clearCustomUrl', [])
  })
  it('refuses metadata writes after an exact source binding changes during drain and redacts real SyncManager result errors', async () => {
    const base = await enable(), device = await pair(base), source = db.createTaskSource({ name: 'Original source', plugin_id: 'controlled-source', mcp_server_id: null, config: {} })!
    deps.pluginRegistry!.register({ id: 'controlled-source', displayName: 'Controlled', description: 'Synthetic', icon: 'test', getConfigSchema: () => [], getActions: () => [], resolveOptions: async () => [],
      importTasks: async () => ({ imported: 0, updated: 0, errors: ['saved-private-provider-token'] }), exportUpdate: async () => {}, executeAction: async () => ({ success: false, error: 'saved-private-provider-token' }) })
    const gate = held(), entered = held(); releases.push(gate.release)
    const work = sync.runSourceWork(source.id, async () => { entered.release(); await gate.promise }); await entered.promise
    const admitted = vi.spyOn(sync, 'runSourceMutation'), changing = post(base, `/api/task-sources/${source.id}`, { name: 'Must not write' }, device.sessionToken)
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledWith(source.id, expect.any(Function)))
    db.updateTaskSource(source.id, { config: { binding: 'new-synthetic-binding' } }); gate.release(); await work
    expect((await changing).status).toBe(409); expect(db.getTaskSource(source.id)?.name).toBe('Original source')
    const response = await post(base, `/api/task-sources/${source.id}/sync`, {}, device.sessionToken), result = await response.json()
    expect(response.status).toBe(200); expect(result).toMatchObject({ source_id: source.id, imported: 0, updated: 0, errors: ['Task source sync failed.'] })
    expect(JSON.stringify(result)).not.toContain('saved-private-provider-token'); expect(db.getTaskSource(source.id)?.last_synced_at).toBeNull()
  })
  it('retains accepted provider work after HTTP abort and failed shutdown until raw completion before releasing SQLite', async () => {
    const base = await enable(), device = await pair(base), agent = db.createAgent({ name: 'Held actual owner', is_default: true, config: { coding_agent: 'pi' } })!, task = db.createTask({ title: 'Held work' })!
    db.updateTask(task.id, { agent_id: agent.id }); const started = await manager.requestSession(agent.id, task.id); if (started.status !== 'started') throw new Error('Not started')
    const gate = held(), entered = held(); releases.push(gate.release)
    adapter.sendPrompt.mockImplementationOnce(async () => { entered.release(); await gate.promise; db.updateTask(task.id, { title: 'Raw work joined' }) })
    const abort = new AbortController(), request = post(base, `/api/sessions/${started.sessionId}/send`, { message: 'Synthetic held prompt', taskId: task.id }, device.sessionToken, abort.signal).catch(() => null)
    await entered.promise; abort.abort(); await request
    await expect(closeMobileApiServer(5)).rejects.toThrow('MOBILE_API_SHUTDOWN_INCOMPLETE'); expect(db.db.open).toBe(true); expect(db.getTask(task.id)?.title).toBe('Held work')
    let done = false; const retry = closeMobileApiServer().then(() => { done = true }); await Promise.resolve(); expect(done).toBe(false)
    gate.release(); await retry; expect(db.getTask(task.id)?.title).toBe('Raw work joined'); expect(adapter.sendPrompt).toHaveBeenCalledTimes(2)
    await expect(call('mobile:setAccess', [{ enabled: true }])).rejects.toBeDefined(); expect(getMobileApiBinding()).toBeNull()
  })
})
