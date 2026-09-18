import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useProjectStore, activeProjects, filterToProject, CURRENT_PROJECT_SETTING } from './project-store'
import { useTaskStore } from './task-store'
import { useTaskSourceStore } from './task-source-store'
import { useUIStore } from './ui-store'
import { useProjectTasks, useProjectTaskSources } from '@/hooks/use-project-tasks'
import { useTasks } from '@/hooks/use-tasks'
import { DEFAULT_PROJECT_ID, type ProjectRecord } from '@shared/projects'
import type { Task, TaskSource, CreateTaskDTO, CreateTaskSourceDTO } from '@/types'

const api = window.electronAPI as unknown as Record<string, Record<string, Mock>> & {
  projects: Record<string, Mock>
}

function project(id: string, name: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id, name, description: '', default_agent_id: null, mastermind_agent_id: null,
    git_provider: null, git_org: null, settings: {}, sort_order: 0, archived: false,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...extra
  }
}

function task(id: string, projectId: string | undefined, extra: Partial<Task> = {}): Task {
  return {
    id, title: id, description: '', labels: [], repos: [], attachments: [], output_fields: [],
    status: 'not_started', priority: 'medium', parent_task_id: null, project_id: projectId,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...extra
  } as unknown as Task
}

const P1 = project(DEFAULT_PROJECT_ID, 'Default', { sort_order: 0 })
const P2 = project('p2', 'Website', { sort_order: 1 })
const P3 = project('p3', 'Old', { sort_order: 2, archived: true })

beforeEach(() => {
  vi.clearAllMocks()
  ;(window.electronAPI as unknown as Record<string, unknown>).projects = {
    getAll: vi.fn().mockResolvedValue([P1, P2, P3]),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    reorder: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn()
  }
  useProjectStore.setState({ projects: [P1, P2, P3], currentProjectId: DEFAULT_PROJECT_ID, isLoaded: true, error: null })
  useTaskStore.setState({
    tasks: [
      task('d1', DEFAULT_PROJECT_ID),
      task('legacy', undefined), // written before projects: belongs to Default
      task('w1', 'p2'),
      task('w2', 'p2', { status: 'ready_for_review' as Task['status'] })
    ],
    selectedTaskId: null,
    isLoading: false,
    error: null
  })
  useTaskSourceStore.setState({
    sources: [
      { id: 's1', name: 'Linear', enabled: true, project_id: DEFAULT_PROJECT_ID } as TaskSource,
      { id: 's2', name: 'GitHub', enabled: true, project_id: 'p2' } as TaskSource
    ]
  })
  useUIStore.setState({
    sourceFilter: 'all', statusFilter: 'all', priorityFilter: 'all', searchQuery: '',
    dashboardPreviewTaskId: null, projectSwitcherOpen: false, projectEditorTarget: null
  })
})

describe('current project scoping', () => {
  it('task views show only the current project, and switching changes them with no leak', () => {
    const { result } = renderHook(() => useProjectTasks())
    expect(result.current.map((t) => t.id).sort()).toEqual(['d1', 'legacy'])

    act(() => useProjectStore.getState().setCurrentProject('p2'))
    expect(result.current.map((t) => t.id).sort()).toEqual(['w1', 'w2'])

    act(() => useProjectStore.getState().setCurrentProject(DEFAULT_PROJECT_ID))
    expect(result.current.map((t) => t.id).sort()).toEqual(['d1', 'legacy'])
  })

  it('useTasks (list, sidebar filters, search) is scoped; everyTask keeps all projects for notifications', () => {
    useUIStore.setState({ searchQuery: 'w' })
    // useTasks fetches on mount; answer with the same rows so the fetch does not empty the store.
    api.db.getTasks.mockResolvedValue(useTaskStore.getState().tasks)
    const { result } = renderHook(() => useTasks())
    // Default has no task matching "w": the Website tasks must not leak in.
    expect(result.current.tasks).toEqual([])
    expect(result.current.everyTask).toHaveLength(4)

    act(() => useProjectStore.getState().setCurrentProject('p2'))
    expect(result.current.tasks.map((t) => t.id).sort()).toEqual(['w1', 'w2'])
    expect(result.current.allTasks.map((t) => t.id).sort()).toEqual(['w1', 'w2'])
  })

  it('task sources are scoped too', () => {
    const { result } = renderHook(() => useProjectTaskSources())
    expect(result.current.map((s) => s.id)).toEqual(['s1'])
    act(() => useProjectStore.getState().setCurrentProject('p2'))
    expect(result.current.map((s) => s.id)).toEqual(['s2'])
  })

  it('switching clears a selection, source filter and preview from the old project', () => {
    useTaskStore.setState({ selectedTaskId: 'd1' })
    useUIStore.setState({ sourceFilter: 's1', dashboardPreviewTaskId: 'd1' })

    useProjectStore.getState().setCurrentProject('p2')

    expect(useTaskStore.getState().selectedTaskId).toBeNull()
    expect(useUIStore.getState().sourceFilter).toBe('all')
    expect(useUIStore.getState().dashboardPreviewTaskId).toBeNull()
  })

  it('persists the selection', () => {
    useProjectStore.getState().setCurrentProject('p2')
    expect(api.settings.set).toHaveBeenCalledWith(CURRENT_PROJECT_SETTING, 'p2')
  })

  it('selecting a task from another project switches to it', () => {
    useTaskStore.getState().selectTask('w1')
    expect(useProjectStore.getState().currentProjectId).toBe('p2')
    expect(useTaskStore.getState().selectedTaskId).toBe('w1')
  })

  it('a task created elsewhere only shows up in its own project', () => {
    const { result } = renderHook(() => useProjectTasks())
    act(() => {
      useTaskStore.setState((s) => ({ tasks: [task('w3', 'p2'), ...s.tasks] }))
    })
    expect(result.current.map((t) => t.id)).not.toContain('w3')
  })
})

describe('init', () => {
  it('restores the persisted project', async () => {
    useProjectStore.setState({ projects: [], currentProjectId: DEFAULT_PROJECT_ID, isLoaded: false })
    api.settings.get.mockResolvedValueOnce('p2')
    await useProjectStore.getState().init()
    expect(useProjectStore.getState().currentProjectId).toBe('p2')
    expect(useProjectStore.getState().isLoaded).toBe(true)
  })

  it('falls back to Default when the stored project is archived or gone', async () => {
    useProjectStore.setState({ projects: [], currentProjectId: DEFAULT_PROJECT_ID, isLoaded: false })
    api.settings.get.mockResolvedValueOnce('p3')
    await useProjectStore.getState().init()
    expect(useProjectStore.getState().currentProjectId).toBe(DEFAULT_PROJECT_ID)

    api.settings.get.mockResolvedValueOnce('deleted')
    await useProjectStore.getState().init()
    expect(useProjectStore.getState().currentProjectId).toBe(DEFAULT_PROJECT_ID)
  })
})

describe('new tasks and sources', () => {
  it('a new task gets the current project', async () => {
    useProjectStore.getState().setCurrentProject('p2')
    api.db.createTask.mockResolvedValue(task('new', 'p2'))
    await useTaskStore.getState().createTask({ title: 'new' } as CreateTaskDTO)
    expect(api.db.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'new', project_id: 'p2' }))
  })

  it('an explicit project, or a subtask, is left to the caller / main process', async () => {
    useProjectStore.getState().setCurrentProject('p2')
    api.db.createTask.mockResolvedValue(task('x', DEFAULT_PROJECT_ID))
    await useTaskStore.getState().createTask({ title: 'x', project_id: DEFAULT_PROJECT_ID } as CreateTaskDTO)
    expect(api.db.createTask).toHaveBeenLastCalledWith(expect.objectContaining({ project_id: DEFAULT_PROJECT_ID }))

    await useTaskStore.getState().createTask({ title: 'sub', parent_task_id: 'd1' } as CreateTaskDTO)
    expect(api.db.createTask.mock.lastCall?.[0]).not.toHaveProperty('project_id')
  })

  it('a new task source belongs to the current project', async () => {
    useProjectStore.getState().setCurrentProject('p2')
    api.taskSources.create.mockResolvedValue({ id: 's3', project_id: 'p2' })
    await useTaskSourceStore.getState().createSource({ mcp_server_id: null, name: 'N', plugin_id: 'notion' } as CreateTaskSourceDTO)
    expect(api.taskSources.create).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p2' }))
  })

  it('sync all only syncs the current project\'s sources', async () => {
    api.taskSources.sync.mockResolvedValue({ source_id: 's1', imported: 0, updated: 0, errors: [] })
    await useTaskSourceStore.getState().syncAllEnabled()
    expect(api.taskSources.sync).toHaveBeenCalledTimes(1)
    expect(api.taskSources.sync).toHaveBeenCalledWith('s1')
  })
})

describe('moveTaskToProject', () => {
  it('moves a task with its subtasks out of the current project', async () => {
    useTaskStore.setState((s) => ({ tasks: [...s.tasks, task('d1-sub', DEFAULT_PROJECT_ID, { parent_task_id: 'd1' })] }))
    api.projects.moveTask.mockResolvedValue([task('d1', 'p2'), task('d1-sub', 'p2', { parent_task_id: 'd1' })])

    const { result } = renderHook(() => useProjectTasks())
    let ok = false
    await act(async () => { ok = await useTaskStore.getState().moveTaskToProject('d1', 'p2') })

    expect(ok).toBe(true)
    expect(api.projects.moveTask).toHaveBeenCalledWith('d1', 'p2')
    expect(result.current.map((t) => t.id)).toEqual(['legacy'])
    expect(filterToProject(useTaskStore.getState().tasks, 'p2').map((t) => t.id).sort()).toEqual(['d1', 'd1-sub', 'w1', 'w2'])
  })

  it('reports a refused move', async () => {
    api.projects.moveTask.mockResolvedValue(null)
    expect(await useTaskStore.getState().moveTaskToProject('d1', 'p2')).toBe(false)
    expect(useTaskStore.getState().tasks.find((t) => t.id === 'd1')?.project_id).toBe(DEFAULT_PROJECT_ID)
  })
})

describe('archive', () => {
  it('archived projects are not offered by the switcher', () => {
    expect(activeProjects(useProjectStore.getState().projects).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'p2'])
  })

  it('archiving the current project hides it and falls back to Default', async () => {
    useProjectStore.getState().setCurrentProject('p2')
    api.projects.archive.mockResolvedValue({ ...P2, archived: true })

    await useProjectStore.getState().archiveProject('p2')

    expect(activeProjects(useProjectStore.getState().projects).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
    expect(useProjectStore.getState().currentProjectId).toBe(DEFAULT_PROJECT_ID)
  })

  it('restoring brings it back', async () => {
    api.projects.archive.mockResolvedValue({ ...P3, archived: false })
    await useProjectStore.getState().archiveProject('p3', false)
    expect(activeProjects(useProjectStore.getState().projects).map((p) => p.id)).toContain('p3')
  })
})

describe('reorder', () => {
  it('reorders optimistically and persists', async () => {
    await useProjectStore.getState().reorderProjects(['p2', DEFAULT_PROJECT_ID])
    expect(activeProjects(useProjectStore.getState().projects).map((p) => p.id)).toEqual(['p2', DEFAULT_PROJECT_ID])
    expect(api.projects.reorder).toHaveBeenCalledWith(['p2', DEFAULT_PROJECT_ID])
  })
})
