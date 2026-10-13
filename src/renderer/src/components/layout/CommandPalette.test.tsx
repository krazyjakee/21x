import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'

// Stores subscribe to IPC events at import time; every export is a no-op here.
vi.mock('@/lib/ipc-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.keys(actual).map((key) => [key, new Proxy(() => () => undefined, { get: () => vi.fn() })]))
})

import { useUIStore } from '@/stores/ui-store'
import { useSkillStore } from '@/stores/skill-store'
import { modKey } from '@/lib/platform'
import { CommandPalette, type CommandPaletteActions } from './CommandPalette'
import { useGlobalShortcuts } from './hooks/use-global-shortcuts'
import { NAV_ITEMS, navShortcutDigit } from './nav-items'
import { useTaskStore } from '@/stores/task-store'
import { useProjectStore } from '@/stores/project-store'
import { DEFAULT_PROJECT_ID } from '@shared/projects'
import { TaskStatus, type Task } from '@/types'

const actions = new Proxy({}, { get: () => vi.fn() }) as CommandPaletteActions

beforeEach(() => {
  useTaskStore.setState({ tasks: [], selectedTaskId: null })
  useProjectStore.setState({ currentProjectId: DEFAULT_PROJECT_ID })
  useSkillStore.setState({ fetchSkills: vi.fn(async () => undefined), skills: [] } as never)
  useUIStore.setState({ sidebarView: 'dashboard', activeModal: null })
})

describe('task search', () => {
  it('shares description/label matching and opens a subtask while excluding other projects and Captains', () => {
    const task = (id: string, overrides: Partial<Task>): Task => ({
      id, title: id, description: '', labels: [], status: TaskStatus.Completed,
      project_id: DEFAULT_PROJECT_ID, ...overrides
    } as Task)
    useTaskStore.setState({ tasks: [
      task('description-result', { description: 'INVOICE received', parent_task_id: 'parent' }),
      task('label-result', { labels: ['Invoice'] }),
      task('foreign-result', { title: 'Invoice in another project', project_id: 'other' }),
      task('captain-result', { title: 'Invoice Captain', role: 'captain' })
    ] })
    const onOpenChange = vi.fn()
    render(<CommandPalette open onOpenChange={onOpenChange} actions={actions} />)
    fireEvent.change(screen.getByPlaceholderText(/run a command/), { target: { value: '  invoice  ' } })
    expect(screen.getByRole('button', { name: 'label-result' })).toBeInTheDocument()
    expect(screen.queryByText('Invoice in another project')).toBeNull()
    expect(screen.queryByText('Invoice Captain')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'description-result' }))
    expect(useTaskStore.getState().selectedTaskId).toBe('description-result')
    expect(useUIStore.getState().sidebarView).toBe('tasks')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
afterEach(cleanup)

describe('Commander navigation', () => {
  it('keeps Mod+1–4 on the existing views and puts Commander on Mod+5', () => {
    expect(NAV_ITEMS.slice(0, 4).map((item) => item.key)).toEqual(['dashboard', 'canvas', 'tasks', 'skills'])
    expect(navShortcutDigit('commander')).toBe(5)
  })

  it.each([
    ['1', 'dashboard'],
    ['4', 'skills'],
    ['5', 'commander']
  ])('Mod+%s opens %s', (digit, view) => {
    renderHook(() => useGlobalShortcuts(actions, vi.fn()))
    fireEvent.keyDown(window, { key: digit, ctrlKey: true })
    expect(useUIStore.getState().sidebarView).toBe(view)
  })

  it('lists "Go to Commander" with its shortcut and opens Commander', () => {
    const onOpenChange = vi.fn()
    render(<CommandPalette open onOpenChange={onOpenChange} actions={actions} />)
    fireEvent.change(screen.getByPlaceholderText(/run a command/), { target: { value: 'commander' } })
    const entry = screen.getByRole('button', { name: /Go to Commander/ })
    expect(entry.textContent).toContain(`${modKey}5`)
    fireEvent.click(entry)
    expect(useUIStore.getState().sidebarView).toBe('commander')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
