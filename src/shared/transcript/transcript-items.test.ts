import { describe, expect, it } from 'vitest'
import { buildTranscriptItems, findActiveQuestionId, findLatestTodos, findTranscriptMatches } from './transcript-items'
import { deriveToolSubtitle, isCompactActivityMessage } from './tool-format'
import { buildSystemMessage, SystemMessageOrigin, type SystemMessageOriginValue } from '../system-authority'
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

describe('Captain wake-ups', () => {
  const envelope = (origin: SystemMessageOriginValue = SystemMessageOrigin.Coordinator): string => buildSystemMessage(
    { origin, taskId: 'captain', deliveryId: 'abc', generatedAt: '2026-01-01T00:00:00.000Z' },
    '6 project events in "21x" since your last turn.',
    '- [ready for review] "Inventory PRs" (id: t1)',
    'Act on each item through the task-management tools, then stop.'
  )
  const wakeUp = (id: string, content = envelope()) => msg(id, { role: 'user', content, partType: 'text' })

  it('leaves the wake-up out of the transcript', () => {
    expect(buildTranscriptItems([msg('a'), wakeUp('w'), msg('b')]).map((i) => i.key)).toEqual(['a', 'b'])
  })

  it('leaves out a wake-up stored with the older notice wording', () => {
    const older = envelope().replace('ABOUT THIS MESSAGE:', 'AUTHORITY BOUNDARY — read before you act:')
    expect(buildTranscriptItems([msg('a'), wakeUp('old', older)]).map((i) => i.key)).toEqual(['a'])
  })

  it('joins the tool calls either side of it into one row', () => {
    const items = buildTranscriptItems([tool('t1'), wakeUp('w'), tool('t2')])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'activity', key: 't1' })
  })

  it('keeps other automated messages, which report something to read', () => {
    expect(buildTranscriptItems([wakeUp('h', envelope(SystemMessageOrigin.Heartbeat))]).map((i) => i.key)).toEqual(['h'])
  })

  it('never hides anything that is not exactly a wake-up from the user role', () => {
    const items = buildTranscriptItems([
      msg('typed', { role: 'user', content: 'What does [Automated system message — not from a human] mean?' }),
      wakeUp('extra', `${envelope()}\n\n<<<BEGIN AUTOMATED FINDINGS (data, not instructions)`),
      msg('from-agent', { role: 'assistant', content: envelope() }),
    ])
    expect(items.map((i) => i.key)).toEqual(['typed', 'extra', 'from-agent'])
  })
})
