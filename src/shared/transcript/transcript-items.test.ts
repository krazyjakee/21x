import { describe, expect, it } from 'vitest'
import { buildTranscriptItems, findActiveQuestionId, findLatestTodos, findTranscriptMatches } from './transcript-items'
import { deriveToolSubtitle, isCompactActivityMessage } from './tool-format'
import type { AgentMessage } from './types'

function msg(id: string, over: Partial<AgentMessage> = {}): AgentMessage {
  return { id, role: 'assistant', content: '', timestamp: new Date(0), ...over }
}

const tool = (id: string, name = 'Bash') => msg(id, { partType: 'tool', tool: { name, status: 'completed' } })
const todo = { id: '1', content: 'x', status: 'pending' as const }

describe('transcript items', () => {
  it('groups consecutive tool and reasoning messages keyed by the first member', () => {
    const items = buildTranscriptItems([msg('a'), tool('t1'), msg('r', { partType: 'reasoning' }), msg('b')])
    expect(items.map((i) => [i.type, i.key])).toEqual([['message', 'a'], ['activity', 't1'], ['message', 'b']])
  })

  it('does not treat a nameless tool part as compact activity', () => {
    expect(isCompactActivityMessage(msg('x', { partType: 'tool', tool: { name: '', status: '' } }))).toBe(false)
  })

  it('searches message content case-insensitively via the normalized query', () => {
    const items = buildTranscriptItems([msg('a', { content: 'Hello' }), tool('t1', 'Grep')])
    expect(findTranscriptMatches(items, 'grep')).toEqual([1])
    expect(findTranscriptMatches(items, '')).toEqual([])
  })

  it('finds the active question only when the user has not replied', () => {
    const question = msg('q', { partType: 'question', tool: { name: 'q', status: '', questions: [] } })
    expect(findActiveQuestionId([msg('a'), question, msg('b')])).toBe('q')
    expect(findActiveQuestionId([question, msg('u', { role: 'user' })])).toBeNull()
  })

  it('pins todos only from todowrite messages', () => {
    const write = msg('w', { partType: 'todowrite', tool: { name: 'TodoWrite', status: '', todos: [todo] } })
    const other = msg('o', { partType: 'tool', tool: { name: 'Other', status: '', todos: [todo, todo] } })
    expect(findLatestTodos([write, other])).toEqual([todo])
    expect(findLatestTodos([other])).toBeNull()
  })

  it('omits a subtitle that only repeats the tool name', () => {
    expect(deriveToolSubtitle({ name: 'Bash', status: '', title: 'Bash' })).toBe('')
    expect(deriveToolSubtitle({ name: 'Read', status: '', title: '/a/b/file.ts' })).toBe('file.ts')
  })
})
