import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentsSettings } from './AgentsSettings'
import { useAgentStore } from '@/stores/agent-store'

const confirmed = vi.fn(() => true)
const AGENTS = [{ id: 'a1', name: 'Astra', is_default: false, server_url: '', config: { coding_agent: 'codex' } }]

describe('AgentsSettings deletion', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', confirmed)
    confirmed.mockReturnValue(true)
    useAgentStore.setState({ agents: AGENTS as never, error: null, fetchAgents: vi.fn(async () => undefined) as never })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  async function remove(): Promise<void> {
    await act(async () => { render(<AgentsSettings />) })
    await act(async () => { fireEvent.click(screen.getByLabelText('Delete Astra')) })
  }

  it('says why when an agent could not be deleted', async () => {
    useAgentStore.setState({ deleteAgent: vi.fn(async () => {
      useAgentStore.setState({ error: "Error: Error invoking remote method 'agent:delete': Error: Stop other agents using this backend first." })
      return false
    }) as never })
    await remove()
    expect(screen.getByRole('alert')).toHaveTextContent(/^Stop other agents using this backend first\.$/)
  })

  it('never fails in silence, even with no reason to give', async () => {
    useAgentStore.setState({ deleteAgent: vi.fn(async () => false) as never })
    await remove()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not delete this agent.')
  })

  it('shows nothing once the agent is gone', async () => {
    useAgentStore.setState({ deleteAgent: vi.fn(async () => true) as never })
    await remove()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does nothing if the user changes their mind', async () => {
    confirmed.mockReturnValue(false)
    const deleteAgent = vi.fn(async () => true)
    useAgentStore.setState({ deleteAgent: deleteAgent as never })
    await remove()
    expect(deleteAgent).not.toHaveBeenCalled()
  })
})
