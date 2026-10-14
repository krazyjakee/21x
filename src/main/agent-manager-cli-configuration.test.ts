import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager, AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { SessionStatusType } from './adapters/coding-agent-adapter'
import { MAX_CONCURRENT_AGENT_SESSIONS_SETTING } from './agent-manager/admission'
vi.mock('./agent-manager/workspace-docs', async original => ({ ...await original<typeof import('./agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined) }))
function held<T>() { let finish!: (value: T) => void; const promise = new Promise<T>(resolve => { finish = resolve }); return { promise, finish } }
const finishers: Array<() => void> = []
const resources: Array<{ db: ReturnType<typeof createPortableTestDb>; manager: AgentManager; root: string }> = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish()
  for (const f of resources.splice(0)) { await f.manager.stopAllSessions(); f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  vi.useRealTimers(); vi.restoreAllMocks()
})
function fixture() {
  const db = createPortableTestDb()
  const agents = {
    claude: db.createAgent({ name: 'Claude owner', config: { coding_agent: 'claude-code' } })!,
    opencode: db.createAgent({ name: 'Default backend', config: {} })!,
    codex: db.createAgent({ name: 'Codex owner', config: { coding_agent: 'codex' } })!,
    pi: db.createAgent({ name: 'Unrelated Pi', config: { coding_agent: 'pi' } })!
  }
  const adapters = Object.fromEntries(['claude-code', 'opencode', 'codex', 'pi'].map(type => [type, Object.assign(new FakeAdapter({ status: SessionStatusType.IDLE }), { notifyConfigChanged: vi.fn(async () => {}) })]))
  const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: type => adapters[type], isCodexAppServerAdapter: () => false }
  const manager = new AgentManager(db, host)
  const task = (agentId: string) => { const row = db.createTask({ title: 'Controlled CLI lifecycle' })!; db.updateTask(row.id, { agent_id: agentId }); return row }
  const sample = task(agents.claude.id), root = dirname(dirname(db.getWorkspaceDir(sample.id)))
  resources.push({ db, manager, root })
  const warm = async (agentId = agents.claude.id) => { const row = task(agentId); const result = await manager.requestSession(agentId, row.id, undefined, true); if (result.status !== 'started') throw new Error('Fixture admission failed'); await manager.stopSession(result.sessionId, true, true); return row }
  return { db, agents, adapters, manager, task, root, warm }
}
describe('actual CLI configuration lifecycle lease', () => {
  it('projects finite affected coding backends including implicit OpenCode without decrypting agents', () => {
    const f = fixture(), getAgents = vi.spyOn(f.db, 'getAgents'), getAgent = vi.spyOn(f.db, 'getAgent')
    expect(f.manager.getCliConfigurationAffectedAgents(['claude-code'])).toEqual([f.agents.claude.id])
    expect(f.manager.getCliConfigurationAffectedAgents(['codex', 'opencode'])).toEqual([f.agents.codex.id, f.agents.opencode.id].sort())
    expect(getAgents).not.toHaveBeenCalled(); expect(getAgent).not.toHaveBeenCalled()
    for (const clis of [[], ['pi'], ['codex', 'codex']]) expect(() => f.manager.getCliConfigurationAffectedAgents(clis as never)).toThrow('valid CLI')
  })
  it.each(['working', 'idle'] as const)('refuses affected %s cached sessions without implicitly stopping them', async state => {
    const f = fixture(), row = f.task(f.agents.claude.id), effect = vi.fn(async () => 'written')
    if (state === 'working') await f.manager.requestSession(f.agents.claude.id, row.id, undefined, true)
    else { f.db.updateTask(row.id, { session_id: 'idle-native' }); await f.manager.resumeSession(f.agents.claude.id, row.id, 'idle-native') }
    await expect(f.manager.runCliConfigurationMutation(['claude-code'], effect)).rejects.toThrow('Stop affected')
    expect(effect).not.toHaveBeenCalled(); expect(f.adapters['claude-code'].destroySession).not.toHaveBeenCalled(); expect(f.manager.findSessionByTaskId(row.id)).toBeDefined()
  })
  it('refuses a cached selected adapter without a real refresh acknowledgement before filesystem effects', async () => {
    const f = fixture(); await f.warm(f.agents.codex.id)
    Reflect.deleteProperty(f.adapters.codex, 'notifyConfigChanged')
    const effect = vi.fn(async () => 'written')
    await expect(f.manager.runCliConfigurationMutation(['codex'], effect)).rejects.toThrow('cannot acknowledge configuration refresh')
    expect(effect).not.toHaveBeenCalled()
  })
  it('refuses an actual affected queued start using scalar queue ownership without a full queue getter', async () => {
    const f = fixture(); f.db.setSetting(MAX_CONCURRENT_AGENT_SESSIONS_SETTING, '1')
    const running = f.task(f.agents.pi.id); await f.manager.requestSession(f.agents.pi.id, running.id, undefined, true)
    const queued = f.task(f.agents.claude.id); expect((await f.manager.requestSession(f.agents.claude.id, queued.id)).status).toBe('queued')
    const effect = vi.fn(async () => {}), getAgent = vi.spyOn(f.db, 'getAgent'), getAgents = vi.spyOn(f.db, 'getAgents')
    await expect(f.manager.runCliConfigurationMutation(['claude-code'], effect)).rejects.toThrow('queued starts')
    expect(effect).not.toHaveBeenCalled(); expect(getAgent).not.toHaveBeenCalled(); expect(getAgents).not.toHaveBeenCalled()
    expect(f.manager.getStartRecoveryState(queued.id)?.state).toBe('queued'); expect(f.adapters.pi.destroySession).not.toHaveBeenCalled()
  })
  it('refuses unknown raw startup ownership before effects and leaves its accepted child intact', async () => {
    const f = fixture(), row = f.task(f.agents.pi.id), gate = held<string>(), entered = held<void>(), effect = vi.fn(async () => {})
    finishers.push(() => gate.finish('pending-native'))
    f.adapters.pi.createSession.mockImplementation(async () => { entered.finish(); return gate.promise })
    const start = f.manager.requestSession(f.agents.pi.id, row.id, undefined, true)
    await entered.promise
    await expect(f.manager.runCliConfigurationMutation(['claude-code'], effect)).rejects.toThrow('lifecycle work')
    expect(effect).not.toHaveBeenCalled(); expect(f.adapters.pi.destroySession).not.toHaveBeenCalled()
    gate.finish('pending-native'); await start
  })
  it('fences new admission for unrelated agents while the accepted filesystem effect remains pending', async () => {
    const f = fixture(), gate = held<string>(), entered = held<void>(); await f.warm()
    finishers.push(() => gate.finish('changed'))
    const mutation = f.manager.runCliConfigurationMutation(['claude-code'], async () => { entered.finish(); return gate.promise })
    await entered.promise
    const row = f.task(f.agents.pi.id)
    await expect(f.manager.requestSession(f.agents.pi.id, row.id)).rejects.toThrow('configuration')
    await expect(f.manager.startTask(row.id)).rejects.toThrow('configuration')
    await expect(f.manager.resumeSession(f.agents.pi.id, row.id, 'new-native')).rejects.toThrow('configuration')
    await expect(f.manager.runTaskLifecycleMutation([row.id], async () => {})).rejects.toThrow('configuration')
    expect(f.adapters.pi.createSession).not.toHaveBeenCalled(); expect(f.adapters.pi.resumeSession).not.toHaveBeenCalled()
    gate.finish('changed'); expect(await mutation).toBe('changed'); expect(f.adapters['claude-code'].notifyConfigChanged).toHaveBeenCalledOnce()
    await f.manager.requestSession(f.agents.pi.id, row.id, undefined, true)
  })
  it('retains raw SDK refresh and the database while shutdown lacks an acknowledgement', async () => {
    const f = fixture(); await f.warm()
    const gate = held<void>(), entered = held<void>(); finishers.push(() => gate.finish())
    f.adapters['claude-code'].notifyConfigChanged.mockImplementation(async () => { entered.finish(); await gate.promise })
    const effect = vi.fn(async () => 'published'), mutation = f.manager.runCliConfigurationMutation(['claude-code'], effect)
    const rejected = expect(mutation).rejects.toThrow('shutting down')
    await entered.promise
    const shutdown = f.manager.stopAllSessions(), blocked = expect(shutdown).rejects.toMatchObject({ code: 'AGENT_SHUTDOWN_INCOMPLETE' })
    await vi.advanceTimersByTimeAsync(AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS); await blocked
    expect(f.db.db.open).toBe(true); expect(effect).toHaveBeenCalledOnce()
    gate.finish(); await rejected; await f.manager.stopAllSessions()
    expect(f.adapters['claude-code'].notifyConfigChanged).toHaveBeenCalledOnce()
  })
  it('keeps a rejected SDK refresh fenced until an explicit successful file/refresh retry', async () => {
    const f = fixture(); await f.warm(); const row = f.task(f.agents.claude.id)
    f.adapters['claude-code'].notifyConfigChanged.mockRejectedValueOnce(new Error('Controlled refresh refused'))
    await expect(f.manager.runCliConfigurationMutation(['claude-code'], async () => 'published')).rejects.toThrow('refresh refused')
    await expect(f.manager.requestSession(f.agents.claude.id, row.id, undefined, true)).rejects.toThrow('could not be refreshed')
    expect(await f.manager.runCliConfigurationMutation(['claude-code'], async () => 'retry publication')).toBe('retry publication')
    expect(f.adapters['claude-code'].notifyConfigChanged).toHaveBeenCalledTimes(2)
    await f.manager.requestSession(f.agents.claude.id, row.id, undefined, true)
  })
  it('marks potentially published files failed after rejection and never invents rollback or SDK acknowledgement', async () => {
    const f = fixture(); await f.warm(); const row = f.task(f.agents.claude.id), path = join(f.root, 'controlled-cli-config.json')
    const notify = f.adapters['claude-code'].notifyConfigChanged
    await expect(f.manager.runCliConfigurationMutation(['claude-code'], async () => { writeFileSync(path, '{"published":true}'); throw new Error('Publication acknowledgement lost') })).rejects.toThrow('acknowledgement lost')
    expect(readFileSync(path, 'utf8')).toBe('{"published":true}'); expect(notify).not.toHaveBeenCalled()
    await expect(f.manager.requestSession(f.agents.claude.id, row.id, undefined, true)).rejects.toThrow('could not be refreshed')
    await f.manager.runCliConfigurationMutation(['claude-code'], async () => { writeFileSync(path, '{"published":"retry"}') })
    expect(notify).toHaveBeenCalledOnce(); await f.manager.requestSession(f.agents.claude.id, row.id, undefined, true)
  })
  it.each(['broken', '[]', 'null', '{"coding_agent":null}', '{"coding_agent":{}}', '{"coding_agent":"unknown"}', '{"coding_agent":"pi","coding_agent":"claude-code"}'])('refuses malformed metadata %s before any credential-bearing getter or effect', async config => {
    const f = fixture(); f.db.db.prepare('UPDATE agents SET config=? WHERE id=?').run(config, f.agents.claude.id)
    const getAgent = vi.spyOn(f.db, 'getAgent'), getAgents = vi.spyOn(f.db, 'getAgents'), effect = vi.fn(async () => {})
    expect(() => f.manager.getCliConfigurationAffectedAgents(['claude-code'])).toThrow('reconciliation')
    await expect(Promise.resolve().then(() => f.manager.runCliConfigurationMutation(['claude-code'], effect))).rejects.toThrow('reconciliation')
    expect(getAgent).not.toHaveBeenCalled(); expect(getAgents).not.toHaveBeenCalled(); expect(effect).not.toHaveBeenCalled()
    f.db.db.prepare('UPDATE agents SET config=? WHERE id=?').run('{"coding_agent":"claude-code"}', f.agents.claude.id)
  })
  it('checks the whole catalogue SQL byte/count bounds before JSON projection or decryption', () => {
    const f = fixture(), getAgent = vi.spyOn(f.db, 'getAgent'), getAgents = vi.spyOn(f.db, 'getAgents')
    f.db.db.prepare('UPDATE agents SET config=? WHERE id=?').run('x'.repeat(128 * 1024 + 1), f.agents.claude.id)
    expect(() => f.manager.getCliConfigurationAffectedAgents(['claude-code'])).toThrow('bounds')
    f.db.db.prepare('UPDATE agents SET config=? WHERE id=?').run('{"coding_agent":"claude-code"}', f.agents.claude.id)
    const insert = f.db.db.prepare("INSERT INTO agents(id,name,config,created_at,updated_at) VALUES (?, 'Bounded fixture', '{}', 'fixture', 'fixture')")
    for (let i = 0; i < 129; i++) insert.run(`bounded-${i}`)
    expect(() => f.manager.getCliConfigurationAffectedAgents(['claude-code'])).toThrow('bounds')
    expect(getAgent).not.toHaveBeenCalled(); expect(getAgents).not.toHaveBeenCalled()
  })
})

describe('actual managed CLI installation leases', () => {
  it('projects Pi and all package-manager effects without credential getters and bounds malformed saved metadata', () => {
    const f = fixture(); f.task(f.agents.pi.id)
    const getAgents = vi.spyOn(f.db, 'getAgents'), getAgent = vi.spyOn(f.db, 'getAgent')
    expect(f.manager.getAgentInstallationAffectedAgents('pi')).toEqual([f.agents.pi.id])
    expect(f.manager.getAgentInstallationAffectedAgents('pnpm').sort()).toEqual(Object.values(f.agents).map(agent => agent.id).sort())
    expect(f.manager.getAgentInstallationAffectedProjects('pi')).toContain(f.db.getDefaultProject()!.id)
    expect(getAgents).not.toHaveBeenCalled(); expect(getAgent).not.toHaveBeenCalled()
    f.db.db.prepare('UPDATE agents SET config=? WHERE id=?').run('x'.repeat(2 * 1024 * 1024), f.agents.pi.id)
    expect(() => f.manager.getAgentInstallationAffectedAgents('pi')).toThrow('supported bounds')
    expect(getAgents).not.toHaveBeenCalled()
  })
  it('refuses a warm binary adapter even when it can refresh configuration, without stopping unrelated sessions', async () => {
    const f = fixture(); await f.warm(f.agents.opencode.id)
    const effect = vi.fn(async () => ({ success: true }))
    await expect(f.manager.runAgentInstallationMutation('opencode', effect)).rejects.toThrow('cached affected adapter')
    expect(effect).not.toHaveBeenCalled(); expect(f.adapters.opencode.notifyConfigChanged).not.toHaveBeenCalled()
  })
  it('retains partial failed-install fences until a verified retry while allowing unrelated backends', async () => {
    const f = fixture()
    expect(await f.manager.runAgentInstallationMutation('pi', async () => ({ success: false }))).toEqual({ success: false })
    const row = f.task(f.agents.pi.id)
    await expect(f.manager.requestSession(f.agents.pi.id, row.id, undefined, true)).rejects.toThrow('Backend configuration')
    expect(f.adapters.pi.createSession).not.toHaveBeenCalled()
    expect(await f.manager.runAgentInstallationMutation('pi', async () => ({ success: true }))).toEqual({ success: true })
    expect((await f.manager.requestSession(f.agents.pi.id, row.id, undefined, true)).status).toBe('started')
  })
  it('fences unrelated admission and configuration while an actual installation acknowledgement is retained', async () => {
    const f = fixture(), gate = held<{ success: true }>(), entered = held<void>()
    finishers.push(() => gate.finish({ success: true }))
    const installation = f.manager.runAgentInstallationMutation('pi', async () => { entered.finish(); return gate.promise })
    await entered.promise
    const row = f.task(f.agents.claude.id)
    await expect(f.manager.requestSession(f.agents.claude.id, row.id)).rejects.toThrow('configuration')
    await expect(f.manager.runTaskLifecycleMutation([row.id], async () => {})).rejects.toThrow('configuration')
    await expect(f.manager.runCliConfigurationMutation(['claude-code'], async () => {})).rejects.toThrow('lifecycle work')
    gate.finish({ success: true }); expect(await installation).toEqual({ success: true })
    expect(f.adapters.pi.notifyConfigChanged).not.toHaveBeenCalled()
  })
})
