import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CommanderMessage } from '@shared/commander'
const mocks = vi.hoisted(() => ({ undoAction: vi.fn() }))
vi.mock('@/lib/ipc-client', async original => ({ ...await original<typeof import('@/lib/ipc-client')>(), commanderApi: { undoAction: mocks.undoAction } }))
import { useCommanderStore } from '@/stores/commander-store'
import { useUIStore } from '@/stores/ui-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { ActionCard } from './ActionCard'

function message(over: Partial<CommanderMessage> = {}): CommanderMessage {
  return { id: 'result', session_id: 's1', role: 'tool', content: '', tool_calls: null, tool_call_id: 'archive-1', tool_name: 'archive_project', is_error: false, project_id: null, correlation_id: null, created_at: 1, ...over }
}
const call = { id: 'archive-1', name: 'archive_project', input: { project: 'Web' } }
function result(undoId: string | null = 'undo-1') {
  return message({ content: JSON.stringify({ status: 'ok', target: { kind: 'project', id: 'web', name: 'Web' }, changes: [{ field: 'archived', before: false, after: true }], undoId }) })
}
beforeEach(() => { useCommanderStore.setState({ messages: { s1: [] }, undoingActions: [], undoneActions: [], recentAction: null }); mocks.undoAction.mockReset() })
afterEach(cleanup)
describe('executed Commander action cards', () => {
  it('shows actual changes and voice attribution, opens the target and undoes through direct IPC once', async () => {
    mocks.undoAction.mockResolvedValue({ alreadyUndone: false, message: message({ id: 'undo-note', role: 'assistant', tool_name: 'undo_action', tool_call_id: 'undo-1', content: 'Restored Web.' }) })
    render(<ActionCard call={call} result={result()} requestedBy={message({ role: 'user', input_mode: 'voice', content: 'Archive the Web project' })} />)
    expect(screen.getByText('false')).toBeTruthy(); expect(screen.getByText('true')).toBeTruthy()
    expect(screen.getByText('Heard: “Archive the Web project”')).toBeTruthy()
    expect(screen.getByTestId('commander-action-card')).toHaveAttribute('data-action-severity', 'destructive')
    expect(screen.getByText('Show tool details').closest('details')).not.toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: 'Open project' }))
    expect(useUIStore.getState().projectEditorTarget).toBe('web')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undone' })).toBeDisabled())
    expect(mocks.undoAction).toHaveBeenCalledWith('s1', 'undo-1')
    expect(mocks.undoAction).toHaveBeenCalledOnce()
  })
  it('retains legacy evidence without asserting successful execution or inventing voice attribution/Undo', () => {
    render(<ActionCard call={call} result={message({ content: 'Legacy result' })} requestedBy={message({ role: 'user', content: 'Archive Web' })} />)
    expect(screen.getByText(/Action result/)).toBeTruthy()
    expect(screen.queryByText(/Heard:/)).toBeNull()
    expect(screen.getByText("Can't be undone here")).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
  it('keeps failed tool outcomes distinct and exposes safe Undo errors instead of retrying through a model', async () => {
    const view = render(<ActionCard call={call} result={message({ is_error: true, content: 'Rejected' })} />)
    expect(screen.getByText(/Action failed/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    view.rerender(<ActionCard call={call} result={result()} />)
    mocks.undoAction.mockRejectedValue(new Error('The project changed after this action.'))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('The project changed after this action.')).toBeTruthy()
    expect(useCommanderCallUiStore.getState().notice).toMatchObject({ text: 'The project changed after this action.', assertive: true })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(useCommanderStore.getState().undoneActions).toEqual([])
  })
})
