import { describe, expect, it, vi } from 'vitest'
import type { ChatToolDefinition } from '../../chat/tools'
import { commanderRoleTools } from './commander'

describe('Commander role tool boundary', () => {
  it('keeps direct user actions immediate and refuses report-owned administration', async () => {
    const write = vi.fn(async () => 'Project created')
    const tools: ChatToolDefinition[] = [{ name: 'create_project', description: 'Create', inputSchema: { type: 'object' }, handler: write }]
    const context = { remainingReportAsks: () => 0, consumeReportAsk: vi.fn() }
    expect(commanderRoleTools(tools, { ...context, trigger: 'report' })).toEqual([])
    const user = commanderRoleTools(tools, { ...context, trigger: 'user' })
    expect(user).toBe(tools)
    expect(await user[0].handler({}, { signal: new AbortController().signal, toolCallId: 'user-action' })).toBe('Project created')
    expect(write).toHaveBeenCalledOnce()
    expect(context.consumeReportAsk).not.toHaveBeenCalled()
  })

  it('shares the report-ask budget while leaving reads available', async () => {
    let remaining = 1
    const delegate = vi.fn(async () => 'Delegated')
    const read = vi.fn(async () => 'Current state')
    const tools: ChatToolDefinition[] = [
      { name: 'ask_captain', description: 'Ask', inputSchema: { type: 'object' }, handler: delegate },
      { name: 'list_projects', description: 'Read', inputSchema: { type: 'object' }, handler: read }
    ]
    const report = commanderRoleTools(tools, { trigger: 'report', remainingReportAsks: () => remaining, consumeReportAsk: () => { remaining-- } })
    const context = { signal: new AbortController().signal, toolCallId: 'report-action' }
    expect(await report[0].handler({}, context)).toBe('Delegated')
    expect(await report[0].handler({}, context)).toMatchObject({ isError: true, content: expect.stringContaining('loop_guard') })
    expect(await report[1].handler({}, context)).toBe('Current state')
    expect(delegate).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
  })
})
