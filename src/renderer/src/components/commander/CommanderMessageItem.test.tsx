import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CommanderMessage } from '@shared/commander'
import { CommanderMessageItem, TOOL_NOT_RUN_DETAIL, ToolChip } from './CommanderMessageItem'
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

  it('spins while a live call has no result, and honours reduced motion', () => {
    render(<ToolChip name="list_projects" input={{}} />)
    const icon = screen.getByTestId('commander-tool-chip').querySelector('.animate-spin')
    expect(icon).not.toBeNull()
    expect(icon?.getAttribute('class')).toContain('motion-reduce:animate-none')
    expect(screen.getByTestId('commander-tool-state').textContent).toBe('(Running)')
  })

  it('lets a real result win over notRun', () => {
    render(<ToolChip name="list_projects" input={{}} result='["Web"]' notRun />)
    const chip = screen.getByTestId('commander-tool-chip')
    expect(chip.className).not.toContain('text-destructive')
    expect(screen.queryByTestId('commander-tool-state')).toBeNull()
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

  it('spins for a stored call only while it is the newest message of a running turn', () => {
    render(<CommanderMessageItem message={assistant} toolResults={new Map()} turnActive />)
    const chip = screen.getByTestId('commander-tool-chip')
    expect(chip.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.getByTestId('commander-tool-state').textContent).toBe('(Running)')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('never spins for a stored call whose turn is over: it reads "Not run" as a failure, not a success (#83)', () => {
    // A reopened session: the row was saved by a turn that was cut off
    // (max_tokens / tool limit) before the runtime closed unanswered calls.
    render(<CommanderMessageItem message={assistant} toolResults={new Map()} />)
    const chip = screen.getByTestId('commander-tool-chip')
    expect(chip.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByTestId('commander-tool-state').textContent).toBe('(Not run)')
    expect(chip.className).toContain('text-destructive')
    // Not drawn as a finished, successful call either (the pre-#149 bug).
    expect(chip.querySelector('.lucide-check')).toBeNull()

    expect(chip.tagName).toBe('BUTTON')
    fireEvent.click(chip)
    expect(screen.getByTestId('commander-tool-result').textContent).toBe(TOOL_NOT_RUN_DETAIL)
  })

  it('stops spinning when the turn ends without a result, without remounting', () => {
    const view = render(<CommanderMessageItem message={assistant} toolResults={new Map()} turnActive />)
    expect(screen.getByTestId('commander-tool-chip').querySelector('.animate-spin')).not.toBeNull()
    view.rerender(<CommanderMessageItem message={assistant} toolResults={new Map()} turnActive={false} />)
    expect(screen.getByTestId('commander-tool-chip').querySelector('.animate-spin')).toBeNull()
    expect(screen.getByTestId('commander-tool-state').textContent).toBe('(Not run)')
  })

  it('shows a stored failed "not run" result as an error, not as running', () => {
    const closed = { ...assistant, id: 'm3', role: 'tool', content: 'Not run: the reply was cut off before this tool call was complete.', tool_calls: null, tool_call_id: 'call-1', is_error: true } as unknown as CommanderMessage
    render(<CommanderMessageItem message={assistant} toolResults={new Map([['call-1', closed]])} turnActive />)
    const chip = screen.getByTestId('commander-tool-chip')
    expect(chip.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByTestId('commander-tool-state').textContent).toBe('(Failed)')
    expect(chip.className).toContain('text-destructive')
  })

  it('judges each call of one message on its own', () => {
    const two = { ...assistant, tool_calls: [{ id: 'call-1', name: 'list_projects', input: {} }, { id: 'call-2', name: 'list_projects', input: {} }] } as unknown as CommanderMessage
    const result = { ...assistant, id: 'm2', role: 'tool', content: '["Web"]', tool_calls: null, tool_call_id: 'call-1' } as unknown as CommanderMessage
    render(<CommanderMessageItem message={two} toolResults={new Map([['call-1', result]])} />)
    const [done, orphan] = screen.getAllByTestId('commander-tool-chip')
    expect(done.querySelector('.animate-spin')).toBeNull()
    expect(done.className).not.toContain('text-destructive')
    expect(orphan.querySelector('.animate-spin')).toBeNull()
    expect(orphan.className).toContain('text-destructive')
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
