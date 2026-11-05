import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentsSettings } from './AgentsSettings'
import { useAgentStore } from '@/stores/agent-store'
import { agentApi } from '@/lib/ipc-client'

const AGENTS = [{ id: 'a1', name: 'Astra', is_default: false, server_url: '', config: { coding_agent: 'codex' } }]
const empty = { total: 0, items: [] }
const IMPACT = { agent_id: 'a1', agent_name: 'Astra', running: empty, queued: empty, unassigned_tasks: empty, recurring_tasks: empty, recurring_auto_start: 0,
  dissolved_groups: empty, fallback_agents: empty, captain_projects: empty, default_projects: empty, concurrency_projects: empty,
  commander_cleared: false, was_default: false, replacement_default: null, last_agent: false }

describe('AgentsSettings deletion', () => {
  beforeEach(() => {
    vi.spyOn(agentApi, 'deletionImpact').mockResolvedValue(IMPACT)
    useAgentStore.setState({ agents: AGENTS as never, error: null, fetchAgents: vi.fn(async () => undefined) as never })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  async function open(name = 'Delete Astra'): Promise<void> {
    await act(async () => { render(<AgentsSettings />) })
    await act(async () => { fireEvent.click(screen.getByLabelText(name)) })
  }
  async function confirmDeletion(): Promise<void> {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete agent' })) })
  }

  it('offers delete on the default agent too', async () => {
    useAgentStore.setState({ agents: [{ ...AGENTS[0], is_default: true }] as never })
    await act(async () => { render(<AgentsSettings />) })
    expect(screen.getByLabelText('Delete Astra')).toBeInTheDocument()
  })

  it('says why when an agent could not be deleted', async () => {
    useAgentStore.setState({ deleteAgent: vi.fn(async () => ({ refused: 'The agent was not deleted because the app is shutting down.' })) as never })
    await open()
    await confirmDeletion()
    expect(await screen.findByRole('alert')).toHaveTextContent('The agent was not deleted because the app is shutting down.')
  })

  it('never fails in silence, even when the impact cannot be read', async () => {
    vi.spyOn(agentApi, 'deletionImpact').mockRejectedValue(new Error('offline'))
    await open()
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was deleted')
  })

  it('shows nothing once the agent is gone', async () => {
    useAgentStore.setState({ deleteAgent: vi.fn(async () => IMPACT) as never })
    await open()
    await confirmDeletion()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete agent' })).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does nothing if the user changes their mind', async () => {
    const deleteAgent = vi.fn(async () => IMPACT)
    useAgentStore.setState({ deleteAgent: deleteAgent as never })
    await open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    expect(deleteAgent).not.toHaveBeenCalled()
  })
})
