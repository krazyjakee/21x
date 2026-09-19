import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { DashboardWorkspace } from './DashboardWorkspace'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'

// Mock use-snooze-tick to avoid IPC dependency in tests
vi.mock('@/hooks/use-snooze-tick', () => ({
  useSnoozeTick: () => 0
}))

// Mock ipc-client - prevent real API calls during tests
vi.mock('@/lib/ipc-client', () => ({
  taskApi: {
    getAll: vi.fn().mockResolvedValue([])
  },
  // The command box now offers dictation, so the voice store loads with it.
  voiceApi: {
    getSnapshot: vi.fn().mockResolvedValue({
      enabled: false,
      engine: { state: 'model_missing', message: '' },
      models: [],
      shortcut: '',
      runtime: { installed: false, version: null, modulePath: null, sizeBytes: 0 },
      state: 'disabled',
      turnId: null,
      partial: '',
      final: ''
    }),
    getPermission: vi.fn().mockResolvedValue({ status: 'not-determined' }),
    getRuntime: vi.fn().mockResolvedValue({ installed: false, version: null, modulePath: null, sizeBytes: 0 }),
    listModels: vi.fn().mockResolvedValue([]),
    startTurn: vi.fn(),
    endTurn: vi.fn(),
    cancelTurn: vi.fn(),
    pushAudio: vi.fn(),
    onState: vi.fn(() => vi.fn()),
    onPartial: vi.fn(() => vi.fn()),
    onFinal: vi.fn(() => vi.fn()),
    onSegment: vi.fn(() => vi.fn()),
    onOutcome: vi.fn(() => vi.fn()),
    onStatus: vi.fn(() => vi.fn()),
    onError: vi.fn(() => vi.fn()),
    onNavigate: vi.fn(() => vi.fn()),
    onDictate: vi.fn(() => vi.fn()),
    onHotkey: vi.fn(() => vi.fn()),
    onRuntimeProgress: vi.fn(() => vi.fn())
  },
  settingsApi: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue({})
  },
  onTaskUpdated: vi.fn(() => () => {}),
  onTaskCreated: vi.fn(() => () => {}),
  onTaskDeleted: vi.fn(() => () => {}),
  onTasksRefresh: vi.fn(() => () => {}),
  onAgentStatus: vi.fn(() => () => {}),
  onAgentOutput: vi.fn(() => () => {}),
  onAgentOutputBatch: vi.fn(() => () => {}),
  onTranscriptChanged: vi.fn(() => () => {}),
  onAgentIncompatibleSession: vi.fn(() => () => {}),
  agentApi: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    sendMessage: vi.fn(),
    approveAction: vi.fn(),
    rejectAction: vi.fn()
  },
  taskSourceApi: { sync: vi.fn() }
}))

afterEach(cleanup)

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    description: '',
    type: 'general',
    priority: 'medium',
    status: TaskStatus.NotStarted,
    assignee: '',
    due_date: null,
    labels: [],
    attachments: [],
    repos: [],
    output_fields: [],
    agent_id: null,
    session_id: null,
    external_id: null,
    source_id: null,
    source: 'local',
    skill_ids: null,
    snoozed_until: null,
    resolution: null,
    feedback_rating: null,
    feedback_comment: null,
    is_recurring: false,
    recurrence_pattern: null,
    recurrence_parent_id: null,
    last_occurrence_at: null,
    next_occurrence_at: null,
    auto_start_agent: false,
    auto_complete_without_review: false,
    complete_at_source: null,
    parent_task_id: null,
    next_subtask_ids: [],
    sort_order: 0,
    created_at: '2026-03-28T08:00:00Z',
    updated_at: '2026-03-28T08:00:00Z',
    ...overrides
  }
}

beforeEach(() => {
  useTaskStore.setState({
    tasks: [],
    selectedTaskId: null,
    isLoading: false,
    error: null
  })
  useUIStore.setState({
    showOrchestrator: false,
    createTaskPrefill: null
  })
})

describe('DashboardWorkspace', () => {
  it('shows no hosted-service prompts', () => {
    render(<DashboardWorkspace />)
    expect(screen.queryByText(/20x Cloud/)).toBeNull()
    expect(screen.queryByText(/Sign in/)).toBeNull()
    expect(screen.queryByText('Applications')).toBeNull()
  })

  it('renders hero section with rotating title', () => {
    render(<DashboardWorkspace />)
    // One of the rotating titles should be visible
    expect(screen.getByText('What do you want to finish today?')).toBeDefined()
  })

  it('renders command input', () => {
    render(<DashboardWorkspace />)
    expect(screen.getByPlaceholderText('Ask Captain or describe a task...')).toBeDefined()
  })

  it('renders quick chips', () => {
    render(<DashboardWorkspace />)
    expect(screen.getByText('Summarize this week')).toBeDefined()
    expect(screen.getByText('Draft outreach email')).toBeDefined()
  })

  it('renders task board with status columns', () => {
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'task-1', title: 'Some task', status: TaskStatus.NotStarted })
      ]
    })
    render(<DashboardWorkspace />)
    expect(screen.getByText('Task Board')).toBeDefined()
    expect(screen.getByText('Not Started')).toBeDefined()
    expect(screen.getByText('Agent Working')).toBeDefined()
  })

  it('renders task board columns with local 20x tasks', () => {
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'task-1', title: 'Review invoice', status: TaskStatus.NotStarted, priority: 'high' }),
        makeTask({ id: 'task-2', title: 'Process payment', status: TaskStatus.AgentWorking, priority: 'medium' })
      ]
    })

    render(<DashboardWorkspace />)
    // Column headers (20x task statuses)
    expect(screen.getByText('Not Started')).toBeDefined()
    expect(screen.getByText('Agent Working')).toBeDefined()
    // Task cards
    expect(screen.getByText('Review invoice')).toBeDefined()
    expect(screen.getByText('Process payment')).toBeDefined()
    expect(screen.getByText('high')).toBeDefined()
  })

  it('filters out subtasks from the task board', () => {
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'parent-1', title: 'Parent task', status: TaskStatus.NotStarted }),
        makeTask({ id: 'sub-1', title: 'Subtask', status: TaskStatus.NotStarted, parent_task_id: 'parent-1' })
      ]
    })

    render(<DashboardWorkspace />)
    expect(screen.getByText('Parent task')).toBeDefined()
    expect(screen.queryByText('Subtask')).toBeNull()
    // Count shows 1 active task (only parent)
    expect(screen.getByText('1 active task')).toBeDefined()
  })

  it('shows empty task board when no tasks', () => {

    render(<DashboardWorkspace />)
    expect(screen.getByText(/No tasks yet/)).toBeDefined()
  })

  it('hides snoozed tasks from the task board', () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'active-1', title: 'Active task', status: TaskStatus.NotStarted }),
        makeTask({ id: 'snoozed-1', title: 'Snoozed task', status: TaskStatus.NotStarted, snoozed_until: futureDate }),
        makeTask({ id: 'snoozed-2', title: 'Someday task', status: TaskStatus.AgentWorking, snoozed_until: '9999-12-31T00:00:00.000Z' })
      ]
    })

    render(<DashboardWorkspace />)
    expect(screen.getByText('Active task')).toBeDefined()
    expect(screen.queryByText('Snoozed task')).toBeNull()
    expect(screen.queryByText('Someday task')).toBeNull()
    // Only 1 active task (snoozed ones are excluded)
    expect(screen.getByText('1 active task')).toBeDefined()
  })

  it('shows tasks whose snooze has expired', () => {
    const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'expired-snooze', title: 'Expired snooze task', status: TaskStatus.NotStarted, snoozed_until: pastDate })
      ]
    })

    render(<DashboardWorkspace />)
    expect(screen.getByText('Expired snooze task')).toBeDefined()
  })

  it('clicking a task card sets dashboardPreviewTaskId in UI store', () => {
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'task-abc', title: 'Clickable task', status: TaskStatus.NotStarted })
      ]
    })

    render(<DashboardWorkspace />)
    fireEvent.click(screen.getByText('Clickable task'))

    // Should set the preview task ID in the UI store (dialog rendered by AppLayout)
    expect(useUIStore.getState().dashboardPreviewTaskId).toBe('task-abc')
  })

  it('quick chip click for task opens create modal with prefill', () => {
    render(<DashboardWorkspace />)
    fireEvent.click(screen.getByText('Draft outreach email'))

    const state = useUIStore.getState()
    expect(state.activeModal).toBe('create')
    expect(state.createTaskPrefill).toBeDefined()
    expect(state.createTaskPrefill?.title).toBe('Draft outreach email')
  })
})

describe('DashboardWorkspace — readability', () => {
  it('opts the dashboard into the shared type and spacing scale', () => {
    const { container } = render(<DashboardWorkspace />)
    expect(container.firstElementChild?.classList.contains('ui-scale')).toBe(true)
  })

  it('defines readable scale tokens in the shared stylesheet', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/globals.css'), 'utf8')
    const block = css.match(/\.ui-scale\s*\{([^}]*)\}/)?.[1] ?? ''
    const px = (token: string): number =>
      Number(block.match(new RegExp(`--${token}:\\s*([\\d.]+)px`))?.[1] ?? 0)

    // Smallest metadata text stays at 11px or more; body text at 13px.
    expect(px('text-2xs')).toBeGreaterThanOrEqual(11)
    expect(px('text-xs')).toBeGreaterThanOrEqual(12)
    expect(px('text-sm')).toBeGreaterThanOrEqual(13)
    // Spacing at 4px makes h-8 controls 32px.
    expect(px('spacing')).toBeGreaterThanOrEqual(4)
  })

  it('defines fixed icon and hit-area tokens shared by the dashboard and chrome', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/globals.css'), 'utf8')
    const px = (token: string): number =>
      Number(css.match(new RegExp(`--spacing-${token}:\\s*([\\d.]+)px`))?.[1] ?? 0)

    expect(px('icon-xs')).toBeGreaterThanOrEqual(12)
    expect(px('icon-sm')).toBeGreaterThanOrEqual(14)
    expect(px('icon')).toBeGreaterThanOrEqual(16)
    expect(px('icon-lg')).toBeGreaterThanOrEqual(20)
    // Desktop icon-only controls are at least 32px square.
    expect(px('hit')).toBeGreaterThanOrEqual(32)
    expect(px('hit-lg')).toBeGreaterThanOrEqual(px('hit'))
  })

  it('uses shared type tokens instead of fixed pixel sizes on task cards', () => {
    useTaskStore.setState({
      tasks: [
        makeTask({
          id: 'task-rich',
          title: 'Rich task',
          description: 'Has every piece of metadata',
          priority: 'high',
          labels: ['one', 'two', 'three', 'four'],
          assignee: 'Ada Lovelace',
          due_date: '2026-01-01T00:00:00Z',
          source: 'github'
        })
      ]
    })
    const { container } = render(<DashboardWorkspace />)
    expect(screen.getByText('Rich task')).toBeDefined()

    const fixed = Array.from(container.querySelectorAll('[class*="text-["]')).filter((el) =>
      /\btext-\[\d+px\]/.test(el.getAttribute('class') ?? '')
    )
    expect(fixed).toEqual([])
  })

  it('gives icon-only command controls accessible names and a full hit area', () => {
    render(<DashboardWorkspace />)
    for (const name of ['Attach file', 'Send to Captain']) {
      const button = screen.getByRole('button', { name })
      expect(button.classList.contains('size-hit')).toBe(true)
    }
  })

  it('sizes card icons with the shared icon tokens instead of raw spacing steps', () => {
    useTaskStore.setState({
      tasks: [
        makeTask({
          id: 'task-icons',
          title: 'Icon task',
          due_date: '2026-01-01T00:00:00Z',
          source: 'github'
        })
      ]
    })
    const { container } = render(<DashboardWorkspace />)
    // The microphone is a shared voice control with its own sizing.
    const icons = Array.from(container.querySelectorAll('svg.lucide')).filter(
      (el) => !el.closest('[data-testid="voice-mic-button"]')
    )
    expect(icons.length).toBeGreaterThan(0)
    const raw = icons.filter((el) => /\bh-\d/.test(el.getAttribute('class') ?? ''))
    expect(raw.map((el) => el.getAttribute('class'))).toEqual([])
  })
})
