import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CommanderMessage } from '@shared/commander'
import { CommanderMessageItem, ToolChip } from './CommanderMessageItem'
import { formatToolResult } from './tool-call-label'

afterEach(cleanup)

describe('ToolChip', () => {
  it('stays compact and expands its result inline from a keyboard-operable button', () => {
    render(<ToolChip name="ask_captain" input={{ project: 'Web', message: 'Deploy' }} result='{"ok":true}' />)
    const chip = screen.getByRole('button', { name: /Asked Web: Deploy/ })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('commander-tool-result')).toBeNull()

    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    const region = screen.getByTestId('commander-tool-result')
    expect(chip.getAttribute('aria-controls')).toBe(region.id)
    expect(region.textContent).toBe('{\n  "ok": true\n}')

    fireEvent.click(chip)
    expect(screen.queryByTestId('commander-tool-result')).toBeNull()
  })

  it('shows error results expanded in place', () => {
    render(<ToolChip name="archive_project" input={{ project: 'Web' }} result="Not allowed" isError />)
    fireEvent.click(screen.getByRole('button', { name: /Archive project · Web/ }))
    expect(screen.getByTestId('commander-tool-result').textContent).toBe('Not allowed')
  })

  it('has nothing to expand without a result', () => {
    render(<ToolChip name="list_projects" input={{}} result="" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByTestId('commander-tool-chip').textContent).toBe('List projects')
  })
})

describe('CommanderMessageItem tool calls', () => {
  const assistant = {
    id: 'm1',
    session_id: 's1',
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call-1', name: 'list_projects', input: {} }],
    tool_call_id: null,
    is_error: false,
    project_id: null,
    created_at: '2026-09-19T00:00:00Z',
  } as unknown as CommanderMessage

  it('shows the running spinner while a call has no result yet', () => {
    render(<CommanderMessageItem message={assistant} toolResults={new Map()} />)
    const chip = screen.getByTestId('commander-tool-chip')
    expect(chip.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('stops spinning once the result arrives', () => {
    const result = { ...assistant, id: 'm2', role: 'tool', content: '["Web"]', tool_calls: null, tool_call_id: 'call-1' } as unknown as CommanderMessage
    render(<CommanderMessageItem message={assistant} toolResults={new Map([['call-1', result]])} />)
    const chip = screen.getByTestId('commander-tool-chip')
    expect(chip.querySelector('.animate-spin')).toBeNull()
    expect(chip.tagName).toBe('BUTTON')
  })
})

describe('formatToolResult', () => {
  it('pretty-prints JSON and trims text', () => {
    expect(formatToolResult('[1,2]')).toBe('[\n  1,\n  2\n]')
    expect(formatToolResult('  done \n')).toBe('done')
    expect(formatToolResult('{not json')).toBe('{not json')
    expect(formatToolResult(undefined)).toBe('')
  })
})
