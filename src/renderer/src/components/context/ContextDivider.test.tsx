import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CommanderMessage } from '@shared/commander'
import { MessageBubble } from '@/components/agents/transcript/MessageBubble'
import { CommanderMessageItem } from '@/components/commander/CommanderMessageItem'
import { readContextDivider } from './ContextDivider'

afterEach(cleanup)
describe('context lifecycle dividers', () => {
  it('renders a Captain generation recovery with visible provenance and accessible summary details', () => {
    render(<MessageBubble message={{ id: 'recovery', role: 'system', partType: 'generation', timestamp: new Date(1), content: JSON.stringify({ kind: 'recovery', title: 'Captain recovered after interruption', summary: 'Earlier decisions are **preserved**.', source: 'fallback' }) }} />)
    expect(screen.getByRole('separator', { name: 'Conversation recovered' })).toHaveTextContent('Captain recovered after interruption')
    expect(screen.getByText('Fallback summary')).toBeTruthy()
    const disclosure = screen.getByText('Read recovery summary'); expect(disclosure.closest('details')).not.toHaveAttribute('open')
    fireEvent.click(disclosure); expect(disclosure.closest('details')).toHaveAttribute('open')
    expect(screen.getByText('preserved').tagName).toBe('STRONG')
    expect(screen.queryByTestId('speak-message')).toBeNull()
  })
  it('keeps Commander rollover in the original thread as a divider with no invented tool action', () => {
    const note: CommanderMessage = { id: 'handoff', session_id: 'same-session', role: 'assistant', content: JSON.stringify({ kind: 'rollover', title: 'Commander continued in a new generation', summary: 'The original conversation remains available.', source: 'model' }), tool_name: 'session_rollover', tool_calls: null, tool_call_id: null, is_error: false, project_id: null, correlation_id: null, created_at: 1 }
    render(<CommanderMessageItem message={note} toolResults={new Map()} />)
    expect(screen.getByRole('separator', { name: 'Conversation generation changed' })).toHaveTextContent('Commander continued')
    expect(screen.getByText('Read handoff summary · Model summary')).toBeTruthy()
    expect(screen.queryByTestId('commander-action-card')).toBeNull()
    expect(screen.queryByTestId('commander-tool-chip')).toBeNull()
  })
  it('retains legacy plain-text and malformed metadata as readable evidence', () => {
    expect(readContextDivider('Old recovered state.', 'recovery')).toMatchObject({ title: 'Session recovered', summary: 'Old recovered state.' })
    expect(readContextDivider('{broken json', 'rollover')).toMatchObject({ kind: 'rollover', summary: '{broken json' })
    expect(readContextDivider(JSON.stringify({ kind: 'unrecognized', title: 5, summary: 'Kept evidence', source: 'invented' }), 'rollover')).toMatchObject({ kind: 'rollover', title: 'Session continued in a new generation', summary: 'Kept evidence', source: null })
  })
})
