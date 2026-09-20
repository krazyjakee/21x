/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentManager } from './agent-manager'
import { SessionStatusType } from './adapters/coding-agent-adapter'

// Same heavy-dependency mocks as agent-manager.test.ts, trimmed to what the
// polling path touches. Kept in its own file so the activity heartbeat (#95)
// is tested without editing the shared agent-manager suite.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(), copyFileSync: vi.fn(), readFileSync: vi.fn(() => ''), existsSync: vi.fn(() => false) }
})
vi.mock('fs/promises', () => ({ mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) }))
vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  Notification: class {
    show = vi.fn()
    on = vi.fn()
    static isSupported = vi.fn(() => false)
  },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) }
}))
vi.mock('./adapters/opencode-adapter', () => ({ OpencodeAdapter: vi.fn() }))
vi.mock('./adapters/claude-code-adapter', () => ({ ClaudeCodeAdapter: vi.fn() }))
vi.mock('./adapters/acp-adapter', () => ({ AcpAdapter: vi.fn() }))
vi.mock('./adapters/codex-app-server-adapter', () => ({ CodexAppServerAdapter: vi.fn() }))
vi.mock('./adapters/pi-adapter', () => ({ PiAdapter: vi.fn() }))
vi.mock('./task-api-server', () => ({
  getTaskApiPort: vi.fn(),
  getTaskApiToken: vi.fn(() => 't'),
  getTaskApiEnv: vi.fn(() => ({})),
  waitForTaskApiServer: vi.fn()
}))
vi.mock('./secret-broker', () => ({
  registerSecretSession: vi.fn(),
  unregisterSecretSession: vi.fn(),
  getSecretBrokerPort: vi.fn(),
  writeSecretShellWrapper: vi.fn()
}))

function createMockDb() {
  return {
    getProject: vi.fn(() => undefined),
    getProjectRepos: vi.fn(() => []),
    getProjectResources: vi.fn(() => []),
    getTask: vi.fn(() => ({ id: 'task-1', title: 'T', repos: [] })),
    getTasks: vi.fn(() => []),
    getSubtasks: vi.fn(() => []),
    getAgent: vi.fn(() => ({ id: 'agent-1', name: 'A', config: {} })),
    getAgents: vi.fn(() => [{ id: 'agent-1', name: 'A', is_default: true, config: {} }]),
    getSkills: vi.fn(() => []),
    getSkillsByIds: vi.fn(() => []),
    getSkillByName: vi.fn(() => null),
    getMcpServer: vi.fn(() => null),
    getSecretsByIds: vi.fn(() => []),
    getSetting: vi.fn(() => null),
    getWorkspaceDir: vi.fn(() => '/tmp/ws'),
    updateTask: vi.fn(),
    getMcpServers: vi.fn(() => []),
    getSecretsWithValues: vi.fn(() => []),
    getTranscriptParts: vi.fn(() => []),
    upsertTranscriptParts: vi.fn(() => ({ maxRev: 0, changedPartIds: [] }))
  } as unknown as ConstructorParameters<typeof AgentManager>[0]
}

function setup(getStatus: () => Promise<unknown>) {
  const mgr = new AgentManager(createMockDb())
  vi.spyOn(mgr as any, 'ensurePollingCoordinator').mockImplementation(() => undefined)
  const windowSend = vi.fn()
  ;(mgr as any).mainWindow = { isDestroyed: () => false, webContents: { send: windowSend, isDestroyed: () => false } }
  const sendToRenderer = vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
  const adapter = { pollMessages: vi.fn(async () => []), getStatus: vi.fn(getStatus) }
  const session = {
    agentId: 'agent-1',
    taskId: 'task-1',
    status: 'working',
    createdAt: new Date(),
    seenMessageIds: new Set<string>(),
    seenPartIds: new Set<string>(),
    partContentLengths: new Map<string, string>(),
    adapter,
    pollingStarted: true
  }
  ;(mgr as any).sessions.set('session-1', session)
  ;(mgr as any).startAdapterPolling('session-1', adapter, { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' }, session)
  const entry = (mgr as any).pollingEntries.get('session-1')
  const heartbeats = () => windowSend.mock.calls.filter(([channel, data]) => channel === 'agent:status' && (data as any)?.heartbeat)
  return { mgr, entry, session, windowSend, sendToRenderer, heartbeats, adapter }
}

describe('AgentManager activity heartbeats (#95)', () => {
  let now = 1_000_000
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a successful quiet poll publishes one heartbeat per 5 s to the window only', async () => {
    const { mgr, entry, heartbeats, sendToRenderer } = setup(async () => ({ type: SessionStatusType.BUSY }))
    await (mgr as any).pollSingleSession(entry)
    await (mgr as any).pollSingleSession(entry)
    expect(heartbeats()).toHaveLength(1)
    expect(heartbeats()[0][1]).toMatchObject({ sessionId: 'session-1', taskId: 'task-1', status: 'working', heartbeat: true, seq: expect.any(Number), epoch: expect.any(String) })
    // Never through sendToRenderer: no transition side effects, no mobile/voice listeners.
    expect(sendToRenderer.mock.calls.some(([, data]) => (data as any)?.heartbeat)).toBe(false)
    now += 5_000
    await (mgr as any).pollSingleSession(entry)
    expect(heartbeats()).toHaveLength(2)
  })

  it('a failed poll publishes nothing', async () => {
    const { mgr, entry, heartbeats } = setup(async () => {
      throw new Error('Client not found')
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await (mgr as any).pollSingleSession(entry)
    expect(heartbeats()).toHaveLength(0)
  })

  it('an idle session publishes no heartbeat', async () => {
    const { mgr, entry, heartbeats } = setup(async () => ({ type: SessionStatusType.IDLE }))
    ;(mgr as any).sessions.get('session-1').status = 'idle'
    await (mgr as any).pollSingleSession(entry)
    expect(heartbeats()).toHaveLength(0)
  })

  it('an in-flight poll cannot publish a heartbeat after Stop fenced its session generation', async () => {
    let finishStatus!: (status: unknown) => void
    const status = new Promise<unknown>((resolve) => { finishStatus = resolve })
    const { mgr, entry, session, heartbeats, adapter } = setup(() => status)
    const polling = (mgr as any).pollSingleSession(entry)
    await vi.waitFor(() => expect(adapter.getStatus).toHaveBeenCalled())

    ;(mgr as any).stoppingSessions.add(session)
    ;(mgr as any).sessions.delete('session-1')
    ;(mgr as any).stopAdapterPolling('session-1')
    finishStatus({ type: SessionStatusType.BUSY })
    await polling

    expect(heartbeats()).toHaveLength(0)
    expect((mgr as any).pollingEntries.size).toBe(0)
  })

  it('transition pushes carry the same epoch and an increasing sequence', () => {
    const mgr = new AgentManager(createMockDb())
    const sendToRenderer = vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
    vi.spyOn(mgr as any, 'scheduleStartQueueDrain').mockImplementation(() => undefined)
    ;(mgr as any).emitStatus('s', { agentId: 'a', taskId: 't' }, 'working')
    ;(mgr as any).emitStatus('s', { agentId: 'a', taskId: 't' }, 'idle')
    const [first, second] = sendToRenderer.mock.calls.map(([, data]) => data as any)
    expect(first.epoch).toBe(second.epoch)
    expect(second.seq).toBeGreaterThan(first.seq)
    expect(first.heartbeat).toBeUndefined()
  })
})
