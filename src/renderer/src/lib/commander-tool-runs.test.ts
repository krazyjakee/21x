import { describe, expect, it } from 'vitest'
import type { CommanderMessage } from '@shared/commander'
import { pairToolResults, toolRunKey } from './commander-tool-runs'

function message(id: string, over: Partial<CommanderMessage>): CommanderMessage {
  return { id, session_id: 's1', role: 'assistant', content: '', tool_calls: null, tool_call_id: null, tool_name: null, is_error: false, project_id: null, correlation_id: null, created_at: 1, ...over }
}
const call = (id: string) => ({ id, name: 'archive_project', input: {} })
const result = (id: string, callId: string) => message(id, { role: 'tool', tool_call_id: callId })

describe('pairToolResults', () => {
  it('gives each execution its own result when a provider repeats a call id', () => {
    const first = message('a1', { tool_calls: [call('call_0')] }), second = message('a2', { tool_calls: [call('call_0')] })
    const pairs = pairToolResults([first, result('r1', 'call_0'), second, result('r2', 'call_0')])
    expect(pairs.get(toolRunKey('a1', 0))?.id).toBe('r1')
    expect(pairs.get(toolRunKey('a2', 0))?.id).toBe('r2')
  })
  it('pairs parallel calls by id and leaves an unanswered call waiting', () => {
    const parallel = message('a1', { tool_calls: [call('one'), call('two'), call('three')] })
    const pairs = pairToolResults([parallel, result('r2', 'two'), result('r1', 'one')])
    expect(pairs.get(toolRunKey('a1', 0))?.id).toBe('r1')
    expect(pairs.get(toolRunKey('a1', 1))?.id).toBe('r2')
    expect(pairs.has(toolRunKey('a1', 2))).toBe(false)
  })
  it('ignores a result with no call waiting for it', () => {
    expect(pairToolResults([result('r1', 'gone')]).size).toBe(0)
  })
})
