import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The stores subscribe to IPC as they load, so only the two calls this file
// would really make are replaced.
vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
}))

import { applyUiCommand, collectUiState } from './ui-remote-control'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { useProjectStore } from '@/stores/project-store'
import { useArtifactStore } from '@/stores/artifact-store'
import { SettingsTab } from '@/types'
import { ArtifactType } from '@shared/artifacts'

/**
 * Driving the window from an agent command.
 *
 * The rule these tests protect: a command names a task, and the settings pane
 * covers the workspace, so leaving it is part of going anywhere else.
 */

function seedTasks(): void {
  useTaskStore.setState({
    tasks: [
      { id: 't1', title: 'Fix login' },
      { id: 't2', title: 'Release notes' },
      { id: 't3', title: 'Mobile spike', project_id: 'p2' },
    ] as never,
    selectedTaskId: null,
  })
}

beforeEach(() => {
  seedTasks()
  useUIStore.setState({
    sidebarView: 'dashboard',
    activeModal: null,
    dashboardPreviewTaskId: null,
    settingsTab: SettingsTab.GENERAL,
    showOrchestrator: false,
  })
  useProjectStore.setState({ currentProjectId: 'default' })
  useArtifactStore.setState({ artifactsByTask: {}, uiByTask: {} })
})

describe('switch_project', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        { id: 'default', name: 'Default', archived: false },
        { id: 'p2', name: 'Two', archived: false },
        { id: 'p3', name: 'Gone', archived: true },
      ] as never,
      currentProjectId: 'default',
    })
  })

  afterEach(() => {
    useProjectStore.setState({ projects: [], currentProjectId: 'default' })
  })

  it('shows the project, and leaves the Commander view for the dashboard', () => {
    useUIStore.getState().setSidebarView('commander')
    expect(applyUiCommand({ kind: 'switch_project', projectId: 'p2' })).toEqual({ applied: true })
    expect(useProjectStore.getState().currentProjectId).toBe('p2')
    expect(useUIStore.getState().sidebarView).toBe('dashboard')
  })

  it('keeps a project view where it is', () => {
    useUIStore.getState().setSidebarView('skills')
    applyUiCommand({ kind: 'switch_project', projectId: 'p2' })
    expect(useUIStore.getState().sidebarView).toBe('skills')
  })

  it('refuses an unknown or archived project', () => {
    expect(applyUiCommand({ kind: 'switch_project', projectId: 'nope' }).applied).toBe(false)
    expect(applyUiCommand({ kind: 'switch_project', projectId: 'p3' }).applied).toBe(false)
    expect(useProjectStore.getState().currentProjectId).toBe('default')
  })
})

describe('navigate', () => {
  it('switches view', () => {
    expect(applyUiCommand({ kind: 'navigate', view: 'skills' })).toEqual({ applied: true })
    expect(useUIStore.getState().sidebarView).toBe('skills')
  })

  it('leaves settings behind — it covers the workspace', () => {
    useUIStore.getState().openSettings()
    applyUiCommand({ kind: 'navigate', view: 'tasks' })
    expect(useUIStore.getState().activeModal).toBeNull()
    expect(useUIStore.getState().sidebarView).toBe('tasks')
  })

  it('opens settings on the tab that was asked for, and ignores one that does not exist', () => {
    applyUiCommand({ kind: 'navigate', view: 'settings', settingsTab: 'voice' })
    expect(useUIStore.getState().activeModal).toBe('settings')
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)

    applyUiCommand({ kind: 'navigate', view: 'settings', settingsTab: 'not-a-tab' })
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.VOICE)
  })
})

describe('open_task', () => {
  it('opens the full view and closes the dashboard dialog', () => {
    useUIStore.getState().openDashboardPreview('t2')
    applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'workspace' })
    const ui = useUIStore.getState()
    expect(ui.sidebarView).toBe('tasks')
    expect(ui.dashboardPreviewTaskId).toBeNull()
    expect(useTaskStore.getState().selectedTaskId).toBe('t1')
  })

  it('opens the dashboard dialog', () => {
    applyUiCommand({ kind: 'open_task', taskId: 't1', where: 'modal' })
    expect(useUIStore.getState().dashboardPreviewTaskId).toBe('t1')
    expect(useUIStore.getState().sidebarView).toBe('dashboard')
  })

  it('refuses a task the window does not have', () => {
    expect(applyUiCommand({ kind: 'open_task', taskId: 'ghost', where: 'workspace' })).toEqual({
      applied: false,
      detail: 'That task is not loaded',
    })
  })
})

describe('open_artifact', () => {
  beforeEach(() => {
    useArtifactStore.getState().upsertArtifact({
      taskId: 't1',
      type: ArtifactType.MARKDOWN,
      title: 'Design',
      path: 'artifacts/art-1/design.md',
      workpieceKey: 'art-1',
      updatedAt: 1,
    } as never)
  })

  it('opens the tab named by the registry ID, not by the tab ID', () => {
    // The caller knows `art-1`; the tab is keyed on the task and the workpiece.
    expect(applyUiCommand({ kind: 'open_artifact', taskId: 't1', artifactId: 'art-1' })).toEqual({ applied: true })
    const ui = useArtifactStore.getState().getUI('t1')
    expect(ui.open).toBe(true)
    expect(ui.activeTabId).toBe(useArtifactStore.getState().getArtifacts('t1')[0].id)
    expect(useTaskStore.getState().selectedTaskId).toBe('t1')
    expect(useUIStore.getState().sidebarView).toBe('tasks')
  })

  it('says so when the artifact has not reached the window yet', () => {
    expect(applyUiCommand({ kind: 'open_artifact', taskId: 't1', artifactId: 'art-9' })).toEqual({
      applied: false,
      detail: 'That artifact is not on screen yet',
    })
  })
})

describe('collectUiState', () => {
  it('reports the open task and the screen it is on', () => {
    useTaskStore.getState().selectTask('t1')
    useUIStore.getState().setSidebarView('tasks')
    const state = collectUiState()
    expect(state).toMatchObject({ view: 'tasks', selectedTaskId: 't1', selectedTaskTitle: 'Fix login' })
    expect(state).not.toHaveProperty('canvas')
  })
})
