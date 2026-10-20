/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentManager } from './agent-manager'
import { CodexAppServerAdapter } from './adapters/codex-app-server-adapter'
import { SessionStatusType } from './adapters/coding-agent-adapter'

// A dead backend must stop claiming activity (#95). These tests run the REAL
// Codex adapter's child-exit handling and the REAL manager polling path end to
// end, with only the spawned process and the window faked. The heavy-module
// mocks are the ones agent-manager-activity.test.ts uses, minus the Codex
// adapter, which is the subject here.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(), copyFileSync: vi.fn(), readFileSync: vi.fn(() => ''), existsSync: vi.fn(() => false) }
})
vi.mock('fs/promises', () => ({ mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) }))
vi.mock('child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))
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

const REVALIDATE_MS = 5_000
const STALE_MS = 15_000

function fakeChild(pid: number) {
  const child = new EventEmitter() as any
  child.pid = pid
  child.stdin = Object.assign(new EventEmitter(), { writable: true, write: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

/** A manager polling one session whose adapter the test supplies. */
function managerFor(adapter: any) {
  const mgr = new AgentManager(createMockDb())
  vi.spyOn(mgr as any, 'ensurePollingCoordinator').mockImplementation(() => undefined)
  const windowSend = vi.fn()
  ;(mgr as any).mainWindow = { isDestroyed: () => false, webContents: { send: windowSend, isDestroyed: () => false } }
  const sendToRenderer = vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
  const config = { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' }
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
  ;(mgr as any).startAdapterPolling('session-1', adapter, config, session)
  const poll = async () => {
    const entry = (mgr as any).pollingEntries.get('session-1')
    if (entry) await (mgr as any).pollSingleSession(entry)
  }
  /** Heartbeats the window has received so far. */
  const heartbeats = () => windowSend.mock.calls.filter(([channel, data]) => channel === 'agent:status' && (data as any)?.heartbeat)
  const transitions = () => sendToRenderer.mock.calls.filter(([channel]) => channel === 'agent:status').map(([, data]) => (data as any).status)
  return { mgr, session, poll, windowSend, heartbeats, transitions, config }
}

describe('a dead Codex app-server stops claiming activity (#95)', () => {
  let now = 1_000_000

  beforeEach(() => {
    now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The real adapter with one real (fake-child) app-server, mid-turn. */
  async function busyCodex(pid: number) {
    const child = fakeChild(pid)
    vi.mocked(spawn).mockReturnValue(child)
    const adapter = new CodexAppServerAdapter() as any
    adapter.codexExecutablePath = '/mock/codex'
    vi.spyOn(adapter, 'startOrphanSweep').mockImplementation(() => undefined)
    const appServer = await adapter.startAppServerProcess({ agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' }, 'session-1')
    appServer.threadId = 'session-1'
    appServer.status = SessionStatusType.BUSY
    adapter.sessions.set('session-1', appServer)
    return { child, adapter }
  }

  function workingHeartbeatTimes(windowSend: ReturnType<typeof vi.fn>, times: Map<unknown, number>): number[] {
    return windowSend.mock.calls
      .filter(([channel, data]) => channel === 'agent:status' && (data as any)?.heartbeat && (data as any).status === 'working')
      .map((call) => times.get(call[1]) ?? NaN)
  }

  it('publishes no working heartbeat after SIGKILL, so the claim expires within 15 s of the last real one', async () => {
    const { child, adapter } = await busyCodex(424242)
    const { poll, windowSend, transitions, session, mgr } = managerFor(adapter)
    const times = new Map<unknown, number>()
    windowSend.mockImplementation((_channel: string, data: unknown) => { times.set(data, now) })

    // Alive and busy: the poll renews freshness, as it should.
    await poll()
    expect(workingHeartbeatTimes(windowSend, times)).toEqual([now])

    now += 1_000
    const killedAt = now
    child.emit('exit', null, 'SIGKILL')

    // The manager keeps polling on its usual cadence through +20 s.
    for (let t = 0; t < 4; t++) {
      now += REVALIDATE_MS
      await poll()
    }

    const heartbeatTimes = workingHeartbeatTimes(windowSend, times)
    expect(heartbeatTimes.every((at) => at < killedAt)).toBe(true)
    // With no renewal after the kill, the renderer's freshness deadline (last
    // heartbeat + 15 s) passes before kill + 20 s: the board cannot still say
    // Running.
    const lastWorking = Math.max(...heartbeatTimes)
    expect(lastWorking + STALE_MS).toBeLessThan(killedAt + 20_000)
    // The death is reported once, as a failure, and polling stops.
    expect(transitions()).toEqual(['error'])
    expect(session.status).toBe('error')
    expect((mgr as any).pollingEntries.has('session-1')).toBe(false)
  })

  it('treats a clean exit mid-turn the same way', async () => {
    const { child, adapter } = await busyCodex(424243)
    const { poll, heartbeats, transitions } = managerFor(adapter)
    child.emit('exit', 0, null)
    for (let t = 0; t < 4; t++) {
      now += REVALIDATE_MS
      await poll()
    }
    expect(heartbeats()).toHaveLength(0)
    expect(transitions()).toEqual(['error'])
  })

  it('never renews freshness from cached state an adapter says is dead', async () => {
    // Defence in depth for any adapter: a successful read of BUSY from memory
    // is not proof the backend answered when the adapter knows it is gone.
    let alive = true
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
      isSessionAlive: vi.fn(() => alive)
    }
    const { poll, heartbeats } = managerFor(adapter)

    await poll()
    expect(heartbeats()).toHaveLength(1)

    alive = false
    for (let t = 0; t < 4; t++) {
      now += REVALIDATE_MS
      await poll()
    }
    expect(heartbeats()).toHaveLength(1)
    expect(adapter.isSessionAlive).toHaveBeenCalledWith('session-1')
  })

  it('keeps renewing an adapter that cannot tell, exactly as before', async () => {
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY }))
    }
    const { poll, heartbeats } = managerFor(adapter)
    for (let t = 0; t < 3; t++) {
      await poll()
      now += REVALIDATE_MS
    }
    expect(heartbeats()).toHaveLength(3)
  })
})
