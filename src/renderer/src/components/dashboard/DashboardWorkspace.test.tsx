import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { DashboardWorkspace } from './DashboardWorkspace'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { agentApi, onAgentStartQueueChanged } from '@/lib/ipc-client'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'
import type { AgentStartQueueChangedEvent, QueuedAgentStart } from '@/types/electron'

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
  onAgentStartQueueChanged: vi.fn(() => () => {}),
  onTranscriptChanged: vi.fn(() => () => {}),
  onAgentIncompatibleSession: vi.fn(() => () => {}),
  agentApi: {
    getAll: vi.fn().mockResolvedValue([]),
    getStartQueue: vi.fn().mockResolvedValue([]),
    getStartRecoveryState: vi.fn().mockResolvedValue(null),
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
  vi.mocked(agentApi.getStartQueue).mockResolvedValue([])
  vi.mocked(agentApi.getStartRecoveryState).mockResolvedValue(null)
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
  it('rehydrates a durable terminal start failure after reopening the board', async () => {
    useTaskStore.setState({ tasks: [makeTask()] })
    vi.mocked(agentApi.getStartRecoveryState).mockResolvedValueOnce({ taskId: 'task-1', state: 'failed' } as never)
    render(<DashboardWorkspace />)
    await waitFor(() => expect(screen.getByTestId('task-transition-task-1')).toHaveTextContent('failed'))
  })

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

  it('moves a task to another status with the keyboard drag interaction', async () => {
    const task = makeTask({ id: 'task-drag', title: 'Draggable task', status: TaskStatus.NotStarted })
    const onTaskStatusChange = vi.fn()
    useTaskStore.setState({ tasks: [task] })

    const rects: Record<string, [number, number, number, number]> = {
      'task-card-task-drag': [10, 150, 220, 100],
      'task-column-not_started': [0, 100, 250, 500],
      'task-column-triaging': [280, 100, 250, 500],
      'task-column-agent_working': [560, 100, 250, 500],
      'task-column-ready_for_review': [840, 100, 250, 500],
      'task-column-completed': [1400, 20, 160, 32]
    }
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const [x, y, width, height] = rects[this.dataset.testid ?? ''] ?? [0, 0, 0, 0]
      return DOMRect.fromRect({ x, y, width, height })
    })

    render(<DashboardWorkspace onTaskStatusChange={onTaskStatusChange} />)
    const card = screen.getByTestId('task-card-task-drag')
    card.focus()
    fireEvent.keyDown(card, { key: ' ', code: 'Space' })
    await screen.findByText('Drop to complete')
    for (const status of [TaskStatus.NotStarted, TaskStatus.Triaging, TaskStatus.AgentWorking, TaskStatus.ReadyForReview]) {
      const column = screen.getByTestId(`task-column-${status}`)
      expect(column.dataset.dropActive).toBe('true')
      expect(column.querySelector('.border-dashed')).not.toBeNull()
    }
    // KeyboardSensor attaches its document listener on the next tick.
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    for (let i = 0; i < 12; i++) fireEvent.keyDown(card, { key: 'ArrowRight', code: 'ArrowRight' })
    fireEvent.keyDown(card, { key: ' ', code: 'Space' })

    await waitFor(() => expect(onTaskStatusChange).toHaveBeenCalledWith(task, TaskStatus.Triaging))
    rectSpy.mockRestore()
  })

  it('uses the pointer position and keeps the card truthful while the start command is pending', async () => {
    const task = makeTask({ id: 'task-pointer', title: 'Pointer task', status: TaskStatus.NotStarted })
    let finishStatusChange: (() => void) | undefined
    const onTaskStatusChange = vi.fn(() => new Promise<void>((resolve) => {
      finishStatusChange = resolve
    }))
    useTaskStore.setState({ tasks: [task] })

    const rects: Record<string, [number, number, number, number]> = {
      'task-card-task-pointer': [10, 150, 220, 100],
      'task-column-not_started': [0, 100, 250, 500],
      'task-column-triaging': [280, 100, 250, 500],
      'task-column-agent_working': [560, 100, 250, 500],
      'task-column-ready_for_review': [840, 100, 250, 500],
      // Deliberately make Completed closer to the pointer than the center of
      // Triaging. A closest-center strategy would complete this task.
      'task-column-completed': [280, 20, 160, 32]
    }
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const [x, y, width, height] = rects[this.dataset.testid ?? ''] ?? [0, 0, 0, 0]
      return DOMRect.fromRect({ x, y, width, height })
    })

    render(<DashboardWorkspace onTaskStatusChange={onTaskStatusChange} />)
    const card = screen.getByTestId('task-card-task-pointer')
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, buttons: 1, isPrimary: true, clientX: 20, clientY: 170 })
    fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, isPrimary: true, clientX: 350, clientY: 180 })
    await screen.findByText('Drop to complete')
    fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, isPrimary: true, clientX: 350, clientY: 180 })
    fireEvent.pointerUp(document, { pointerId: 1, button: 0, buttons: 0, isPrimary: true, clientX: 350, clientY: 180 })

    await waitFor(() => expect(onTaskStatusChange).toHaveBeenCalledWith(task, TaskStatus.Triaging))
    expect(onTaskStatusChange).not.toHaveBeenCalledWith(task, TaskStatus.Completed)
    expect(screen.getByTestId('task-column-not_started').contains(screen.getByTestId('task-card-task-pointer'))).toBe(true)
    expect(screen.getByTestId('task-transition-task-pointer')).toHaveTextContent('starting')
    await waitFor(() => expect(screen.queryByText('Drop to complete')).toBeNull())
    await act(async () => {
      useTaskStore.setState({ tasks: [{ ...task, status: TaskStatus.Triaging }] })
      finishStatusChange?.()
    })
    expect(screen.getByTestId('task-column-triaging').contains(screen.getByTestId('task-card-task-pointer'))).toBe(true)
    // PointerSensor intentionally retains its click suppressor for 50 ms so
    // the release cannot accidentally open the dragged card.
    await new Promise((resolve) => window.setTimeout(resolve, 60))
    rectSpy.mockRestore()
  })

  it('preserves an authoritative Queued badge across unrelated task snapshots until queue acknowledgement', async () => {
    const task = makeTask({ id: 'task-queued', title: 'Queued task', status: TaskStatus.AgentWorking })
    const queued: QueuedAgentStart = {
      id: 'queue-1',
      taskId: task.id,
      projectId: 'default',
      agentId: 'agent-1',
      reason: 'recovery',
      queuedAt: '2026-09-20T00:00:00.000Z',
      position: 1,
      priority: 'medium',
      state: 'queued',
      retryCount: 0,
      nextRetryAt: null,
      generation: 1,
      dependencyReason: null,
      recoveryCause: null,
      recoveryAction: null,
      recoveryResult: null,
      lastError: null
    }
    let recovery: QueuedAgentStart = queued
    vi.mocked(agentApi.getStartRecoveryState).mockImplementation(async () => recovery)
    useTaskStore.setState({ tasks: [task] })

    render(<DashboardWorkspace />)
    expect(await screen.findByTestId(`task-transition-${task.id}`)).toHaveTextContent('queued')

    await act(async () => {
      useTaskStore.setState({ tasks: [{ ...task, title: 'Renamed while queued' }] })
    })
    expect(screen.getByText('Renamed while queued')).toBeInTheDocument()
    expect(screen.getByTestId(`task-transition-${task.id}`)).toHaveTextContent('queued')

    // Repeated queue snapshots are idempotent; only an authoritative removal
    // acknowledges that the active start ownership ended.
    const listener = vi.mocked(onAgentStartQueueChanged).mock.calls.at(-1)?.[0]
    expect(listener).toBeDefined()
    act(() => listener?.({ queue: [queued] } as AgentStartQueueChangedEvent))
    await waitFor(() => expect(screen.getByTestId(`task-transition-${task.id}`)).toHaveTextContent('queued'))
    recovery = { ...queued, state: 'started' }
    act(() => listener?.({ queue: [] } as AgentStartQueueChangedEvent))
    await waitFor(() => expect(screen.queryByTestId(`task-transition-${task.id}`)).toBeNull())
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
