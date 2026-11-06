import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '@/stores/agent-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import type { Task } from '@/types'
import { TaskDialogs } from './TaskDialogs'

vi.mock('@/components/tasks/TaskWorkspace', () => ({ TaskWorkspace: () => null }))

afterEach(cleanup)

describe('deleting a task on the Electron host', () => {
  it('states that the user asked for the whole workspace to go', async () => {
    const deleteTask = vi.fn(async () => true)
    useTaskStore.setState({ tasks: [{ id: 'task-1', title: 'Fixture', role: 'task', status: 'completed', repos: ['org/repo'] } as unknown as Task], deleteTask })
    useAgentStore.setState({ stopAndRemoveSessionForTask: vi.fn(async () => {}) })
    vi.mocked(window.electronAPI.settings.get).mockResolvedValue('org')
    useUIStore.getState().openDeleteModal('task-1')
    render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={vi.fn()} onGoToFullView={vi.fn()} onNavigateFromPreview={vi.fn()} onAssignAgent={vi.fn()} onUpdateTask={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete Task' })) })
    await waitFor(() => expect(deleteTask).toHaveBeenCalledWith('task-1'))
    // True, not left out: the main process keeps a shared workspace for a caller with no stated choice.
    expect(vi.mocked(window.electronAPI.worktree.cleanup).mock.calls).toEqual([['task-1', [{ fullName: 'org/repo' }], 'org', true]])
  })
})
