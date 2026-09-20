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
import { SessionStatusType, type MessagePart, type SessionConfig } from './adapters/coding-agent-adapter'
import { LOST_SESSION_NOTICE } from './agent-handoff'
import { makeTask } from '../../test/helpers/task-fixtures'
import { CaptainRuntimeStore } from './sessions/runtime-store'
import { DeliveryStore } from './sessions/delivery-store'
import { recordHumanAuthorization, prepareAuthorizationDispatch, activateAuthorizationDispatch, taskAuthorization } from './authorization'

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

  it('sends a normal Captain startup prompt after clearing old authority without invalidating its own snapshot', async () => {
    const text = 'Create tasks'
    recordHumanAuthorization(db, { messageId: 'startup-human', text, at: Date.now(), source: 'project-chat', projectId: alphaId, taskId: alphaCaptain })
    activateAuthorizationDispatch(db, prepareAuthorizationDispatch(db, { key: 'startup-old', taskId: alphaCaptain, text, messageId: 'startup-human' }))
    expect(taskAuthorization(db, alphaCaptain).status).toBe('active')
    const fake = new FakeAdapter({ sessionIds: ['startup-session'] })
    const manager = newManager(fake)
    await manager.startSession(agentId, alphaCaptain, undefined, false)
    expect(fake.sendPrompt).toHaveBeenCalledOnce()
    expect(taskAuthorization(db, alphaCaptain).effectivePermissions).toEqual([])
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
    // Only the lost conversation gets the notice.
    expect(lostNotices(betaCaptain)).toHaveLength(0)
  })

  // ── B2 (#98): a lost session is never replaced blank or silently ──

  /** A user ask and an agent answer, as the durable transcript holds them. */
  function seedTranscript(taskId: string, ask: string, answer: string): void {
    db.upsertTranscriptParts(taskId, [
      { id: `${taskId}-ask`, role: 'user', content: ask, partType: 'text', receivedAt: 1 },
      { id: `${taskId}-answer`, role: 'assistant', content: answer, partType: 'text', receivedAt: 2 }
    ])
  }

  function lostNotices(taskId: string): string[] {
    return db.getTranscriptParts(taskId)
      .filter((part) => part.role === 'system' && part.content.startsWith(LOST_SESSION_NOTICE))
      .map((part) => part.content)
  }

  function promptTexts(fake: FakeAdapter): string[] {
    return fake.sendPrompt.mock.calls.map((call) => (call[1] as MessagePart[]).map((part) => ('text' in part ? part.text : '')).join(''))
  }

  /** A Captain conversation that existed before a restart, with some history. */
  async function captainBeforeRestart(): Promise<void> {
    const first = newManager(new FakeAdapter({ sessionIds: ['alpha-session'] }))
    await first.startSession(agentId, alphaCaptain, undefined, true)
    await first.stopAllSessions()
    seedTranscript(alphaCaptain, 'Plan the Friday release.', 'Release plan drafted: three tasks created.')
  }

  it.each([
    ['the backend no longer has it', new Error('No conversation found'), 'No conversation found'],
    ['resuming it fails outright', new Error('backend crashed'), 'backend crashed']
  ])('replaces a lost Captain session with a notice and a recap when %s', async (_label, failure, reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await captainBeforeRestart()

    const after = new FakeAdapter({ sessionIds: ['alpha-session-2'] })
    after.resumeSession.mockImplementation(async () => {
      throw failure
    })
    const second = newManager(after)
    expect(await second.startSession(agentId, alphaCaptain, undefined, true)).toBe('alpha-session-2')

    // Visible in the transcript, with the reason, and logged.
    const notices = lostNotices(alphaCaptain)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(reason)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Session alpha-session of task'))

    // The first message the new session gets carries the recap; the transcript keeps the user's words only.
    await second.sendMessage('alpha-session-2', 'What is left?', alphaCaptain)
    await vi.waitFor(() => expect(after.sendPrompt).toHaveBeenCalledTimes(1))
    const [firstPrompt] = promptTexts(after)
    expect(firstPrompt).toContain('## Continuing after a lost session')
    expect(firstPrompt).toContain('User: Plan the Friday release.')
    expect(firstPrompt).toContain('Previous agent: Release plan drafted: three tasks created.')
    expect(firstPrompt.endsWith('What is left?')).toBe(true)
    expect(db.getTranscriptParts(alphaCaptain).filter((part) => part.role === 'user').map((part) => part.content))
      .toEqual(['Plan the Friday release.', 'What is left?'])

    // Once only.
    await second.sendMessage('alpha-session-2', 'Thanks.', alphaCaptain)
    await vi.waitFor(() => expect(after.sendPrompt).toHaveBeenCalledTimes(2))
    expect(promptTexts(after)[1]).toBe('Thanks.')
    warn.mockRestore()
  })

  describe('task sessions', () => {
    let taskId: string

    beforeEach(() => {
      taskId = db.createTask(makeTask({ title: 'Fix the login bug' }))!.id
      db.updateTask(taskId, { agent_id: agentId })
    })

    it('seeds the replacement for a session found incompatible while polling', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const fake = new FakeAdapter({ sessionIds: ['task-session-1', 'task-session-2'] })
      const manager = newManager(fake)
      expect(await manager.startSession(agentId, taskId)).toBe('task-session-1')
      seedTranscript(taskId, 'The login button does nothing.', 'Found it: the handler is never bound.')

      fake.setStatus(SessionStatusType.ERROR, 'INCOMPATIBLE_SESSION_ID: session expired')
      fake.signalData('task-session-1')
      await vi.waitFor(() => expect(db.getTask(taskId)?.session_id).toBeNull())
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Session task-session-1 of task'))

      // The user chooses to start a new session.
      fake.setStatus(SessionStatusType.BUSY)
      expect(await manager.startSession(agentId, taskId)).toBe('task-session-2')
      expect(lostNotices(taskId)).toEqual([expect.stringContaining('session expired')])
      const prompts = promptTexts(fake)
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).not.toContain('Continuing after a lost session')
      expect(prompts[1]).toContain('## Continuing after a lost session')
      expect(prompts[1]).toContain('Previous agent: Found it: the handler is never bound.')
      // The recap leaves out the generated first prompt of the lost session.
      expect(prompts[1].split('## Continuing after a lost session')[1].split('---')[0]).not.toContain('IMPORTANT: First, read')
      warn.mockRestore()
    })

    it('seeds the replacement when a message finds the persisted session gone', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      db.updateTask(taskId, { session_id: 'task-session-old', status: 'agent_working' as any })
      seedTranscript(taskId, 'The login button does nothing.', 'Found it: the handler is never bound.')

      const fake = new FakeAdapter({ sessionIds: ['task-session-new'] })
      fake.resumeSession.mockImplementation(async () => {
        throw new Error('SESSION_FILE_NOT_FOUND')
      })
      const manager = newManager(fake)

      const { newSessionId } = await manager.sendMessage('task-session-old', 'Please bind it.', taskId)
      expect(newSessionId).toBe('task-session-new')
      expect(lostNotices(taskId)).toEqual([expect.stringContaining('SESSION_FILE_NOT_FOUND')])
      await vi.waitFor(() => expect(fake.sendPrompt).toHaveBeenCalledTimes(1))
      const [prompt] = promptTexts(fake)
      expect(prompt).toContain('## Continuing after a lost session')
      expect(prompt).toContain('User: The login button does nothing.')
      expect(prompt.endsWith('Please bind it.')).toBe(true)
      vi.mocked(console.error).mockRestore()
      warn.mockRestore()
    })
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
    expect(fake.destroySession).toHaveBeenCalledWith('good-session', expect.any(Object))
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
      probeOk: true
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
