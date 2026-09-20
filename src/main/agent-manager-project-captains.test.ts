/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentManager } from './agent-manager'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { seedCaptainTasks } from './database/seed'
import { CAPTAIN_MEMORY_FILE } from './agent-manager/captain-context'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import type { DatabaseManager } from './database'
import type { SessionConfig } from './adapters/coding-agent-adapter'
import { CaptainRuntimeStore } from './sessions/runtime-store'
import { DeliveryStore } from './sessions/delivery-store'

// Mock heavy dependencies to avoid loading electron/native modules. The
// filesystem is real: sessions get workspaces under a temp dir, so the
// memory file the Captain keeps there is read for real.
vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  Notification: class { show = vi.fn(); on = vi.fn(); static isSupported = vi.fn(() => false) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) },
}))
vi.mock('./adapters/opencode-adapter', () => ({ OpencodeAdapter: vi.fn() }))
vi.mock('./adapters/claude-code-adapter', () => ({ ClaudeCodeAdapter: vi.fn() }))
vi.mock('./adapters/acp-adapter', () => ({ AcpAdapter: vi.fn() }))
vi.mock('./adapters/codex-app-server-adapter', () => ({ CodexAppServerAdapter: vi.fn() }))
vi.mock('./adapters/pi-adapter', () => ({ PiAdapter: vi.fn() }))
vi.mock('./task-api-server', () => ({
  getTaskApiPort: vi.fn(),
  getTaskApiToken: vi.fn(() => 'test-task-api-token'),
  getTaskApiEnv: vi.fn(() => ({})),
  waitForTaskApiServer: vi.fn(),
}))
vi.mock('./secret-broker', () => ({
  registerSecretSession: vi.fn(),
  unregisterSecretSession: vi.fn(),
  getSecretBrokerPort: vi.fn(),
  writeSecretShellWrapper: vi.fn(),
}))

import { ClaudeCodeAdapter } from './adapters/claude-code-adapter'

/** The next AgentManager resolves every claude-code agent to this fake, like a fresh backend after a restart. */
function installFakeAdapter(fake: FakeAdapter): void {
  ;(ClaudeCodeAdapter as unknown as Mock).mockImplementation(function () {
    return fake
  })
}

/**
 * One persistent Captain per project (#55), driven through the public
 * session API against a real (in-memory) database and the fake adapter.
 *
 * Two projects have their own Captain rows; each conversation gets the
 * project's own context and memory, and after a "restart" (a new AgentManager
 * over the same database with a new adapter) each is resumed by the session
 * id its row remembers, never the other project's.
 */
describe('per-project Captain conversations', () => {
  let db: DatabaseManager
  let root: string
  let agentId: string
  let alphaId: string
  let betaId: string
  let alphaCaptain: string
  let betaCaptain: string
  const managers: AgentManager[] = []

  function newManager(fake: FakeAdapter): AgentManager {
    installFakeAdapter(fake)
    const manager = new AgentManager(db)
    managers.push(manager)
    return manager
  }

  function configOf(call: unknown[] | undefined, index: number): SessionConfig {
    return call?.[index] as SessionConfig
  }

  beforeEach(() => {
    ;({ db } = createTestDb())
    root = mkdtempSync(join(tmpdir(), 'captain-restart-'))
    db.getWorkspaceDir = vi.fn((taskId: string) => {
      const dir = join(root, taskId)
      mkdirSync(dir, { recursive: true })
      return dir
    })
    seedCaptainTasks(db.db)
    agentId = db.createAgent({ name: 'Claude', is_default: true, config: { coding_agent: 'claude-code' } as any })!.id

    const alpha = db.createProject({ name: 'Alpha', description: 'The alpha brief.', git_org: 'acme' })!
    db.addProjectRepo(alpha.id, { name: 'alpha-api', default_branch: 'main' })
    db.addProjectResource(alpha.id, { label: 'Alpha runbook', url: 'https://wiki/alpha' })
    const beta = db.createProject({ name: 'Beta', description: 'The beta brief.' })!
    db.addProjectRepo(beta.id, { name: 'beta-web', org: 'other', default_branch: 'trunk' })
    alphaId = alpha.id
    betaId = beta.id
    alphaCaptain = db.getCoordinatorTask(alphaId)!.id
    betaCaptain = db.getCoordinatorTask(betaId)!.id
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const manager of managers.splice(0)) await manager.stopAllSessions()
    ;(ClaudeCodeAdapter as unknown as Mock).mockReset()
    rmSync(root, { recursive: true, force: true })
  })

  it('gives each project its own Captain row, distinct from the Default one', () => {
    expect(new Set([alphaCaptain, betaCaptain, db.getCoordinatorTask(DEFAULT_PROJECT_ID)!.id]).size).toBe(3)
    expect(db.getCoordinatorTasks().map((row) => row.project_id).sort()).toEqual([alphaId, betaId, DEFAULT_PROJECT_ID].sort())
  })

  it('starts each Captain with its own project context and memory, in its own workspace with no worktree', async () => {
    writeFileSync(join(db.getWorkspaceDir(alphaCaptain), CAPTAIN_MEMORY_FILE), '- Alpha decision: ship on Fridays.')
    const fake = new FakeAdapter({ sessionIds: ['alpha-session', 'beta-session'] })
    const manager = newManager(fake)

    const alphaSession = await manager.startSession(agentId, alphaCaptain, undefined, true)
    const betaSession = await manager.startSession(agentId, betaCaptain, undefined, true)
    expect(alphaSession).toBe('alpha-session')
    expect(betaSession).toBe('beta-session')

    const alphaConfig = configOf(fake.createSession.mock.calls[0], 0)
    const betaConfig = configOf(fake.createSession.mock.calls[1], 0)
    expect(alphaConfig.workspaceDir).toBe(join(root, alphaCaptain))
    expect(betaConfig.workspaceDir).toBe(join(root, betaCaptain))

    // Alpha knows Alpha: name, brief, repo with branch, resource, memory — and nothing of Beta.
    expect(alphaConfig.systemPrompt).toContain('**Alpha**')
    expect(alphaConfig.systemPrompt).toContain('The alpha brief.')
    expect(alphaConfig.systemPrompt).toContain('acme/alpha-api (github, default branch `main`)')
    expect(alphaConfig.systemPrompt).toContain('Alpha runbook — https://wiki/alpha')
    expect(alphaConfig.systemPrompt).toContain('- Alpha decision: ship on Fridays.')
    expect(alphaConfig.systemPrompt).not.toContain('Beta')

    expect(betaConfig.systemPrompt).toContain('**Beta**')
    expect(betaConfig.systemPrompt).toContain('other/beta-web (github, default branch `trunk`)')
    expect(betaConfig.systemPrompt).toContain('_The file does not exist yet.')
    expect(betaConfig.systemPrompt).not.toContain('Alpha')

    // The rows remember their sessions; neither row got a task status.
    expect(db.getTask(alphaCaptain)?.session_id).toBe('alpha-session')
    expect(db.getTask(betaCaptain)?.session_id).toBe('beta-session')
    expect(db.getTask(alphaCaptain)?.status).toBe('not_started')
  })

  it('resumes both conversations after a restart, each by its own session id', async () => {
    const before = new FakeAdapter({ sessionIds: ['alpha-session', 'beta-session'] })
    const first = newManager(before)
    await first.startSession(agentId, alphaCaptain, undefined, true)
    await first.startSession(agentId, betaCaptain, undefined, true)
    // Quit: runtimes stop, the rows keep their session ids.
    await first.stopAllSessions()
    expect(db.getTask(alphaCaptain)?.session_id).toBe('alpha-session')
    expect(db.getTask(betaCaptain)?.session_id).toBe('beta-session')

    // Restart: a new manager and a new backend over the same database.
    const after = new FakeAdapter({ sessionIds: ['would-be-new-1', 'would-be-new-2'] })
    const second = newManager(after)
    // A project edit made while the app was closed reaches the resumed conversation.
    db.updateProject(alphaId, { description: 'The alpha brief, revised.' })
    const legacy = ['Master', 'mind'].join('')
    const workspace = db.getWorkspaceDir(alphaCaptain)
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      writeFileSync(join(workspace, name), `Only the project ${legacy} may call report_to_commander.`)
    }
    const memory = `# Alpha — ${legacy} memory`
    writeFileSync(join(workspace, CAPTAIN_MEMORY_FILE), memory)
    after.resumeSession.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 'alpha-session') return []
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        expect(readFileSync(join(workspace, name), 'utf-8')).not.toContain(legacy)
      }
      return []
    })

    expect(await second.startSession(agentId, betaCaptain, undefined, true)).toBe('beta-session')
    expect(await second.startSession(agentId, alphaCaptain, undefined, true)).toBe('alpha-session')

    expect(after.createSession).not.toHaveBeenCalled()
    expect(after.resumeSession).toHaveBeenCalledTimes(2)
    const [betaResume, alphaResume] = after.resumeSession.mock.calls
    expect(betaResume[0]).toBe('beta-session')
    expect(configOf(betaResume, 1).workspaceDir).toBe(join(root, betaCaptain))
    expect(configOf(betaResume, 1).systemPrompt).toContain('**Beta**')
    expect(alphaResume[0]).toBe('alpha-session')
    expect(configOf(alphaResume, 1).systemPrompt).toContain('The alpha brief, revised.')
    expect(configOf(alphaResume, 1).systemPrompt).not.toContain('Beta')
    expect(configOf(alphaResume, 1).systemPrompt).toContain('# Alpha — Captain memory')
    expect(configOf(alphaResume, 1).systemPrompt).not.toContain(legacy)
    expect(readFileSync(join(workspace, CAPTAIN_MEMORY_FILE), 'utf-8')).toBe(memory)

    // The same conversation is rejoined, not started twice.
    expect(await second.startSession(agentId, alphaCaptain, undefined, true)).toBe('alpha-session')
    expect(after.resumeSession).toHaveBeenCalledTimes(2)
  })

  it('opens a fresh conversation when the backend no longer has the old one, without touching the other project', async () => {
    const before = new FakeAdapter({ sessionIds: ['alpha-session', 'beta-session'] })
    const first = newManager(before)
    await first.startSession(agentId, alphaCaptain, undefined, true)
    await first.startSession(agentId, betaCaptain, undefined, true)
    await first.stopAllSessions()

    const after = new FakeAdapter({ sessionIds: ['alpha-session-2'] })
    after.resumeSession.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'alpha-session') throw new Error('No conversation found')
      return []
    })
    const second = newManager(after)

    expect(await second.startSession(agentId, alphaCaptain, undefined, true)).toBe('alpha-session-2')
    expect(db.getTask(alphaCaptain)?.session_id).toBe('alpha-session-2')
    expect(configOf(after.createSession.mock.calls[0], 0).systemPrompt).toContain('**Alpha**')

    expect(await second.startSession(agentId, betaCaptain, undefined, true)).toBe('beta-session')
    expect(db.getTask(betaCaptain)?.session_id).toBe('beta-session')
  })

  it('keeps the last-known-good Captain when the candidate health probe fails, then commits a manual retry', async () => {
    const candidate = db.createAgent({ name: 'Sol', config: { coding_agent: 'claude-code' } as any })!
    const fake = new FakeAdapter({ sessionIds: ['good-session', 'candidate-session'] })
    const manager = newManager(fake)
    await manager.startSession(agentId, alphaCaptain, undefined, true)
    fake.checkHealth.mockResolvedValueOnce({ available: false, reason: 'protocol probe refused connection' })

    const failed = await manager.switchCaptainAgent(alphaId, candidate.id)

    expect(failed).toMatchObject({
      phase: 'rolled_back',
      agentId,
      candidateAgentId: candidate.id,
      lastGoodAgentId: agentId,
      errorCode: 'STARTUP_FAILED',
      errorDetail: 'protocol probe refused connection'
    })
    expect(db.getProject(alphaId)?.captain_agent_id).toBeNull()
    expect(manager.findSessionByTaskId(alphaCaptain)).toMatchObject({ sessionId: 'good-session', session: { agentId } })

    const retried = await manager.retryCaptainSwitch(alphaId)
    expect(retried).toMatchObject({
      phase: 'healthy',
      agentId: candidate.id,
      sessionId: 'candidate-session',
      candidateAgentId: null,
      lastGoodAgentId: candidate.id,
      attemptCount: 3
    })
    expect(db.getProject(alphaId)?.captain_agent_id).toBe(candidate.id)
    await vi.waitFor(() => expect(fake.destroySession).toHaveBeenCalledWith('good-session', expect.any(Object)))
  })


  it('bounds workspace preparation and never starts a candidate after the timeout', async () => {
    const candidate = db.createAgent({ name: 'Candidate' })!
    const fake = new FakeAdapter({ sessionIds: ['good'] })
    const manager = newManager(fake)
    await manager.startSession(agentId, alphaCaptain, undefined, true)
    let release!: (path: string) => void
    vi.spyOn(manager as any, 'setupWorktreeIfNeeded').mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const switching = manager.switchCaptainAgent(alphaId, candidate.id)
    await vi.advanceTimersByTimeAsync(90_001)
    expect(await switching).toMatchObject({ phase: 'rolled_back', agentId, errorCode: 'STARTUP_TIMEOUT' })
    release(db.getWorkspaceDir(alphaCaptain))
    await Promise.resolve()
    expect(fake.createSession).toHaveBeenCalledTimes(1)
    expect(db.getProject(alphaId)?.captain_agent_id).toBeNull()
  })

  it('manual rollback invalidates an in-flight candidate before it can commit', async () => {
    const candidate = db.createAgent({ name: 'Candidate', config: { coding_agent: 'claude-code' } as any })!
    const fake = new FakeAdapter({ sessionIds: ['good'] })
    const manager = newManager(fake)
    await manager.startSession(agentId, alphaCaptain, undefined, true)
    let release!: (path: string) => void
    vi.spyOn(manager as any, 'setupWorktreeIfNeeded').mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const switching = manager.switchCaptainAgent(alphaId, candidate.id)
    const rollback = manager.rollbackCaptainSwitch(alphaId)
    release(db.getWorkspaceDir(alphaCaptain))
    expect(await switching).toMatchObject({ generation: rollback.generation, phase: 'rolled_back', agentId })
    expect(db.getProject(alphaId)?.captain_agent_id).toBe(agentId)
    expect(fake.createSession).toHaveBeenCalledTimes(1)
    expect(manager.findSessionByTaskId(alphaCaptain)?.sessionId).toBe('good')
  })

  it('coalesces duplicate switches and keeps a healthy shared adapter alive on probe failure', async () => {
    const candidate = db.createAgent({ name: 'Candidate', config: { coding_agent: 'claude-code' } as any })!
    const fake = new FakeAdapter({ sessionIds: ['good'] })
    const stopServer = vi.fn(async () => {})
    Object.assign(fake, { stopServer })
    const manager = newManager(fake)
    await manager.startSession(agentId, alphaCaptain, undefined, true)
    fake.checkHealth.mockResolvedValueOnce({ available: false, reason: 'protocol unhealthy' })
    const first = manager.switchCaptainAgent(alphaId, candidate.id)
    const duplicate = manager.switchCaptainAgent(alphaId, candidate.id)
    expect(first).toBe(duplicate)
    expect(await first).toMatchObject({ phase: 'rolled_back' })
    expect(stopServer).not.toHaveBeenCalled()
  })

  it('repairs a crashed switch even before its old process deadline expires', async () => {
    const candidate = db.createAgent({ name: 'Candidate' })!
    new CaptainRuntimeStore(db).begin({ ownerId: alphaCaptain, projectId: alphaId,
      agentId: candidate.id, lastGoodAgentId: agentId, deadlineAt: Date.now() + 90_000 })
    const fake = new FakeAdapter({ sessionIds: ['recovered'] })
    const manager = newManager(fake)
    await manager.reconcileStartup()
    expect(manager.getCaptainRuntime(alphaId)).toMatchObject({ phase: 'rolled_back', agentId, probeOk: true })
    expect(manager.findSessionByTaskId(alphaCaptain)?.sessionId).toBe('recovered')
  })





  it('persists inferred ownership when a caller supplies only a session ID', async () => {
    const first = newManager(new FakeAdapter({ sessionIds: ['saved-session'] }))
    await first.startSession(agentId, alphaCaptain, undefined, true)
    vi.spyOn(first as any, 'sendMessageNow').mockRejectedValueOnce(new Error('interrupted'))
    await expect(first.sendMessage('saved-session', 'Keep me', undefined, undefined, undefined, undefined, 'session-only')).rejects.toThrow('interrupted')
    const row = new DeliveryStore(db).getByKey('session-only')!
    expect(JSON.parse(row.payload)).toMatchObject({ taskId: alphaCaptain, agentId })
    await first.stopAllSessions()
    const fake = new FakeAdapter()
    const second = newManager(fake)
    await second.reconcileStartup()
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1)
    expect(new DeliveryStore(db).get(row.id)?.state).toBe('acknowledged')
  })

  it('terminates a hung handoff visibly without replaying uncertain backend acceptance', async () => {
    const manager = newManager(new FakeAdapter())
    let finish!: (result: object) => void
    const send = vi.spyOn(manager as any, 'sendMessageNow').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const pending = manager.sendMessage('', 'retained', alphaCaptain, agentId, undefined, undefined, 'hung-handoff')
    const failed = expect(pending).rejects.toThrow('Message handoff timed out')
    await vi.advanceTimersByTimeAsync(180_001)
    await failed
    expect(new DeliveryStore(db).getByKey('hung-handoff')).toMatchObject({ state: 'timed_out' })
    finish({})
    await Promise.resolve()
    await expect(manager.sendMessage('', 'retained', alphaCaptain, agentId, undefined, undefined, 'hung-handoff')).rejects.toThrow('acceptance is unknown')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('makes repeated message delivery failures terminal after five attempts', async () => {
    const manager = newManager(new FakeAdapter())
    const send = vi.spyOn(manager as any, 'sendMessageNow').mockRejectedValue(new Error('backend unavailable'))
    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(manager.sendMessage('', 'retained', alphaCaptain, agentId, undefined, undefined, 'bounded-retry')).rejects.toThrow('backend unavailable')
    }
    expect(send).toHaveBeenCalledTimes(5)
    expect(new DeliveryStore(db).getByKey('bounded-retry')).toMatchObject({ state: 'failed', attemptCount: 5 })
  })

  it('starts one Captain for concurrent durable messages without a prewarm owner', async () => {
    const fake = new FakeAdapter({ sessionIds: ['one-start'] })
    const manager = newManager(fake)
    await Promise.all([
      manager.sendMessage('', 'first', alphaCaptain, agentId, undefined, undefined, 'first-delivery'),
      manager.sendMessage('', 'second', alphaCaptain, agentId, undefined, undefined, 'second-delivery')
    ])
    expect(fake.createSession).toHaveBeenCalledTimes(1)
    expect(fake.sendPrompt).toHaveBeenCalledTimes(2)
    expect(fake.sendPrompt.mock.calls.map((call) => call[0])).toEqual(['one-start', 'one-start'])
  })

  it('ignores status from the old Captain after committing its replacement', async () => {
    const candidate = db.createAgent({ name: 'Candidate', config: { coding_agent: 'claude-code' } as any })!
    const fake = new FakeAdapter({ sessionIds: ['old', 'new'] })
    const manager = newManager(fake)
    await manager.startSession(agentId, alphaCaptain, undefined, true)
    const emitted = vi.spyOn(manager as any, 'sendToRenderer')
    await manager.switchCaptainAgent(alphaId, candidate.id)
    await vi.waitFor(() => expect(fake.destroySession).toHaveBeenCalledWith('old', expect.any(Object)))
    expect(manager.findSessionByTaskId(alphaCaptain)?.sessionId).toBe('new')
    const statuses = emitted.mock.calls.filter((call) => call[0] === 'agent:status')
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.every((call) => (call[1] as { sessionId: string }).sessionId === 'new')).toBe(true)
  })

  it('rejects sending through another project session without leaking the message', async () => {
    const fake = new FakeAdapter({ sessionIds: ['alpha'] })
    const manager = newManager(fake)
    await manager.startSession(agentId, alphaCaptain, undefined, true)
    await expect(manager.sendMessage('alpha', 'Private beta message', betaCaptain, agentId)).rejects.toThrow('different task')
    expect(fake.sendPrompt).not.toHaveBeenCalled()
  })

  it('rolls back without changing selection when the candidate process exits during session startup', async () => {
    const candidate = db.createAgent({ name: 'Sol', config: { coding_agent: 'claude-code' } as any })!
    const fake = new FakeAdapter({ sessionIds: ['good-session'] })
    const manager = newManager(fake)
    await manager.startSession(agentId, alphaCaptain, undefined, true)
    fake.createSession.mockRejectedValueOnce(new Error('agent process exited with code 17'))

    const result = await manager.switchCaptainAgent(alphaId, candidate.id)

    expect(result).toMatchObject({
      phase: 'rolled_back',
      agentId,
      candidateAgentId: candidate.id,
      errorDetail: 'agent process exited with code 17'
    })
    expect(db.getProject(alphaId)?.captain_agent_id).toBeNull()
    expect(manager.findSessionByTaskId(alphaCaptain)?.sessionId).toBe('good-session')
  })

  it('rejects a process-alive candidate whose session readiness probe is unhealthy', async () => {
    const candidate = db.createAgent({ name: 'Sol', config: { coding_agent: 'claude-code' } as any })!
    const fake = new FakeAdapter({ sessionIds: ['good-session', 'unhealthy-session'] })
    const manager = newManager(fake)
    await manager.startSession(agentId, alphaCaptain, undefined, true)
    fake.setStatus('error' as any, 'backend protocol is not ready')

    const result = await manager.switchCaptainAgent(alphaId, candidate.id)

    expect(result).toMatchObject({
      phase: 'rolled_back',
      agentId,
      candidateAgentId: candidate.id,
      errorDetail: 'backend protocol is not ready',
      probeOk: null
    })
    expect(fake.destroySession).toHaveBeenCalledWith('unhealthy-session', expect.any(Object))
    expect(manager.findSessionByTaskId(alphaCaptain)?.sessionId).toBe('good-session')
  })

  it('reconciles an expired switch after app restart and probes the restored Captain', async () => {
    const candidate = db.createAgent({ name: 'Sol', config: { coding_agent: 'claude-code' } as any })!
    const before = new FakeAdapter({ sessionIds: ['good-session'] })
    const first = newManager(before)
    await first.startSession(agentId, alphaCaptain, undefined, true)
    await first.stopAllSessions()

    // Simulate a crash after selection/start intent was persisted but before
    // the candidate became ready or the transaction committed.
    db.updateProject(alphaId, { captain_agent_id: candidate.id })
    new CaptainRuntimeStore(db).begin({
      ownerId: alphaCaptain,
      projectId: alphaId,
      agentId: candidate.id,
      lastGoodAgentId: agentId,
      deadlineAt: Date.now() - 1
    })

    const after = new FakeAdapter({ sessionIds: ['should-not-create'] })
    const second = newManager(after)
    await second.reconcileStartup()

    expect(db.getProject(alphaId)?.captain_agent_id).toBe(agentId)
    expect(after.resumeSession).toHaveBeenCalledWith('good-session', expect.objectContaining({ agentId, taskId: alphaCaptain }))
    expect(after.checkHealth).toHaveBeenCalled()
    expect(after.getStatus).toHaveBeenCalledWith('good-session', expect.any(Object))
    expect(second.findSessionByTaskId(alphaCaptain)?.sessionId).toBe('good-session')
    expect(second.getCaptainRuntime(alphaId)).toMatchObject({
      phase: 'rolled_back',
      agentId,
      candidateAgentId: candidate.id,
      sessionId: 'good-session',
      probeOk: true,
      errorCode: 'STARTUP_TIMEOUT'
    })
  })

  it('recovers a queued image message after restart and deduplicates a retry with the same delivery ID', async () => {
    const image = { id: 'pasted-image', filename: 'shot.png', size: 8, mime_type: 'image/png', added_at: new Date().toISOString() }
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const source = join(root, 'stored-images')
    mkdirSync(source)
    db.getAttachmentsDir = vi.fn(() => source)
    writeFileSync(join(source, `${image.id}-${image.filename}`), bytes)
    db.updateTask(alphaCaptain, { attachments: [image] })
    const first = newManager(new FakeAdapter())
    // The delivery is durable before startup; losing the process now leaves
    // its original image references in the outbox for the next manager.
    vi.spyOn(first as any, 'sendMessageNow').mockRejectedValueOnce(new Error('startup interrupted'))
    await expect(first.sendMessage('', '', alphaCaptain, agentId, [image], undefined, 'captain-drawer:image-retry')).rejects.toThrow('startup interrupted')
    const store = new DeliveryStore(db)
    const queued = store.getByKey('captain-drawer:image-retry')!
    expect(queued.state).toBe('pending')
    expect(JSON.parse(queued.payload).attachments).toEqual([image])
    await first.stopAllSessions()

    const fake = new FakeAdapter({ sessionIds: ['recovered-image-session'] })
    const second = newManager(fake)
    await second.reconcileStartup()
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1)
    expect(fake.sendPrompt).toHaveBeenCalledWith('recovered-image-session', [expect.objectContaining({
      text: expect.stringContaining('attachments/shot.png')
    })], expect.any(Object))
    expect(readFileSync(join(db.getWorkspaceDir(alphaCaptain), 'attachments', image.filename))).toEqual(bytes)
    expect(store.get(queued.id)?.state).toBe('acknowledged')

    // The renderer may retry with stale/empty options after reconnecting;
    // the acknowledged delivery must not dispatch or replace its attachments.
    await second.sendMessage('', 'changed retry', alphaCaptain, agentId, [], undefined, 'captain-drawer:image-retry')
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1)
    expect(JSON.parse(store.get(queued.id)!.payload).attachments).toEqual([image])
  })

  it('acknowledges a crash-after-provider-handoff message without visibly sending it again', async () => {
    const store = new DeliveryStore(db)
    const row = store.enqueue({
      idempotencyKey: 'renderer:crash-after-send',
      kind: 'agent_message',
      taskId: alphaCaptain,
      agentId,
      payload: JSON.stringify({
        sessionId: 'good-session',
        message: 'Do not duplicate this',
        taskId: alphaCaptain,
        agentId,
        attachments: []
      })
    }).record
    store.claim(row.id, 'process-before-crash', 1_000)
    store.accept(row.id, 'process-before-crash', 'provider-turn-1')

    const manager = newManager(new FakeAdapter())
    const send = vi.spyOn(manager as any, 'sendMessageNow')
    await manager.reconcileStartup()

    expect(send).not.toHaveBeenCalled()
    expect(store.get(row.id)).toMatchObject({ state: 'acknowledged', destinationId: 'provider-turn-1' })
  })
})
