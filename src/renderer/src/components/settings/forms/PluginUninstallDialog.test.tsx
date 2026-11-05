import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PluginUninstallDialog } from './PluginUninstallDialog'
import { agentApi, claudePluginApi } from '@/lib/ipc-client'
import type { AgentDeletionImpact } from '@shared/agent-deletion'
import type { PluginResources } from '@/types'

const empty = { total: 0, items: [] }
const impact = (agent_name: string, fields: Partial<AgentDeletionImpact> = {}): AgentDeletionImpact => ({
  agent_id: agent_name, agent_name, running: empty, queued: empty, unassigned_tasks: empty, recurring_tasks: empty, recurring_auto_start: 0,
  dissolved_groups: empty, fallback_agents: empty, captain_projects: empty, default_projects: empty, concurrency_projects: empty,
  commander_cleared: false, was_default: false, replacement_default: null, last_agent: false, ...fields
})
const running = { total: 1, items: [{ id: 't1', title: 'Build' }] }
const plugin = { id: 'p1', name: 'Reviewer pack' }
const owns = (...ids: string[]) => vi.spyOn(claudePluginApi, 'getPluginResources')
  .mockResolvedValue({ skills: [], mcpServers: [], commands: [], agents: ids.map((id) => ({ id, name: id, description: '' })) } as PluginResources)

describe('PluginUninstallDialog', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('says what will stop before anything happens, then shows what did', async () => {
    owns('A')
    vi.spyOn(agentApi, 'deletionImpact').mockResolvedValue(impact('A', { running }))
    const uninstall = vi.spyOn(claudePluginApi, 'uninstallPlugin').mockResolvedValue([impact('A', { running })])
    render(<PluginUninstallDialog plugin={plugin} onClose={vi.fn()} />)
    expect(await screen.findByText(/1 running session of this agent: “Build”/)).toBeTruthy()
    expect(uninstall).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop and remove' }))
    expect(await screen.findByText('“Reviewer pack” was removed')).toBeTruthy()
    expect(uninstall).toHaveBeenCalledExactlyOnceWith('p1')
  })

  it('says whose work it is when a plugin has several agents', async () => {
    owns('A', 'B')
    vi.spyOn(agentApi, 'deletionImpact').mockImplementation(async (id) => impact(id, id === 'B' ? { running } : {}))
    render(<PluginUninstallDialog plugin={plugin} onClose={vi.fn()} />)
    expect(await screen.findByText(/^B: 1 running session/)).toBeTruthy()
  })

  it('never promises that other agents are safe', async () => {
    owns('A')
    vi.spyOn(agentApi, 'deletionImpact').mockResolvedValue(impact('A'))
    render(<PluginUninstallDialog plugin={plugin} onClose={vi.fn()} />)
    await screen.findByText('None of this plugin’s agents are running anything.')
    expect(screen.queryByText(/Other agents/)).toBeNull()
  })

  it('closes quietly when nothing was stopped or changed', async () => {
    owns()
    vi.spyOn(claudePluginApi, 'uninstallPlugin').mockResolvedValue([])
    const onClose = vi.fn()
    render(<PluginUninstallDialog plugin={plugin} onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove plugin' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('keeps the named refusal and leaves the plugin listed', async () => {
    owns('A')
    vi.spyOn(agentApi, 'deletionImpact').mockResolvedValue(impact('A'))
    vi.spyOn(claudePluginApi, 'uninstallPlugin').mockResolvedValue({ refused: 'Not deleted. Already done: 2 sessions stopped.' })
    const view = render(<PluginUninstallDialog plugin={plugin} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove plugin' }))
    await screen.findByRole('alert')
    view.rerender(<PluginUninstallDialog plugin={plugin} onClose={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toContain('2 sessions stopped')
  })
})
