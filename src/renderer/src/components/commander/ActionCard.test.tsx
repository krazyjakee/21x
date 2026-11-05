import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommanderActionExecution, CommanderMessage } from '@shared/commander'

const mocks = vi.hoisted(() => ({
  undoAction: vi.fn(async () => ({ status: 'undone' }))
}))

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ipc-client')>(),
  commanderApi: { undoAction: mocks.undoAction }
}))

import { ActionCard } from './ActionCard'
import { collectCommanderActions } from './commander-actions'

function message(over: Partial<CommanderMessage>): CommanderMessage {
  return {
    id: `m-${Math.random()}`,
    session_id: 's1',
    role: 'user',
    content: '',
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    is_error: false,
    project_id: null,
    correlation_id: null,
    input_mode: null,
    created_at: 1_700_000_000_000,
    ...over
  }
}

function structuredResult(name = 'archive_project'): { messages: CommanderMessage[]; actions: CommanderActionExecution[] } {
  const result = {
    status: 'ok' as const,
    result: { id: 'web' },
    target: { kind: 'project' as const, id: 'web', name: 'Web' },
    changes: [{ field: 'status', before: 'active', after: 'archived' }]
  }
  return {
    messages: [
    message({ id: 'user', role: 'user', content: 'archive the web project', input_mode: 'voice' }),
    message({
      id: 'assistant', role: 'assistant',
      tool_calls: [{ id: 'call-1', execution_id: 'exec-1', name, input: { project: 'Web' } }]
    }),
    message({
      id: 'result', role: 'tool', tool_call_id: 'call-1', tool_name: name,
      content: JSON.stringify(result)
    })
    ],
    actions: [{
      execution_id: 'exec-1', session_id: 's1', turn_id: 'turn-1', request_message_id: 'user',
      provider_call_id: 'call-1', tool_name: name, input: { project: 'Web' }, result,
      undone_at: null, undo_message_id: null, created_at: 1_700_000_000_002
    }]
  }
}

beforeEach(() => mocks.undoAction.mockClear())

describe('Commander action records', () => {
  it('requires a persisted successful tool result, never assistant claims alone', () => {
    const { messages, actions } = structuredResult()
    expect(collectCommanderActions(messages, [])).toEqual([])
    expect(collectCommanderActions(messages, actions)).toHaveLength(1)
  })

  it('rejects ambiguous legacy transcript records without durable execution identity', () => {
    const { messages } = structuredResult('update_project')
    expect(collectCommanderActions(messages.map((entry) => entry.role === 'assistant'
      ? { ...entry, tool_calls: entry.tool_calls?.map(({ execution_id: _, ...call }) => call) ?? null }
      : entry), [])).toEqual([])
  })
})

describe('ActionCard', () => {
  it('shows destructive changes, voice attribution, details, Open and direct Undo', async () => {
    const { messages, actions } = structuredResult()
    const item = collectCommanderActions(messages, actions)[0]
    render(<ActionCard item={item} />)

    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive')
    expect(screen.getByText('Archived project “Web”')).toBeInTheDocument()
    expect(screen.getByText(/active/)).toBeInTheDocument()
    expect(screen.getByText(/Heard: “archive the web project”/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open target' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Tool details' }))
    expect(screen.getByText(/"changes"/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(mocks.undoAction).toHaveBeenCalledWith('s1', 'exec-1'))
    expect(await screen.findByRole('button', { name: 'Undone' })).toBeDisabled()
  })

  it('shows the explicit unsupported message for removal/scope actions', () => {
    const { messages, actions } = structuredResult('remove_skill')
    const item = collectCommanderActions(messages, actions)[0]
    render(<ActionCard item={item} />)
    expect(screen.getByText('Can’t be undone here')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})
