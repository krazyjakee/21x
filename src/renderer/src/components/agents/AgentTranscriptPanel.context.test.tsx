import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_ROLLOVER_POLICY, type SessionContextSnapshot } from '@shared/session-context'
const mocks = vi.hoisted(() => ({ getSnapshot: vi.fn(), setPolicy: vi.fn() }))
vi.mock('@/lib/ipc-client', async original => ({ ...await original<typeof import('@/lib/ipc-client')>(), sessionContextApi: mocks }))
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 120, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 120, size: 120 })), scrollToIndex: vi.fn(), measureElement: vi.fn() }) }))
import { AgentTranscriptPanel } from './AgentTranscriptPanel'
import { SessionStatus } from '@/stores/agent-store'
import { useCoordinatorStore } from '@/stores/coordinator-store'

beforeEach(() => {
  vi.clearAllMocks(); useCoordinatorStore.setState({ captainTaskIds: { project: 'captain-row' } })
  mocks.getSnapshot.mockImplementation(async scope => ({ scope, generation: null, usage: { tokens: 12000, source: 'estimated', contextWindow: 20000, model: 'model', observedAt: 1 }, counters: { compactions: 0, wakeups: 0, turns: 0, ageMs: 0 }, policy: { ...DEFAULT_ROLLOVER_POLICY }, reasons: [], warnings: [], summaries: [] } satisfies SessionContextSnapshot))
})
afterEach(() => { cleanup(); useCoordinatorStore.setState({ captainTaskIds: {} }) })
describe('Captain context integration', () => {
  it('uses the authoritative Captain task identity while retaining its existing transcript and composer', async () => {
    render(<AgentTranscriptPanel taskId="captain-row" title="Captain" messages={[{ id: 'plain', role: 'assistant', content: 'Existing Captain conversation', partType: 'text', timestamp: new Date(1) }]} status={SessionStatus.IDLE} onStop={() => {}} onSend={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Captain context: ≈60%' })).toBeTruthy()
    expect(mocks.getSnapshot).toHaveBeenCalledWith({ kind: 'captain', ownerId: 'captain-row' })
    expect(screen.getByText('Existing Captain conversation')).toBeTruthy()
    const composer = screen.getByPlaceholderText('Write a message...')
    fireEvent.change(composer, { target: { value: 'Keep this Captain draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Captain context: ≈60%' }))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Captain context' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(composer).toHaveValue('Keep this Captain draft')
  })
  it('does not label a normal task as Captain or infer context from cumulative step token totals', () => {
    render(<AgentTranscriptPanel taskId="normal-task" messages={[{ id: 'step', role: 'assistant', content: 'Normal task result', timestamp: new Date(1), partType: 'text', stepMeta: { tokens: { input: 999999, output: 999999, cache: 0 } } }]} status={SessionStatus.IDLE} onStop={() => {}} />)
    expect(screen.queryByTestId('session-context-trigger')).toBeNull()
    expect(mocks.getSnapshot).not.toHaveBeenCalled()
  })
})
