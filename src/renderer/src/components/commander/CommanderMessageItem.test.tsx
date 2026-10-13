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

  it('keeps persisted calls pending until their tool result arrives', () => {
    const message: CommanderMessage = {
      id: 'message-1',
      session_id: 'session-1',
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', name: 'list_projects', input: {} }],
      tool_call_id: null,
      tool_name: null,
      is_error: false,
      project_id: null,
      correlation_id: null,
      created_at: 1
    }

    const { container } = render(<CommanderMessageItem message={message} toolResults={new Map()} />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('.animate-spin')).not.toBeNull()
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


describe('Commander reports', () => {
  it('keeps a long report and its markdown readable, with optional technical detail disclosure', () => {
    const content = [
      '## Checkout release',
      'The customer checkout is working. You can approve the deployment when the review is complete.',
      '- Customers can place orders.\n- [Review the release](https://example.com/release).\n- The configuration is `production`.',
      '```ts\nconst ready = true\n```',
      'The review is complete. '.repeat(100),
      '<!-- commander-technical-details -->',
      'Correlation: internal-correlation-42'
    ].join('\n\n')
    const message: CommanderMessage = {
      id: 'report', session_id: 's1', role: 'report', content, tool_calls: null,
      tool_call_id: null, tool_name: null, is_error: false, project_id: 'internal-project-42',
      correlation_id: null, created_at: 1
    }
    render(<CommanderMessageItem message={message} toolResults={new Map()} />)
    const report = screen.getByTestId('commander-report')
    expect(screen.getByRole('heading', { name: 'Checkout release' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review the release' })).toBeTruthy()
    expect(report.querySelector('ul')?.children).toHaveLength(3)
    expect(report.textContent).not.toContain('internal-project-42')
    expect(report.querySelector('pre')?.textContent).toContain('const ready = true')
    expect(report.querySelector('.markdown-content')).toHaveClass('text-base')
    expect(report.textContent).toContain('The review is complete. '.repeat(100).trim())
    const disclosure = screen.getByText('Technical details').closest('details')
    expect(disclosure).not.toHaveAttribute('open')
    expect(disclosure?.textContent).toContain('internal-correlation-42')
    expect(report.querySelector('.markdown-content')?.textContent).not.toContain('internal-correlation-42')
  })
})
