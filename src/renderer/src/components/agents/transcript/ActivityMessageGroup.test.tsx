import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Artifact } from '@shared/artifacts'
import type { AgentMessage } from '@shared/transcript/types'
import { ActivityMessageGroup } from './ActivityMessageGroup'

let nextId = 0
function tool(name: string, status = 'completed', extra: Partial<NonNullable<AgentMessage['tool']>> = {}): AgentMessage {
  nextId += 1
  return {
    id: `tool-${nextId}`,
    role: 'assistant',
    content: '',
    timestamp: new Date('2026-03-10T00:00:00Z'),
    partType: 'tool',
    tool: { name, status, ...extra },
  } as AgentMessage
}

function thought(): AgentMessage {
  nextId += 1
  return { id: `thought-${nextId}`, role: 'assistant', content: 'Weighing it up', timestamp: new Date('2026-03-10T00:00:00Z'), partType: 'reasoning' }
}

const summary = (): HTMLElement => screen.getByRole('button', { expanded: false })

describe('ActivityMessageGroup', () => {
  afterEach(cleanup)

  it('merges a run of tool calls into one row', () => {
    render(<ActivityMessageGroup messages={[tool('task-management.get_task'), tool('task-management.get_messages'), tool('task-management.get_messages')]} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(summary().textContent).toContain('3 tool calls')
    expect(summary().textContent).toContain('get_task, get_messages ×2')
  })

  it('leaves a single tool call as its own row', () => {
    render(<ActivityMessageGroup messages={[tool('task-management.get_task')]} />)
    expect(screen.getByRole('button').textContent).toContain('task-management.get_task')
    expect(screen.getByRole('button').textContent).not.toContain('1 tool call')
  })

  it('counts thinking apart from tool calls', () => {
    render(<ActivityMessageGroup messages={[thought(), tool('read'), thought()]} />)
    expect(summary().textContent).toContain('1 tool call, 2 thoughts')
  })

  it('opens to every row and closes again', () => {
    render(<ActivityMessageGroup messages={[tool('first_tool'), tool('second_tool')]} />)
    fireEvent.click(summary())
    expect(screen.getByRole('button', { expanded: true }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByText('first_tool')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('stays open after being scrolled out of the virtual window', () => {
    const messages = [tool('first_tool'), tool('second_tool')]
    const first = render(<ActivityMessageGroup messages={messages} />)
    fireEvent.click(summary())
    first.unmount()
    render(<ActivityMessageGroup messages={messages} />)
    expect(screen.getByText('first_tool')).toBeTruthy()
  })

  it('names what is running while the agent works', () => {
    const { container } = render(<ActivityMessageGroup messages={[tool('done_tool'), tool('task-management.slow_tool', 'running')]} />)
    expect(summary().textContent).toContain('slow_tool')
    expect(summary().textContent).not.toContain('done_tool')
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('shows failures on the closed row', () => {
    const { container } = render(<ActivityMessageGroup messages={[tool('fine'), tool('broken', 'error'), tool('broken', 'failed')]} />)
    expect(container.querySelector('.text-red-400')).not.toBeNull()
    expect(summary().textContent).toContain('2 failed')
  })

  it('keeps an artifact card visible on the closed row', () => {
    const artifact = { id: 'a1', taskId: 't1', title: 'Report', kind: 'file', path: '/tmp/report.md' } as unknown as Artifact
    render(
      <ActivityMessageGroup
        messages={[tool('other'), tool('write', 'completed', { output: 'wrote /tmp/report.md' })]}
        artifacts={[artifact]}
        onOpenArtifact={vi.fn()}
      />
    )
    expect(screen.getAllByRole('button').length).toBeGreaterThan(1)
    expect(screen.getByRole('button', { expanded: false }).textContent).toContain('2 tool calls')
  })

  it('opens a group holding a search match, and only that group', () => {
    const matching = render(<ActivityMessageGroup searchQuery="needle" messages={[tool('other'), tool('write', 'completed', { output: 'a needle here' })]} />)
    expect(screen.getByText('other')).toBeTruthy()
    matching.unmount()
    render(<ActivityMessageGroup searchQuery="needle" messages={[tool('other'), tool('write')]} />)
    expect(screen.queryByText('other')).toBeNull()
  })
})
