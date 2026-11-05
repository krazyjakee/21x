import { describe, expect, it } from 'vitest'
import { AGENT_DELETION_REFUSAL_LIMIT, AgentDeletionRefused, describeAgentDeletion, isPluginUninstallResult, isAgentDeletionImpact, isAgentDeletionRefusal, refusalOf, type AgentDeletionImpact } from './agent-deletion'

const empty = { total: 0, items: [] }
const impact = (fields: Partial<AgentDeletionImpact> = {}): AgentDeletionImpact => ({
  agent_id: 'agent', agent_name: 'Fable', running: empty, queued: empty, unassigned_tasks: empty, recurring_tasks: empty, recurring_auto_start: 0,
  dissolved_groups: empty, fallback_agents: empty, captain_projects: empty, default_projects: empty, concurrency_projects: empty,
  commander_cleared: false, was_default: false, replacement_default: null, last_agent: false, ...fields
})
const list = (...titles: string[]) => ({ total: titles.length, items: titles.map((title, index) => ({ id: `id-${index}`, title })) })

describe('agent deletion wording', () => {
  it('says nothing when nothing is touched', () => {
    expect(describeAgentDeletion(impact())).toEqual({ stops: [], changes: [] })
  })
  it('separates what stops from what is merely unassigned', () => {
    const lines = describeAgentDeletion(impact({ running: list('Build'), queued: list('Later'), unassigned_tasks: list('Open') }))
    expect(lines.stops).toEqual(['1 running session of this agent: “Build”', '1 queued start: “Later”'])
    expect(lines.changes).toEqual(['1 task left without an agent, still on the board: “Open”'])
  })
  it('counts past the names it shows', () => {
    expect(describeAgentDeletion(impact({ unassigned_tasks: list('A', 'B', 'C', 'D', 'E') })).changes[0]).toContain('“C” and 2 more')
  })
  it('warns about a recurring task that starts itself, in the singular and the plural', () => {
    expect(describeAgentDeletion(impact({ recurring_tasks: list('Nightly'), recurring_auto_start: 1 })).changes[0]).toContain('One starts itself')
    expect(describeAgentDeletion(impact({ recurring_tasks: list('A', 'B'), recurring_auto_start: 2 })).changes[0]).toContain('2 start themselves')
  })
  it('states both default outcomes and the last agent plainly', () => {
    expect(describeAgentDeletion(impact({ was_default: true, replacement_default: { id: 'next', name: 'Astra' } })).changes).toEqual(['“Astra” becomes the default agent.'])
    expect(describeAgentDeletion(impact({ was_default: true, last_agent: true })).changes).toEqual(['There will be no default agent.', 'This is your last agent. Nothing can run until you add another.'])
  })
})

describe('agent deletion wire shapes', () => {
  it('accepts an impact and refuses a malformed or oversized one', () => {
    expect(isAgentDeletionImpact(impact())).toBe(true)
    expect(isAgentDeletionImpact({ ...impact(), running: undefined })).toBe(false)
    expect(isAgentDeletionImpact({ ...impact(), agent_id: '' })).toBe(false)
    expect(isAgentDeletionImpact(impact({ running: { total: 21, items: Array.from({ length: 21 }, (_, index) => ({ id: `${index}`, title: 'x' })) } }))).toBe(false)
  })
  it('bounds a long refusal, which still reads as a refusal rather than a report', () => {
    const refusal = refusalOf(new AgentDeletionRefused('x'.repeat(3000)))
    expect(refusal.refused).toHaveLength(AGENT_DELETION_REFUSAL_LIMIT)
    expect(isAgentDeletionRefusal({ refused: 'x'.repeat(3000) })).toBe(true)
  })
  it('says what had already stopped, and says nothing when nothing had', () => {
    expect(new AgentDeletionRefused('Not deleted.').message).toBe('Not deleted.')
    expect(new AgentDeletionRefused('Not deleted.', 1, 2).message).toBe('Not deleted. Already done: 1 session stopped, 2 queued starts withdrawn.')
  })
  it('adds up what each layer stopped without repeating the sentence', () => {
    expect(new AgentDeletionRefused('Not deleted.', 1, 0).after(2, 1).message).toBe('Not deleted. Already done: 3 sessions stopped, 1 queued start withdrawn.')
  })
  it('carries an uninstall report, a refusal or false, and nothing else', () => {
    expect(isPluginUninstallResult([impact()])).toBe(true)
    expect(isPluginUninstallResult([])).toBe(true)
    expect(isPluginUninstallResult(false)).toBe(true)
    expect(isPluginUninstallResult({ refused: 'named' })).toBe(true)
    expect(isPluginUninstallResult(true)).toBe(false)
    expect(isPluginUninstallResult([{ agent_id: 'partial' }])).toBe(false)
  })
  it('turns only a named refusal into a result, so real failures still surface', () => {
    expect(refusalOf(new AgentDeletionRefused('named'))).toEqual({ refused: 'named' })
    expect(() => refusalOf(new Error('bug'))).toThrow('bug')
    expect(isAgentDeletionRefusal({ refused: 'named' })).toBe(true)
    expect(isAgentDeletionRefusal(true)).toBe(false)
    expect(isAgentDeletionRefusal(impact())).toBe(false)
  })
})
