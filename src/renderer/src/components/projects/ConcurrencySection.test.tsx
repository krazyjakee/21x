import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { concurrencyApi } from '@/lib/ipc-client'
import { ConcurrencySection } from './ConcurrencySection'
import type { ProjectConcurrencyState } from '@shared/concurrency'

vi.mock('@/lib/ipc-client', () => ({ concurrencyApi: {
  getState: vi.fn(), setCaptainControl: vi.fn(), pin: vi.fn(), onChanged: vi.fn(() => () => {})
} }))
const state: ProjectConcurrencyState = {
  projectId: 'alpha', captainControl: true, pressure: null,
  agents: [{ agentId: 'builder', agentName: 'Builder', cap: 5, level: 2, source: 'captain',
    runningInProject: 1, runningTotal: 3, queuedInProject: 4, recommendation: { level: 5, why: 'independent work' } }],
  recentChanges: [{ id: 'change', project_id: 'alpha', agent_id: 'builder', kind: 'level',
    previous_level: 1, level: 2, cap: 5, actor: 'captain', reason: 'independent work', created_at: new Date().toISOString() }]
}
beforeEach(() => {
  vi.mocked(concurrencyApi.getState).mockResolvedValue(state)
  vi.mocked(concurrencyApi.pin).mockResolvedValue({ success: true })
  vi.mocked(concurrencyApi.setCaptainControl).mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('shows cap, working level, counts and audit; pins only within the cap', async () => {
  render(<ConcurrencySection projectId="alpha" />)
  const pin = await screen.findByRole('combobox', { name: 'Pin the level of Builder' })
  expect([...pin.querySelectorAll('option')].map((option) => option.value)).toEqual(['', '1', '2', '3', '4', '5'])
  expect(screen.getByText('set by the Captain')).toBeInTheDocument()
  expect(screen.getByTitle('3 across all projects')).toHaveTextContent('1')
  expect(screen.getByText(/independent work/)).toBeInTheDocument()
  fireEvent.change(pin, { target: { value: '3' } })
  await waitFor(() => expect(concurrencyApi.pin).toHaveBeenCalledWith('alpha', 'builder', 3))
  fireEvent.click(screen.getByRole('switch', { name: 'Captain controls concurrency' }))
  await waitFor(() => expect(concurrencyApi.setCaptainControl).toHaveBeenCalledWith('alpha', false))
})

it('reports a rejected settings write without an unhandled rejection', async () => {
  vi.mocked(concurrencyApi.pin).mockRejectedValue(new Error('Disconnected'))
  render(<ConcurrencySection projectId="alpha" />)
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: '3' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('Disconnected')
})
