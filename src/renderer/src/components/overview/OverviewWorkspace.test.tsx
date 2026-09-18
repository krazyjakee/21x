import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ProjectOverviewEntry } from '@shared/project-overview'

const api = vi.hoisted(() => ({
  overviewApi: { getAllStatuses: vi.fn() },
  projectApi: { onStatusChanged: vi.fn(() => () => {}), onChanged: vi.fn(() => () => {}) },
  escalationApi: { onHeldChanged: vi.fn(() => () => {}) },
  settingsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
  onTaskUpdated: vi.fn(() => () => {}),
  onTaskCreated: vi.fn(() => () => {}),
  onTaskDeleted: vi.fn(() => () => {}),
  onAgentStatus: vi.fn(() => () => {}),
  onAgentStartQueueChanged: vi.fn(() => () => {})
}))
vi.mock('@/lib/ipc-client', () => api)

import { OverviewWorkspace } from './OverviewWorkspace'
import { resetOverviewStoreForTests } from '@/stores/overview-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { DEFAULT_PROJECT_ID } from '@shared/projects'

function entry(over: Partial<ProjectOverviewEntry> = {}): ProjectOverviewEntry {
  const counts = { running: 0, queued: 0, awaiting_review: 0, awaiting_approval: 0, blocked: 0, ...(over.status?.counts ?? {}) }
  return {
    project_id: 'p1',
    name: 'Website',
    brief: '',
    is_default: false,
    sort_order: 1,
    pending_approvals: 0,
    held_actions: 0,
    running_agents: 0,
    paused: false,
    all_projects_paused: false,
    blocked_by: null,
    last_activity_at: null,
    needs_attention: false,
    ...over,
    status: { project_id: over.project_id ?? 'p1', summary: '', top_blockers: [], updated_at: null, ...(over.status ?? {}), counts }
  }
}

beforeEach(() => {
  resetOverviewStoreForTests()
  useProjectStore.setState({ currentProjectId: DEFAULT_PROJECT_ID, projects: [], isLoaded: true, error: null })
  useUIStore.setState({ sidebarView: 'overview' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('OverviewWorkspace', () => {
  it('renders one card per project with the summary, counts and live facts', async () => {
    api.overviewApi.getAllStatuses.mockResolvedValue([
      entry({
        project_id: DEFAULT_PROJECT_ID, name: 'Default', is_default: true, sort_order: 0,
        status: { summary: 'Two features in flight.', counts: { running: 2, queued: 1 } } as never,
        running_agents: 2, last_activity_at: new Date(Date.now() - 5 * 60_000).toISOString()
      }),
      entry({ project_id: 'p1', name: 'Website', paused: true, blocked_by: 'project_paused' })
    ])

    render(<OverviewWorkspace />)

    const cards = await screen.findAllByTestId('project-overview-card')
    expect(cards).toHaveLength(2)
    const first = within(cards[0])
    expect(first.getByText('Default')).toBeInTheDocument()
    expect(first.getByText('Two features in flight.')).toBeInTheDocument()
    expect(first.getByText('2 agents')).toBeInTheDocument()
    expect(first.getByText('5m ago')).toBeInTheDocument()
    expect(first.getByText('Current')).toBeInTheDocument()
    const second = within(cards[1])
    expect(second.getByText('Website')).toBeInTheDocument()
    expect(second.getByText('Nothing in flight')).toBeInTheDocument()
    expect(second.getByText('Paused')).toBeInTheDocument()
    expect(second.getByText('No activity yet')).toBeInTheDocument()
    expect(screen.getByText('Nothing is waiting on you.')).toBeInTheDocument()
  })

  it('highlights projects that wait on the user and lists them first', async () => {
    api.overviewApi.getAllStatuses.mockResolvedValue([
      entry({ project_id: 'a', name: 'Quiet', sort_order: 0 }),
      entry({
        project_id: 'b', name: 'Loud', sort_order: 1, needs_attention: true,
        pending_approvals: 1, held_actions: 2, status: { counts: { awaiting_review: 3 } } as never
      })
    ])

    render(<OverviewWorkspace />)

    const cards = await screen.findAllByTestId('project-overview-card')
    expect(cards[0]).toHaveAttribute('data-project-id', 'b')
    expect(cards[0]).toHaveAttribute('data-attention', 'true')
    expect(cards[1]).toHaveAttribute('data-attention', 'false')
    expect(within(cards[0]).getByText('Needs you')).toBeInTheDocument()
    expect(within(cards[0]).getByText('1 awaiting approval · 2 held Mastermind calls · 3 to review')).toBeInTheDocument()
    expect(within(cards[1]).queryByText('Needs you')).not.toBeInTheDocument()
    expect(screen.getByText('1 project needs your input.')).toBeInTheDocument()
  })

  it('switches the current project and opens the dashboard when a card is clicked', async () => {
    api.overviewApi.getAllStatuses.mockResolvedValue([entry({ project_id: 'p1', name: 'Website' })])

    render(<OverviewWorkspace />)

    fireEvent.click(await screen.findByTestId('project-overview-card'))

    expect(useProjectStore.getState().currentProjectId).toBe('p1')
    expect(useUIStore.getState().sidebarView).toBe('dashboard')
  })

  it('shows the global pause banner and an error when the load fails', async () => {
    api.overviewApi.getAllStatuses.mockResolvedValueOnce([entry({ all_projects_paused: true })])

    render(<OverviewWorkspace />)

    expect(await screen.findByRole('status')).toHaveTextContent('All projects are paused')

    api.overviewApi.getAllStatuses.mockRejectedValueOnce(new Error('bridge down'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' })) })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('bridge down'))
  })
})
