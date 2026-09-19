import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import type { AgentStatusEvent, WorktreeProgressEvent } from '../src/renderer/src/types/electron'
import type { Task } from '../src/renderer/src/types/index'

// Suppress React act() warnings in happy-dom
;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// Capture event listener callbacks for store tests
export const eventCallbacks = {
  onTranscriptChanged: null as ((event: unknown) => void) | null,
  onAgentStatus: null as ((event: AgentStatusEvent) => void) | null,
  onOverdueCheck: null as (() => void) | null,
  onTaskUpdated: null as ((event: { taskId: string; updates: Partial<Task> }) => void) | null,
  onTaskDeleted: null as ((event: { taskId: string }) => void) | null,
  onWorktreeProgress: null as ((event: WorktreeProgressEvent) => void) | null,
  onVoiceState: null as ((event: unknown) => void) | null,
  onVoicePartial: null as ((event: unknown) => void) | null,
  onVoiceOutcome: null as ((event: unknown) => void) | null,
  onVoiceNavigate: null as ((event: unknown) => void) | null,
  onVoiceDictate: null as ((event: unknown) => void) | null,
  onVoiceHotkey: null as ((event: unknown) => void) | null,
  onVoiceRuntimeProgress: null as ((event: unknown) => void) | null
}

const mockElectronAPI = {
  db: {
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue({}),
    deleteTask: vi.fn().mockResolvedValue(true),
    getSubtasks: vi.fn().mockResolvedValue([])
  },
  mcpServers: {
    getAll: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(true),
    testConnection: vi.fn().mockResolvedValue({ status: 'connected', tools: [] })
  },
  agents: {
    getAll: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(true),
    getStartQueue: vi.fn().mockResolvedValue([])
  },
  agentSession: {
    start: vi.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    startTask: vi.fn().mockResolvedValue({ action: 'task_started', sessionId: 'test-session-id' }),
    resume: vi.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    abort: vi.fn().mockResolvedValue({ success: true }),
    stop: vi.fn().mockResolvedValue({ success: true }),
    stopByTaskId: vi.fn().mockResolvedValue({ success: true, sessionId: null }),
    send: vi.fn().mockResolvedValue({ success: true }),
    sendByTaskId: vi.fn().mockResolvedValue({ success: true, sessionId: null }),
    approve: vi.fn().mockResolvedValue({ success: true }),
    syncSkills: vi.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] }),
    syncSkillsForTask: vi.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] }),
    learnFromSession: vi.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] }),
    getRawTranscript: vi.fn().mockResolvedValue([]),
    getTranscriptSnapshot: vi.fn().mockResolvedValue([]),
    getTranscriptDelta: vi.fn().mockResolvedValue({ parts: [], maxRev: 0 })
  },
  agentConfig: {
    getProviders: vi.fn().mockResolvedValue(null)
  },
  attachments: {
    pick: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(undefined)
  },
  shell: {
    openPath: vi.fn().mockResolvedValue(undefined),
    showItemInFolder: vi.fn().mockResolvedValue(undefined),
    readTextFile: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn().mockResolvedValue(undefined)
  },
  notifications: {
    show: vi.fn().mockResolvedValue(undefined)
  },
  settings: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue({})
  },
  github: {
    checkCli: vi.fn().mockResolvedValue({ installed: false, authenticated: false }),
    fetchOrgs: vi.fn().mockResolvedValue([]),
    fetchOrgRepos: vi.fn().mockResolvedValue([])
  },
  gitlab: {
    checkCli: vi.fn().mockResolvedValue({ installed: false, authenticated: false }),
    startAuth: vi.fn().mockResolvedValue(undefined),
    fetchOrgs: vi.fn().mockResolvedValue([]),
    fetchOrgRepos: vi.fn().mockResolvedValue([]),
    fetchUserRepos: vi.fn().mockResolvedValue([])
  },
  forgejo: {
    checkCli: vi.fn().mockResolvedValue({ installed: false, authenticated: false, logins: [], code: 'not-installed' }),
    setLogin: vi.fn().mockResolvedValue({ installed: false, authenticated: false, logins: [], code: 'not-installed' }),
    fetchOrgs: vi.fn().mockResolvedValue([]),
    fetchOrgRepos: vi.fn().mockResolvedValue([]),
    fetchUserRepos: vi.fn().mockResolvedValue([])
  },
  git: {
    recordRepoProviders: vi.fn().mockResolvedValue(undefined)
  },
  worktree: {
    setup: vi.fn().mockResolvedValue(''),
    cleanup: vi.fn().mockResolvedValue(undefined)
  },
  taskSources: {
    getAll: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(true),
    sync: vi.fn().mockResolvedValue({ source_id: '', imported: 0, updated: 0, errors: [] }),
    exportUpdate: vi.fn().mockResolvedValue(undefined),
    getUsers: vi.fn().mockResolvedValue([]),
    reassign: vi.fn().mockResolvedValue({ success: true })
  },
  skills: {
    getAll: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(true)
  },
  deps: {
    check: vi.fn().mockResolvedValue({ gh: false, opencode: false })
  },
  env: {
    get: vi.fn().mockResolvedValue(null)
  },
  plugins: {
    list: vi.fn().mockResolvedValue([]),
    getConfigSchema: vi.fn().mockResolvedValue([]),
    resolveOptions: vi.fn().mockResolvedValue([]),
    getActions: vi.fn().mockResolvedValue([]),
    executeAction: vi.fn().mockResolvedValue({ success: true })
  },
  onOverdueCheck: vi.fn((cb: () => void) => {
    eventCallbacks.onOverdueCheck = cb
    return vi.fn()
  }),
  onTranscriptChanged: vi.fn((cb: (event: unknown) => void) => {
    eventCallbacks.onTranscriptChanged = cb as never
    return vi.fn()
  }),
  onAgentStatus: vi.fn((cb: (event: AgentStatusEvent) => void) => {
    eventCallbacks.onAgentStatus = cb
    return vi.fn()
  }),
  onAgentIncompatibleSession: vi.fn((_cb: (event: { taskId: string; agentId: string; error: string }) => void) => {
    return vi.fn()
  }),
  onAgentStartQueueChanged: vi.fn((_cb: (event: unknown) => void) => {
    return vi.fn()
  }),
  onTaskUpdated: vi.fn((cb: (event: { taskId: string; updates: Partial<Task> }) => void) => {
    eventCallbacks.onTaskUpdated = cb
    return vi.fn()
  }),
  onWorktreeProgress: vi.fn((cb: (event: WorktreeProgressEvent) => void) => {
    eventCallbacks.onWorktreeProgress = cb
    return vi.fn()
  }),
  onTaskCreated: vi.fn((_cb: (event: { task: Task }) => void) => {
    return vi.fn()
  }),
  onTaskDeleted: vi.fn((cb: (event: { taskId: string }) => void) => {
    eventCallbacks.onTaskDeleted = cb
    return vi.fn()
  }),
  onGitlabDeviceCode: vi.fn((_cb: (code: string) => void) => {
    return vi.fn()
  }),
  onTasksRefresh: vi.fn((_cb: () => void) => {
    return vi.fn()
  }),
  agentInstaller: {
    detect: vi.fn().mockResolvedValue({}),
    install: vi.fn().mockResolvedValue({ success: true, error: null, newStatus: {} }),
    getCommand: vi.fn().mockResolvedValue(''),
    onProgress: vi.fn((_cb: (data: unknown) => void) => vi.fn())
  },
  app: {
    getVersion: vi.fn().mockResolvedValue('0.0.1')
  },
  voice: {
    getSnapshot: vi.fn().mockResolvedValue({
      enabled: false,
      engine: { state: 'model_missing', message: 'No speech model is installed yet.' },
      models: [],
      shortcut: 'CommandOrControl+Shift+Space',
      runtime: { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 },
      state: 'disabled',
      turnId: null,
      partial: '',
      final: ''
    }),
    setEnabled: vi.fn().mockResolvedValue({
      enabled: true,
      engine: { state: 'ready', modelId: 'test', engine: 'fake' },
      models: [],
      shortcut: 'CommandOrControl+Shift+Space',
      runtime: { installed: true, version: '1.0.0', modulePath: '/tmp/voice', sizeBytes: 0 },
      state: 'idle',
      turnId: null,
      partial: '',
      final: ''
    }),
    getPermission: vi.fn().mockResolvedValue({ status: 'granted' }),
    requestPermission: vi.fn().mockResolvedValue({ status: 'granted' }),
    startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-1' }),
    pushAudio: vi.fn().mockResolvedValue(undefined),
    endTurn: vi.fn().mockResolvedValue(undefined),
    cancelTurn: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue({ success: true }),
    dismiss: vi.fn().mockResolvedValue(undefined),
    getRuntime: vi.fn().mockResolvedValue({
      installed: true,
      version: '1.0.0',
      modulePath: '/tmp/voice',
      sizeBytes: 188743680
    }),
    installRuntime: vi.fn().mockResolvedValue({
      installed: true,
      version: '1.0.0',
      modulePath: '/tmp/voice',
      sizeBytes: 188743680
    }),
    removeRuntime: vi.fn().mockResolvedValue({
      installed: false,
      version: null,
      modulePath: null,
      sizeBytes: 188743680
    }),
    listModels: vi.fn().mockResolvedValue([]),
    installModel: vi.fn().mockResolvedValue({}),
    removeModel: vi.fn().mockResolvedValue({ success: true }),
    removeAllModels: vi.fn().mockResolvedValue({ success: true }),
    setCustomModelDir: vi.fn().mockResolvedValue({}),
    pickModelDir: vi.fn().mockResolvedValue({ dir: null }),
    setShortcut: vi.fn().mockResolvedValue({}),
    onState: vi.fn((cb: (event: unknown) => void) => {
      eventCallbacks.onVoiceState = cb
      return vi.fn()
    }),
    onPartial: vi.fn((cb: (event: unknown) => void) => {
      eventCallbacks.onVoicePartial = cb
      return vi.fn()
    }),
    onFinal: vi.fn((_cb: (event: unknown) => void) => vi.fn()),
    onOutcome: vi.fn((cb: (event: unknown) => void) => {
      eventCallbacks.onVoiceOutcome = cb
      return vi.fn()
    }),
    onStatus: vi.fn((_cb: (event: unknown) => void) => vi.fn()),
    onError: vi.fn((_cb: (event: unknown) => void) => vi.fn()),
    onNavigate: vi.fn((cb: (event: unknown) => void) => {
      eventCallbacks.onVoiceNavigate = cb
      return vi.fn()
    }),
    onDictate: vi.fn((cb: (event: unknown) => void) => {
      eventCallbacks.onVoiceDictate = cb
      return vi.fn()
    }),
    onRuntimeProgress: vi.fn((cb: (event: unknown) => void) => {
      eventCallbacks.onVoiceRuntimeProgress = cb
      return vi.fn()
    }),
    onHotkey: vi.fn((cb: (event: unknown) => void) => {
      eventCallbacks.onVoiceHotkey = cb
      return vi.fn()
    })
  },
  updater: {
    check: vi.fn().mockResolvedValue({ success: true }),
    download: vi.fn().mockResolvedValue({ success: true }),
    install: vi.fn().mockResolvedValue(undefined),
    getVersion: vi.fn().mockResolvedValue('0.0.31'),
    onStatus: vi.fn((_cb: (data: unknown) => void) => vi.fn()),
    onMenuCheckForUpdates: vi.fn((_cb: () => void) => vi.fn())
  }
}

Object.defineProperty(window, 'electronAPI', {
  value: mockElectronAPI,
  configurable: true,
  writable: true
})
