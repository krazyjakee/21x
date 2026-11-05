import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentDeleteDialog } from './AgentDeleteDialog'
import { agentApi } from '@/lib/ipc-client'
import type { AgentDeletionImpact } from '@shared/agent-deletion'
import type { Agent } from '@/types'

const empty = { total: 0, items: [] }
const impact = (fields: Partial<AgentDeletionImpact> = {}): AgentDeletionImpact => ({
  agent_id: 'a1', agent_name: 'Fable', running: empty, queued: empty, unassigned_tasks: empty, recurring_tasks: empty, recurring_auto_start: 0,
  dissolved_groups: empty, fallback_agents: empty, captain_projects: empty, default_projects: empty, concurrency_projects: empty,
  commander_cleared: false, was_default: false, replacement_default: null, last_agent: false, ...fields
})
const agent = { id: 'a1', name: 'Fable' } as Agent
const running = { total: 1, items: [{ id: 't1', title: 'Build' }] }

describe('AgentDeleteDialog', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('deletes straight away when nothing is touched, saying other agents are safe', async () => {
    vi.spyOn(agentApi, 'deletionImpact').mockResolvedValue(impact())
    const remove = vi.spyOn(agentApi, 'delete').mockResolvedValue(impact()), onClose = vi.fn()
    render(<AgentDeleteDialog agent={agent} onClose={onClose} />)
    expect(await screen.findByText(/Other agents are not affected/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(remove).toHaveBeenCalledWith('a1')
  })

  it('says what will stop before acting, then shows what really happened', async () => {
    vi.spyOn(agentApi, 'deletionImpact').mockResolvedValue(impact({ running }))
    vi.spyOn(agentApi, 'delete').mockResolvedValue(impact({ running }))
    const onClose = vi.fn()
    render(<AgentDeleteDialog agent={agent} onClose={onClose} />)
    expect(await screen.findByText(/1 running session of this agent: “Build”/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop and delete' }))
    expect(await screen.findByText('“Fable” was deleted')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the named refusal and lets the user try again', async () => {
    vi.spyOn(agentApi, 'deletionImpact').mockResolvedValue(impact())
    vi.spyOn(agentApi, 'delete').mockResolvedValue({ refused: 'The agent was not deleted because the app is shutting down.' })
    render(<AgentDeleteDialog agent={agent} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete agent' }))
    expect((await screen.findByRole('alert')).textContent).toContain('the app is shutting down')
    expect(screen.getByRole('button', { name: 'Delete agent' })).toBeTruthy()
  })

  it('never deletes blind: an unreadable impact offers a retry, not a delete', async () => {
    vi.spyOn(agentApi, 'deletionImpact').mockRejectedValue(new Error('offline'))
    const remove = vi.spyOn(agentApi, 'delete')
    render(<AgentDeleteDialog agent={agent} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(remove).not.toHaveBeenCalled()
  })
})
