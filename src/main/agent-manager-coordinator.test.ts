/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AgentManager } from './agent-manager'
import { TaskStatus } from '../shared/constants'

/**
 * The Captain is a task row with role 'captain'. Its conversation must
 * outlive the runtime: a restart, or a runtime the idle reaper released, is
 * continued from the persisted session_id rather than begun again.
 */

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(), copyFileSync: vi.fn(), readFileSync: vi.fn(() => ''), existsSync: vi.fn(() => false) }
})
vi.mock('fs/promises', () => ({ mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) }))
vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  Notification: class { show = vi.fn(); on = vi.fn(); static isSupported = vi.fn(() => false) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) }
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
  waitForTaskApiServer: vi.fn()
}))
vi.mock('./secret-broker', () => ({
  registerSecretSession: vi.fn(),
  unregisterSecretSession: vi.fn(),
  getSecretBrokerPort: vi.fn(),
  writeSecretShellWrapper: vi.fn()
}))

const CAPTAIN_ID = 'mm-row'

/** An in-memory task table: the Captain row plus whatever updateTask writes. */
function makeDb(initial: Record<string, unknown>) {
  const task: Record<string, unknown> = { id: CAPTAIN_ID, title: 'Captain', role: 'captain', agent_id: null, status: TaskStatus.NotStarted, ...initial }
  const settings = new Map<string, string>()
  return {
    task,
    getTask: vi.fn((id: string) => (id === CAPTAIN_ID ? task : undefined)),
    getTasks: vi.fn(() => []),
    getSubtasks: vi.fn(() => []),
    updateTask: vi.fn((id: string, updates: Record<string, unknown>) => {
      if (id === CAPTAIN_ID) Object.assign(task, updates)
      return task
    }),
    getAgent: vi.fn((id: string) => ({ id, name: id === 'agent-2' ? 'Sol' : 'Agent', config: { coding_agent: 'codex' } })),
    getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
    getMcpServer: vi.fn(() => null),
    getMcpServers: vi.fn(() => []),
    getSecretsByIds: vi.fn(() => []),
    getSecretsWithValues: vi.fn(() => []),
    settings,
    getSetting: vi.fn((key: string) => settings.get(key)),
    setSetting: vi.fn((key: string, value: string) => { settings.set(key, value) }),
    getTranscriptParts: vi.fn(() => []),
    getSkillsByIds: vi.fn(() => [])
  }
}

function makeAdapter() {
  return {
    initialize: vi.fn(async () => undefined),
    createSession: vi.fn(async () => 'fresh-session'),
    resumeSession: vi.fn(async () => [{ id: 'msg-1', role: 'assistant', parts: [{ id: 'part-1', type: 'text', text: 'Earlier' }] }]),
    destroySession: vi.fn(async () => undefined),
    getSessionStatus: vi.fn(async () => ({ type: 'idle' })),
    getMessages: vi.fn(async () => [])
  }
}

function makeManager(db: ReturnType<typeof makeDb>, adapter: ReturnType<typeof makeAdapter>) {
  const manager = new AgentManager(db as unknown as ConstructorParameters<typeof AgentManager>[0])
  vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
  vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
  vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(undefined)
  vi.spyOn(manager as any, 'sendToRenderer').mockImplementation(() => undefined)
  vi.spyOn(manager as any, 'startAdapterPolling').mockImplementation(() => undefined)
  vi.spyOn(manager as any, 'doSendAdapterMessage').mockResolvedValue(undefined)
  return manager
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Captain session persistence', () => {
  it('stores the session id on the row and never gives it a task status', async () => {
    const db = makeDb({ session_id: null })
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)

    const sessionId = await manager.startSession('agent-1', CAPTAIN_ID, undefined, true)

    expect(sessionId).toBe('fresh-session')
    expect(adapter.createSession).toHaveBeenCalledOnce()
    expect(db.task.session_id).toBe('fresh-session')
    // A coordinator row is never "working": it is hidden, and has no lifecycle.
    expect(db.task.status).toBe(TaskStatus.NotStarted)
  })

  it('resumes the persisted session on the next start, as after a restart', async () => {
    const db = makeDb({ session_id: 'persisted-session' })
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)

    const sessionId = await manager.startSession('agent-1', CAPTAIN_ID, undefined, true)

    expect(sessionId).toBe('persisted-session')
    expect(adapter.resumeSession).toHaveBeenCalledWith('persisted-session', expect.objectContaining({ taskId: CAPTAIN_ID }))
    expect(adapter.createSession).not.toHaveBeenCalled()
    expect(db.task.session_id).toBe('persisted-session')
  })

  it('rejoins a session that is still live instead of opening a second one', async () => {
    const db = makeDb({ session_id: null })
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)

    const first = await manager.startSession('agent-1', CAPTAIN_ID, undefined, true)
    const second = await manager.startSession('agent-1', CAPTAIN_ID, undefined, true)

    expect(second).toBe(first)
    expect(adapter.createSession).toHaveBeenCalledOnce()
  })

  it('starts fresh, without a dialog, when the backend has lost the session', async () => {
    const db = makeDb({ session_id: 'gone-session' })
    const adapter = makeAdapter()
    adapter.resumeSession.mockRejectedValueOnce(new Error('No conversation found with id gone-session'))
    const manager = makeManager(db, adapter)
    const sendToRenderer = (manager as any).sendToRenderer as ReturnType<typeof vi.fn>

    const sessionId = await manager.startSession('agent-1', CAPTAIN_ID, undefined, true)

    expect(sessionId).toBe('fresh-session')
    expect(adapter.createSession).toHaveBeenCalledOnce()
    expect(db.task.session_id).toBe('fresh-session')
    const dialogs = sendToRenderer.mock.calls.filter(([channel]) => channel === 'agent:incompatible-session')
    expect(dialogs).toHaveLength(0)
  })

  it('resumes from the persisted session when a message arrives after the runtime was released', async () => {
    const db = makeDb({ session_id: 'persisted-session' })
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)

    // The renderer still holds the old id; main no longer has it in memory.
    const result = await manager.sendMessage('persisted-session', 'what next?', CAPTAIN_ID, 'agent-1')

    expect(result.newSessionId).toBe('persisted-session')
    expect(adapter.resumeSession).toHaveBeenCalledOnce()
    expect(adapter.createSession).not.toHaveBeenCalled()
    expect((manager as any).doSendAdapterMessage).toHaveBeenCalledOnce()
  })

  it('is released by the idle reaper like any task, so the next message resumes it', async () => {
    const db = makeDb({ session_id: null })
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)
    vi.spyOn(manager as any, 'hasActiveDelegationTools').mockResolvedValue(false)

    const sessionId = await manager.startSession('agent-1', CAPTAIN_ID, undefined, true)
    const session = (manager as any).sessions.get(sessionId)
    session.status = 'idle'
    session.lastActivityAt = Date.now() - 60 * 60 * 1000

    await (manager as any).reapInactiveSessions()

    expect((manager as any).sessions.has(sessionId)).toBe(false)
    // The resume anchor survives the release.
    expect(db.task.session_id).toBe('fresh-session')
    expect(db.task.status).toBe(TaskStatus.NotStarted)
  })

  it('going idle sends status only: no review, no heartbeat, no parent wake-up', async () => {
    const db = makeDb({ session_id: null })
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)
    const extract = vi.spyOn(manager as any, 'extractOutputValues').mockResolvedValue(undefined)

    const sessionId = await manager.startSession('agent-1', CAPTAIN_ID, undefined, true)
    const session = (manager as any).sessions.get(sessionId)
    await (manager as any).transitionToIdle(sessionId, session)

    expect(session.status).toBe('idle')
    expect(extract).not.toHaveBeenCalled()
    expect(db.task.status).toBe(TaskStatus.NotStarted)
  })
})

/**
 * Switching a Captain to another agent. A persisted session belongs to the
 * agent that made it: another agent cannot continue it (Claude Code accepts a
 * Codex thread id and only fails at the first message), and a runtime left
 * running on the old agent must not keep answering.
 */
describe('Captain agent switch', () => {
  it('starts fresh instead of resuming a session another agent made', async () => {
    const db = makeDb({ session_id: null })
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)
    await manager.startSession('agent-1', CAPTAIN_ID, undefined, true)
    await manager.stopSession('fresh-session', false)
    adapter.createSession.mockResolvedValueOnce('sol-session')

    const sessionId = await manager.startSession('agent-2', CAPTAIN_ID, undefined, true)

    expect(sessionId).toBe('sol-session')
    expect(adapter.resumeSession).not.toHaveBeenCalled()
    expect(db.task.session_id).toBe('sol-session')
    expect(db.settings.get(`captain_session_agent:${CAPTAIN_ID}`)).toBe('agent-2')
  })

  it('still resumes a session recorded before sessions were bound to an agent', async () => {
    const db = makeDb({ session_id: 'legacy-session' })
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)

    const sessionId = await manager.startSession('agent-2', CAPTAIN_ID, undefined, true)

    expect(sessionId).toBe('legacy-session')
    expect(db.settings.get(`captain_session_agent:${CAPTAIN_ID}`)).toBe('agent-2')
  })

  it('stops the live session on the old agent rather than rejoining it', async () => {
    const db = makeDb({ session_id: null })
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)
    await manager.startSession('agent-1', CAPTAIN_ID, undefined, true)
    adapter.createSession.mockResolvedValueOnce('sol-session')

    const sessionId = await manager.startSession('agent-2', CAPTAIN_ID, undefined, true)

    expect(sessionId).toBe('sol-session')
    expect(adapter.destroySession).toHaveBeenCalledWith('fresh-session', expect.anything())
    expect(manager.findSessionByTaskId(CAPTAIN_ID)?.session.agentId).toBe('agent-2')
  })

  it('does not resume another agent\'s session when a message arrives with no runtime', async () => {
    const db = makeDb({ session_id: 'claude-session' })
    db.settings.set(`captain_session_agent:${CAPTAIN_ID}`, 'agent-1')
    const adapter = makeAdapter()
    const manager = makeManager(db, adapter)
    adapter.createSession.mockResolvedValueOnce('sol-session')

    const result = await manager.sendMessage('', 'status?', CAPTAIN_ID, 'agent-2')

    expect(result.newSessionId).toBe('sol-session')
    expect(adapter.resumeSession).not.toHaveBeenCalled()
    expect((manager as any).doSendAdapterMessage).toHaveBeenCalledOnce()
  })

  it('reports a start that never finishes as failed, and stops it if it comes up later', async () => {
    vi.useFakeTimers()
    try {
      const db = makeDb({ session_id: null })
      const adapter = makeAdapter()
      let finish!: (id: string) => void
      const manager = makeManager(db, adapter)
      vi.spyOn(manager as any, 'startSessionNow').mockImplementationOnce(
        () => new Promise<string>((resolve) => { finish = resolve })
      )
      const stop = vi.spyOn(manager, 'stopSession').mockResolvedValue(undefined)
      const emitSystemError = vi.spyOn(manager as any, 'emitSystemError')

      const starting = manager.startSession('agent-2', CAPTAIN_ID, undefined, true)
      const failed = expect(starting).rejects.toThrow('Sol startup timed out after 90 seconds')
      await vi.advanceTimersByTimeAsync(90_000)
      await failed
      expect(emitSystemError).toHaveBeenCalledWith('', CAPTAIN_ID, expect.any(String), expect.stringContaining('Sol startup timed out'))

      finish('late-session')
      await vi.advanceTimersByTimeAsync(0)
      expect(stop).toHaveBeenCalledWith('late-session', false)
    } finally {
      vi.useRealTimers()
    }
  })
})

