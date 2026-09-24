import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  clipboard: { write: vi.fn(async () => undefined), writeText: vi.fn(async () => undefined) },
  ClipboardItem: class {
    constructor(public readonly items: Record<string, unknown>) {}
  },
  nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })) },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
  app: { isPackaged: false }
}))

const { mockChildKill, mockSpawn } = vi.hoisted(() => {
  const kill = vi.fn()
  const spawn = vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { writable: true, write: vi.fn() },
    on: vi.fn(),
    kill,
    pid: 4242
  }))
  return { mockChildKill: kill, mockSpawn: spawn }
})

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn()
}))

import { ipcMain } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { registerIpcHandlers } from './ipc-handlers'
import type { IpcDeps } from './ipc/deps'
import { setTaskSchedulers } from './task-updates'

/** Registers every handler with empty stand-ins for anything the test does not supply. */
function register(overrides: Partial<Record<keyof IpcDeps, unknown>> = {}): void {
  const agentManager = {
    startTask: vi.fn().mockResolvedValue({ action: 'task_started', sessionId: 'session-1' }),
    stopByTaskId: vi.fn().mockResolvedValue({ sessionId: null }),
    hasTaskStartOwnership: vi.fn().mockReturnValue(false),
    reconcileTaskRuntime: vi.fn(),
    ...(overrides.agentManager as Record<string, unknown> | undefined)
  }
  registerIpcHandlers({
    db: {},
    githubManager: {},
    worktreeManager: {},
    syncManager: {},
    pluginRegistry: {},
    ...overrides,
    agentManager
  } as unknown as IpcDeps)
}

describe('registerIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the expected number of IPC handlers', () => {
    register()

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
    expect(handleCalls.length).toBeGreaterThanOrEqual(30)

    const channels = handleCalls.map((call: unknown[]) => call[0])
    expect(channels).toContain('db:getTasks')
    expect(channels).toContain('db:createTask')
    expect(channels).toContain('db:updateTask')
    expect(channels).toContain('db:deleteTask')
    expect(channels).toContain('agent:getAll')
    expect(channels).toContain('agentSession:start')
    expect(channels).toContain('agentSession:startTask')
    expect(channels).toContain('mcp:getAll')
    expect(channels).toContain('settings:get')
    expect(channels).toContain('skills:getAll')
    expect(channels).toContain('taskSource:sync')
    expect(channels).toContain('plugin:list')
    expect(channels).toContain('artifacts:scan')
    expect(channels).toContain('artifacts:read')
    expect(channels).toContain('voice:startTurn')
    expect(channels).toContain('voice:pushAudio')
    expect(channels).toContain('voice:confirm')
    expect(channels).toContain('voice:selectModel')
  })

  it('delegates high-level task starts to the agent manager', async () => {
    const outcome = { action: 'task_started', sessionId: 'session-1', startedTaskId: 'task-1' }
    const startTask = vi.fn().mockResolvedValue(outcome)
    register({ agentManager: { startTask } })

    const handlers = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const handler = handlers.filter(([channel]) => channel === 'agentSession:startTask').pop()?.[1]

    await expect(handler!({}, 'task-1')).resolves.toEqual(outcome)
    expect(startTask).toHaveBeenCalledWith('task-1', { resumeManualStop: true, explicitUserStart: true })
  })

  it('keeps a newly created source-less task local', async () => {
    const task = { id: 'task-1', title: 'Instant task', status: 'not_started', source_id: null }
    register({
      db: {
        createTask: vi.fn(() => task),
        getTask: vi.fn(() => task)
      }
    })

    const handlers = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const createTask = handlers.filter(([channel]) => channel === 'db:createTask').pop()?.[1]
    const sender = { send: vi.fn() }

    await expect(createTask!({ sender }, task)).resolves.toBe(task)
    expect(sender.send).toHaveBeenCalledWith('task:created', { task })
  })

  it('never returns raw API keys to the renderer and ignores the marker on save', async () => {
    const settings: Record<string, string> = { anthropic_api_key: 'sk-ant-raw', openai_api_key: '', theme: 'dark' }
    const setSetting = vi.fn()
    register({
      db: {
        getSetting: (key: string) => settings[key],
        getAllSettings: () => ({ ...settings }),
        setSetting
      }
    })
    const handlers = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const handler = (channel: string) => handlers.filter(([name]) => name === channel).pop()![1]

    const all = await handler('settings:getAll')({}) as Record<string, string>
    expect(JSON.stringify(all)).not.toContain('sk-ant-raw')
    expect(all.anthropic_api_key).toBeTruthy()
    expect(all.openai_api_key).toBe('')
    expect(all.theme).toBe('dark')

    const single = await handler('settings:get')({}, 'anthropic_api_key')
    expect(single).toBe(all.anthropic_api_key)

    await handler('settings:set')({}, 'anthropic_api_key', all.anthropic_api_key)
    expect(setSetting).not.toHaveBeenCalled()
    await handler('settings:set')({}, 'anthropic_api_key', 'sk-ant-new')
    expect(setSetting).toHaveBeenCalledWith('anthropic_api_key', 'sk-ant-new')
  })

  it('voice handlers stay safe when the voice manager is absent', async () => {
    register()

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const snapshot = handleCalls.find((call) => call[0] === 'voice:getSnapshot')?.[1]
    const pushAudio = handleCalls.find((call) => call[0] === 'voice:pushAudio')?.[1]
    const startTurn = handleCalls.find((call) => call[0] === 'voice:startTurn')?.[1]

    await expect(snapshot!({}, {})).resolves.toMatchObject({ enabled: false, state: 'disabled' })
    expect(() => pushAudio!({}, { turnId: 't', chunk: new Uint8Array(2) })).not.toThrow()
    // The handler is async now, so it rejects rather than throwing.
    await expect(startTurn!({}, { mode: 'command' })).rejects.toThrow(/not available/i)
  })

  it('passes every turn mode through, including conversation', async () => {
    const startTurnSpy = vi.fn(async (_mode: string, _context: unknown) => ({ turnId: 't1' }))
    register({ voiceSessionManager: { startTurn: startTurnSpy } })

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const startTurn = handleCalls.filter((call) => call[0] === 'voice:startTurn').pop()?.[1]

    // Coercing an unknown mode to 'dictation' once threw 'conversation' away,
    // which ended the loop after the first sentence.
    await startTurn!({}, { mode: 'conversation', context: {} })
    await startTurn!({}, { mode: 'command', context: {} })
    await startTurn!({}, { mode: 'dictation', context: {} })
    await startTurn!({}, { mode: 'nonsense', context: {} })

    expect(startTurnSpy.mock.calls.map((call) => call[0])).toEqual([
      'conversation',
      'command',
      'dictation',
      'dictation',
    ])
  })

  it('passes the exact turn epoch through the cancellation boundary', async () => {
    const cancelTurn = vi.fn()
    register({ voiceSessionManager: { cancelTurn } })
    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const cancel = handleCalls.filter((call) => call[0] === 'voice:cancelTurn').pop()?.[1]

    await cancel!({}, { turnId: 'shared-turn', turnEpoch: 'old-start-epoch' })

    expect(cancelTurn).toHaveBeenCalledExactlyOnceWith('shared-turn', 'old-start-epoch')
  })

  it('passes confirmation ownership through confirm and dismiss boundaries', async () => {
    const confirm = vi.fn()
    const dismiss = vi.fn()
    register({ voiceSessionManager: { confirm, dismiss } })
    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const confirmHandler = handleCalls.filter((call) => call[0] === 'voice:confirm').pop()?.[1]
    const dismissHandler = handleCalls.filter((call) => call[0] === 'voice:dismiss').pop()?.[1]

    await confirmHandler!({}, {
      turnId: 'shared-turn',
      turnEpoch: 'confirmation-epoch',
      choice: { taskId: 'task-1' },
    })
    await dismissHandler!({}, { turnId: 'shared-turn', turnEpoch: 'confirmation-epoch' })

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      'shared-turn',
      { taskId: 'task-1' },
      'confirmation-epoch'
    )
    expect(dismiss).toHaveBeenCalledExactlyOnceWith('shared-turn', 'confirmation-epoch')
  })

  it('terminal:kill ignores stale expectedPid and only kills matching process', async () => {
    register()

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const createHandler = handleCalls.find((call) => call[0] === 'terminal:create')?.[1]
    const killHandler = handleCalls.find((call) => call[0] === 'terminal:kill')?.[1]

    expect(createHandler).toBeDefined()
    expect(killHandler).toBeDefined()

    const sender = { isDestroyed: () => false, send: vi.fn(), getType: () => 'window' }
    // terminal:create only accepts the main window's own frame.
    const senderFrame = { url: pathToFileURL(join(__dirname, '../renderer/index.html')).href, parent: null }
    await createHandler?.({ sender, senderFrame }, { id: 'panel-1', cols: 80, rows: 24 })

    await killHandler?.({}, { id: 'panel-1', expectedPid: 9999 })
    expect(mockChildKill).not.toHaveBeenCalled()

    await killHandler?.({}, { id: 'panel-1', expectedPid: 4242 })
    expect(mockChildKill).toHaveBeenCalledTimes(1)
    expect(mockChildKill).toHaveBeenCalledWith('SIGTERM')
  })

  it('terminal:create refuses a sender that is not the main window frame', async () => {
    register()

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const createHandler = handleCalls.find((call) => call[0] === 'terminal:create')?.[1]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sender = { isDestroyed: () => false, send: vi.fn(), getType: () => 'webview' }
    const senderFrame = { url: 'https://evil.example/', parent: null }

    await expect(createHandler?.({ sender, senderFrame }, { id: 'panel-evil', cols: 80, rows: 24 }))
      .rejects.toThrow(/terminal:create/)
    expect(mockSpawn).not.toHaveBeenCalled()

    warn.mockRestore()
  })
})

describe('db:updateTask coordinator wake-up', () => {
  function setup(existing: Record<string, unknown>, updated: Record<string, unknown>) {
    const notifyParent = vi.fn().mockResolvedValue(undefined)
    const startTask = vi.fn().mockResolvedValue({ action: 'task_started', sessionId: 'session-1' })
    const stopByTaskId = vi.fn().mockResolvedValue({ sessionId: 'session-old' })
    const updateTask = vi.fn(() => updated)
    register({
      agentManager: { notifyParentOfSubtaskCompletion: notifyParent, startTask, stopByTaskId },
      db: {
        getTask: vi.fn(() => existing),
        getSetting: vi.fn(() => undefined),
        updateTask
      }
    })

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const updateHandler = handleCalls.filter((call) => call[0] === 'db:updateTask').pop()?.[1]
    expect(updateHandler).toBeDefined()
    return { notifyParent, startTask, stopByTaskId, updateTask, updateHandler: updateHandler! }
  }

  it('wakes the parent coordinator when a subtask is moved to a terminal state from the UI', async () => {
    const existing = { id: 'sub-1', parent_task_id: 'parent-1', status: 'agent_working' }
    const updated = { ...existing, status: 'ready_for_review' }
    const { notifyParent, stopByTaskId, updateTask, updateHandler } = setup(existing, updated)

    await updateHandler({}, 'sub-1', { status: 'ready_for_review' })

    expect(notifyParent).toHaveBeenCalledWith('parent-1', 'sub-1')
    expect(stopByTaskId).toHaveBeenCalledWith('sub-1')
    expect(stopByTaskId.mock.invocationCallOrder[0]).toBeLessThan(updateTask.mock.invocationCallOrder[0])
  })

  it('wakes the parent when a UI completion closes a subtask', async () => {
    const existing = { id: 'sub-2', parent_task_id: 'parent-1', status: 'ready_for_review' }
    const updated = { ...existing, status: 'completed' }
    const { notifyParent, updateHandler } = setup(existing, updated)

    await updateHandler({}, 'sub-2', { status: 'completed' })

    expect(notifyParent).toHaveBeenCalledWith('parent-1', 'sub-2')
  })

  it('does not wake the parent for a non-terminal status change', async () => {
    const existing = { id: 'sub-3', parent_task_id: 'parent-1', status: 'not_started' }
    const updated = { ...existing, status: 'agent_working' }
    const { notifyParent, startTask, updateTask, updateHandler } = setup(existing, updated)

    await updateHandler({}, 'sub-3', { status: 'agent_working' })

    expect(notifyParent).not.toHaveBeenCalled()
    expect(startTask).toHaveBeenCalledWith('sub-3', { resumeManualStop: true, explicitUserStart: true })
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('does not wake the parent when the status did not change', async () => {
    const existing = { id: 'sub-4', parent_task_id: 'parent-1', status: 'ready_for_review' }
    const updated = { ...existing, title: 'rename only path' }
    const { notifyParent, updateHandler } = setup(existing, updated)

    await updateHandler({}, 'sub-4', { title: 'rename only path' })

    expect(notifyParent).not.toHaveBeenCalled()
  })

  it('does not wake anything for a top-level task', async () => {
    const existing = { id: 'top-1', parent_task_id: null, status: 'agent_working' }
    const updated = { ...existing, status: 'ready_for_review' }
    const { notifyParent, updateHandler } = setup(existing, updated)

    await updateHandler({}, 'top-1', { status: 'ready_for_review' })

    expect(notifyParent).not.toHaveBeenCalled()
  })
})

describe('db:updateTask heartbeat cascade on parent completion', () => {
  afterEach(() => setTaskSchedulers({ heartbeat: null }))

  function setup(options: {
    existing: Record<string, unknown>
    updated: Record<string, unknown>
    subtasks: Array<{ id: string; heartbeat_enabled: boolean }>
  }) {
    const { existing, updated, subtasks } = options
    const disableHeartbeat = vi.fn()
    setTaskSchedulers({ heartbeat: { disableHeartbeat } })
    register({
      db: {
        getTask: vi.fn(() => existing),
        getSetting: vi.fn(() => undefined),
        updateTask: vi.fn(() => updated),
        getSubtasks: vi.fn(() => subtasks)
      }
    })

    const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => unknown][]
    const updateHandler = handleCalls.filter((call) => call[0] === 'db:updateTask').pop()?.[1]
    expect(updateHandler).toBeDefined()
    return { disableHeartbeat, updateHandler: updateHandler! }
  }

  it('disables heartbeat on subtasks still in review when the parent is completed', async () => {
    const existing = { id: 'parent-1', status: 'ready_for_review' }
    const updated = { ...existing, status: 'completed' }
    const { disableHeartbeat, updateHandler } = setup({
      existing,
      updated,
      subtasks: [
        { id: 'sub-1', heartbeat_enabled: true },
        { id: 'sub-2', heartbeat_enabled: false }
      ]
    })

    await updateHandler({}, 'parent-1', { status: 'completed' })

    expect(disableHeartbeat).toHaveBeenCalledWith('sub-1')
    expect(disableHeartbeat).not.toHaveBeenCalledWith('sub-2')
  })

  it('does not touch subtask heartbeats for a non-completion status change', async () => {
    const existing = { id: 'parent-1', status: 'not_started' }
    const updated = { ...existing, status: 'agent_working' }
    const { disableHeartbeat, updateHandler } = setup({
      existing,
      updated,
      subtasks: [{ id: 'sub-1', heartbeat_enabled: true }]
    })

    await updateHandler({}, 'parent-1', { status: 'agent_working' })

    expect(disableHeartbeat).not.toHaveBeenCalled()
  })
})

describe('bounded transcript IPC replies', () => {
  function handlers(agentManager: Record<string, unknown>) {
    vi.mocked(ipcMain.handle).mockClear()
    register({ agentManager })
    const calls = vi.mocked(ipcMain.handle).mock.calls
    return (channel: string) => calls.find(([name]) => name === channel)![1]
  }

  it('previews oversized records in snapshot and delta replies', async () => {
    const huge = { taskId: 't', partId: 'p', seq: 1, role: 'assistant', content: 'x'.repeat(5 * 1024 * 1024), rev: 3, createdAt: 1, updatedAt: 1 }
    const small = { ...huge, partId: 'q', seq: 2, content: 'ok', rev: 4 }
    const get = handlers({
      getTranscriptSnapshot: vi.fn().mockResolvedValue([huge, small]),
      getTranscriptDelta: vi.fn().mockResolvedValue({ parts: [huge], maxRev: 4 })
    })
    const snapshot = await get('agentSession:getTranscriptSnapshot')({} as Electron.IpcMainInvokeEvent, 't') as typeof huge[]
    expect(snapshot.map(p => p.partId)).toEqual(['p', 'q'])
    expect(snapshot[0].content.length).toBeLessThan(10_000)
    expect(snapshot[1]).toBe(small)
    const delta = await get('agentSession:getTranscriptDelta')({} as Electron.IpcMainInvokeEvent, 't', 2) as { parts: typeof huge[]; maxRev: number }
    expect(delta.maxRev).toBe(4)
    expect(delta.parts[0].rev).toBe(3)
    expect(delta.parts[0].content.length).toBeLessThan(10_000)
  })
})
