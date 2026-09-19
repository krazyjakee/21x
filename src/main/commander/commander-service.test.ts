import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { CommanderEvent, CommanderMessage } from '../../shared/commander'
import type { ChatProvider, ChatProviderEvent, ChatProviderRequest } from '../chat/providers/types'
import type { DatabaseManager } from '../database'
import { CommanderService, cleanGeneratedTitle, fallbackTitle, toolResultTags } from './commander-service'
import { CommanderStore } from './commander-store'
import { buildContext, planFold, splitTurns } from './context'
import { createCommanderProjectTools, ProjectMutationConfirmations, type CommanderAgents } from './project-tools'
import { COMMANDER_SUMMARY_PROMPT, COMMANDER_TITLE_PROMPT } from './prompts'

/** A model answer: text, a failure, or text plus tool calls (the turn then continues with their results). */
type ModelAnswer = string | Error | { text?: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }
type Reply = (request: ChatProviderRequest) => ModelAnswer

/** A fake provider: `chat`, `title` and `summary` decide the text of each kind of call. */
function fakeProvider(replies: { chat?: Reply; title?: Reply; summary?: Reply } = {}): ChatProvider & { requests: ChatProviderRequest[] } {
  const requests: ChatProviderRequest[] = []
  return {
    id: 'fake',
    model: 'fake-1',
    requests,
    stream(request) {
      requests.push(request)
      const pick =
        request.system === COMMANDER_TITLE_PROMPT ? replies.title
          : request.system === COMMANDER_SUMMARY_PROMPT ? replies.summary
            : replies.chat
      const out = pick ? pick(request) : 'ok'
      return (async function* (): AsyncGenerator<ChatProviderEvent> {
        if (out instanceof Error) throw out
        const text = typeof out === 'string' ? out : out.text ?? ''
        for (const word of text.split(/(?<= )/)) if (word) yield { type: 'text_delta', text: word }
        if (typeof out !== 'string') {
          for (const call of out.toolCalls) yield { type: 'tool_call', ...call }
          yield { type: 'message_end', stopReason: 'tool_use' }
          return
        }
        yield { type: 'message_end', stopReason: 'end_turn' }
      })()
    }
  }
}

let db: DatabaseManager
let store: CommanderStore
let events: CommanderEvent[]

function makeService(provider: ChatProvider, budget?: { keepTurns?: number; maxChars?: number }): CommanderService {
  return new CommanderService({ store, createProvider: () => provider, emit: (e) => events.push(e), budget })
}

function chatRequests(provider: { requests: ChatProviderRequest[] }): ChatProviderRequest[] {
  return provider.requests.filter((r) => r.system !== COMMANDER_TITLE_PROMPT && r.system !== COMMANDER_SUMMARY_PROMPT)
}

/** Project rows for the project tags these tests use (commander_messages.project_id references projects). */
function seedProjects(rawDb: ReturnType<typeof createTestDb>['rawDb'], ids: string[]): void {
  const insert = rawDb.prepare(
    "INSERT OR IGNORE INTO projects (id, name, description, settings, sort_order, archived, created_at, updated_at) VALUES (?, ?, '', '{}', 0, 0, ?, ?)"
  )
  for (const id of ids) insert.run(id, id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}

beforeEach(() => {
  const created = createTestDb()
  db = created.db
  seedProjects(created.rawDb, ['web'])
  store = new CommanderStore(db)
  events = []
})

describe('CommanderService turns', () => {
  it('stores the exchange, streams events and names the session with the model', async () => {
    const provider = fakeProvider({ chat: () => 'I will ask the web project.', title: () => '"Website launch plan."' })
    const service = makeService(provider)
    const session = store.createSession()

    const { turnId, done } = service.sendUserMessage(session.id, '  Plan the website launch  ')
    expect(service.activeTurnId(session.id)).toBe(turnId)
    await done

    const messages = store.listMessages(session.id)
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Plan the website launch'],
      ['assistant', 'I will ask the web project.']
    ])
    expect(store.getSession(session.id)?.title).toBe('Website launch plan')
    expect(service.activeTurnId(session.id)).toBeNull()

    const deltas = events.flatMap((e) => (e.type === 'turn_event' && e.event.type === 'text_delta' ? [e.event.text] : []))
    expect(deltas.join('')).toBe('I will ask the web project.')
    const doneEvent = events.find((e) => e.type === 'turn_event' && e.event.type === 'done')
    expect(doneEvent).toMatchObject({ turnId, event: { type: 'done', stopReason: 'end_turn' } })
    // The stored assistant message is announced before `done`.
    const appendedIdx = events.findIndex((e) => e.type === 'messages_appended' && e.messages.some((m) => m.role === 'assistant'))
    expect(appendedIdx).toBeLessThan(events.indexOf(doneEvent!))
    // The chat call carries the Commander system prompt and no tools yet.
    const [chat] = chatRequests(provider)
    expect(chat.system).toMatch(/Commander/)
    expect(chat.tools).toEqual([])
  })

  it('falls back to the first words of the user message when the title call fails', async () => {
    const service = makeService(fakeProvider({ chat: () => 'Sure.', title: () => new Error('rate limited') }))
    const session = store.createSession()
    await service.sendUserMessage(session.id, 'Please check on the billing migration for next week today').done
    expect(store.getSession(session.id)?.title).toBe('Please check on the billing migration…')
  })

  it('never overwrites a title the user set', async () => {
    const service = makeService(fakeProvider({ title: () => 'Model title' }))
    const session = store.createSession('Mine')
    await service.sendUserMessage(session.id, 'hello').done
    expect(store.getSession(session.id)?.title).toBe('Mine')
  })

  it('rejects a second message while a turn is running, and empty messages', async () => {
    const service = makeService(fakeProvider())
    const session = store.createSession()
    expect(() => service.sendUserMessage(session.id, '   ')).toThrow('empty')
    const first = service.sendUserMessage(session.id, 'one')
    expect(() => service.sendUserMessage(session.id, 'two')).toThrow('still answering')
    await first.done
    await service.sendUserMessage(session.id, 'two').done
    expect(store.listMessages(session.id).filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('rejects before storing anything when no provider can be built', () => {
    const service = new CommanderService({
      store,
      emit: (e) => events.push(e),
      createProvider: () => {
        throw new Error('No API key')
      }
    })
    const session = store.createSession()
    expect(() => service.sendUserMessage(session.id, 'hi')).toThrow('No API key')
    expect(store.listMessages(session.id)).toEqual([])
  })

  it('binds each turn tool registry to the immediately preceding user message', async () => {
    const seen: Array<{ sessionId: string; userMessage: string }> = []
    const service = new CommanderService({
      store,
      emit: (event) => events.push(event),
      createProvider: () => fakeProvider(),
      getTools: (context) => {
        seen.push(context)
        return []
      }
    })
    const session = store.createSession('Confirmation context')
    await service.sendUserMessage(session.id, 'propose a rename').done
    await service.sendUserMessage(session.id, 'Confirm abc123').done

    expect(seen).toEqual([
      { sessionId: session.id, userMessage: 'propose a rename', trigger: 'user' },
      { sessionId: session.id, userMessage: 'Confirm abc123', trigger: 'user' }
    ])
  })

  it('delegates to each project the user names and replies at once, without waiting for the Captains', async () => {
    db.createAgent({ name: 'Claude' })
    const alpha = db.createProject({ name: 'Alpha' })!
    const beta = db.createProject({ name: 'Beta' })!
    // Captains that never answer: the Commander's turn must still finish.
    const sendMessage = vi.fn(() => new Promise<{ newSessionId?: string }>(() => {}))
    const agents = {
      getStartQueue: () => [],
      findSessionByTaskId: () => undefined,
      getSessionStatus: () => null,
      getProjectLimitState: () => undefined,
      sendMessage,
      pauseAllProjects: vi.fn(),
      isAllProjectsPaused: () => false
    } as unknown as CommanderAgents
    const provider = fakeProvider({
      chat: (request) =>
        request.messages.some((m) => m.role === 'tool')
          ? 'Asked Alpha to ship the site and Beta to review the API. They will report back here.'
          : {
              toolCalls: [
                { id: 'c1', name: 'ask_captain', input: { project: 'Alpha', message: 'Ship the site' } },
                { id: 'c2', name: 'ask_captain', input: { project: beta.id, message: 'Review the API' } }
              ]
            },
      title: () => 'Two projects'
    })
    const confirmations = new ProjectMutationConfirmations()
    const service = new CommanderService({
      store,
      emit: (e) => events.push(e),
      createProvider: () => provider,
      getTools: (context) => createCommanderProjectTools({ db, context, confirmations, agents })
    })
    const session = store.createSession()

    await service.sendUserMessage(session.id, 'Get Alpha to ship the site and Beta to review the API').done

    // Both Captains were asked, each with its own correlation id, and the turn ended in text.
    expect(sendMessage).toHaveBeenCalledTimes(2)
    const targets = sendMessage.mock.calls.map((args) => (args as unknown as [string, string, string])[2]).sort()
    expect(targets).toEqual([db.getCoordinatorTask(alpha.id)!.id, db.getCoordinatorTask(beta.id)!.id].sort())
    expect(service.activeTurnId(session.id)).toBeNull()

    const messages = store.listMessages(session.id)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant'])
    expect(messages[1].tool_calls?.map((c) => c.name)).toEqual(['ask_captain', 'ask_captain'])
    // Tool rows are tagged with the project and the correlation id the report will quote (#62).
    expect(messages[2]).toMatchObject({ tool_name: 'ask_captain', is_error: false, project_id: alpha.id })
    expect(messages[3]).toMatchObject({ tool_name: 'ask_captain', is_error: false, project_id: beta.id })
    expect(messages[2].correlation_id).toMatch(/^cmd-/)
    expect(messages[3].correlation_id).toMatch(/^cmd-/)
    expect(messages[2].correlation_id).not.toBe(messages[3].correlation_id)
    for (const [index, call] of (sendMessage.mock.calls as unknown as Array<[string, string]>).entries()) {
      expect(call[1]).toContain(`correlation_id=${messages[2 + index].correlation_id}`)
    }
    expect(messages[4].content).toMatch(/Alpha.*Beta/)
    const doneEvent = events.find((e) => e.type === 'turn_event' && e.event.type === 'done')
    expect(doneEvent).toMatchObject({ event: { stopReason: 'end_turn' } })
  })

  it('tags tool rows only from successful object results', () => {
    expect(toolResultTags('{"status":"sent","project_id":"p1","correlation_id":"cmd-1"}', false)).toEqual({ projectId: 'p1', correlationId: 'cmd-1' })
    expect(toolResultTags('{"status":"sent","project_id":"p1","correlation_id":"cmd-1"}', true)).toEqual({})
    expect(toolResultTags('{"projects":[]}', false)).toEqual({})
    expect(toolResultTags('Project not found', false)).toEqual({})
    expect(toolResultTags('{not json', false)).toEqual({})
  })

  it('stores reports as unread until the session is read', () => {
    const service = makeService(fakeProvider())
    const session = store.createSession()
    service.appendReport({ sessionId: session.id, content: 'Deployed.', projectId: 'web', correlationId: 'c-1' })
    expect(store.getSession(session.id)?.unread_count).toBe(1)
    expect(events.some((e) => e.type === 'session_updated' && e.session.unread_count === 1)).toBe(true)
    store.markRead(session.id)
    expect(store.getSession(session.id)?.unread_count).toBe(0)
  })
})

describe('CommanderService context budget', () => {
  it('folds older turns into a stored summary and sends only the newest turns verbatim', async () => {
    let n = 0
    const provider = fakeProvider({
      chat: () => `reply ${++n}`,
      title: () => 'Budget test',
      summary: (req) => `SUMMARY(${req.messages[0].content.includes('Previous summary') ? 'merged' : 'fresh'})`
    })
    const service = makeService(provider, { keepTurns: 2 })
    const session = store.createSession()

    for (const text of ['first', 'second', 'third']) await service.sendUserMessage(session.id, text).done

    const summaries = store.listMessages(session.id).filter((m) => m.role === 'summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0].content).toBe('SUMMARY(fresh)')
    // It covers exactly the first turn: its correlation_id is that turn's last message.
    const firstReply = store.listMessages(session.id).find((m) => m.content === 'reply 1')!
    expect(summaries[0].correlation_id).toBe(firstReply.id)

    await service.sendUserMessage(session.id, 'fourth').done
    const lastChat = chatRequests(provider).at(-1)!
    expect(lastChat.system).toContain('SUMMARY(fresh)')
    // keepTurns = 2: turn one is in the summary, turn two is trimmed, the newest two are verbatim.
    expect(lastChat.messages.map((m) => m.content)).toEqual(['third', 'reply 3', 'fourth'])

    // The rolling summary merges the previous one.
    const latest = store.listMessages(session.id).filter((m) => m.role === 'summary').at(-1)!
    expect(latest.content).toBe('SUMMARY(merged)')
  })

  it('keeps nothing folded when the summary call fails; the next turn just trims', async () => {
    const provider = fakeProvider({ summary: () => new Error('down') })
    const service = makeService(provider, { keepTurns: 1 })
    const session = store.createSession()
    await service.sendUserMessage(session.id, 'a').done
    await service.sendUserMessage(session.id, 'b').done
    expect(store.listMessages(session.id).some((m) => m.role === 'summary')).toBe(false)
    const last = chatRequests(provider).at(-1)!
    expect(last.messages.map((m) => m.content)).toEqual(['b'])
  })
})

describe('context helpers', () => {
  let seq = 0
  const msg = (role: CommanderMessage['role'], content: string, extra: Partial<CommanderMessage> = {}): CommanderMessage => ({
    id: `m${++seq}`,
    session_id: 's',
    role,
    content,
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    is_error: false,
    project_id: null,
    correlation_id: null,
    created_at: seq,
    ...extra
  })

  it('never separates a tool call from its result and turns reports into user-side notes', () => {
    const history = [
      msg('user', 'ask web'),
      msg('assistant', '', { tool_calls: [{ id: 'c1', name: 'ask_project', input: { project: 'web' } }] }),
      msg('tool', 'queued', { tool_call_id: 'c1', tool_name: 'ask_project' }),
      msg('assistant', 'Asked.'),
      msg('report', 'Web is done', { project_id: 'web' }),
      msg('user', 'great')
    ]
    expect(splitTurns(history).map((t) => t.length)).toEqual([4, 1, 1])
    const ctx = buildContext(history, { keepTurns: 10, maxChars: 100_000 })
    expect(ctx.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    expect(ctx.messages[4].content).toBe('[Report from project web]\nWeb is done\n\ngreat')

    const plan = planFold(history, { keepTurns: 1, maxChars: 100_000 })!
    expect(plan.toFold.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'report'])
  })

  it('always keeps the newest turn even when it alone exceeds the character budget', () => {
    const history = [msg('user', 'x'.repeat(50)), msg('assistant', 'y'.repeat(50))]
    const ctx = buildContext(history, { keepTurns: 5, maxChars: 10 })
    expect(ctx.messages).toHaveLength(2)
    expect(ctx.droppedTurns).toBe(0)
  })

  it('cleans model titles and builds fallbacks', () => {
    expect(cleanGeneratedTitle('Title: "Ship it!"\nextra')).toBe('Ship it')
    expect(fallbackTitle('  hello   world ')).toBe('hello world')
    expect(fallbackTitle('')).toBe('New session')
    expect(fallbackTitle('one two three four five six seven')).toBe('one two three four five six…')
  })
})
