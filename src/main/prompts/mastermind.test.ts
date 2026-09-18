import { describe, it, expect } from 'vitest'
import { buildMastermindSystemPrompt, withMastermindSystemPrompt } from './mastermind'
import { FULL_ACCESS_SCOPE, listToolsForScope } from '../mcp-servers/task-management-core'

describe('buildMastermindSystemPrompt', () => {
  it('references only task-management tools the Mastermind really has', () => {
    const tools = new Set(listToolsForScope(FULL_ACCESS_SCOPE).map((tool) => tool.name))
    const referenced = [...buildMastermindSystemPrompt().matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
    expect(referenced.length).toBeGreaterThan(10)
    expect(referenced.filter((name) => !tools.has(name))).toEqual([])
  })

  it('covers the job: planning, agents, sessions, approvals, similar tasks', () => {
    const prompt = buildMastermindSystemPrompt()
    for (const tool of ['create_subtask', 'list_agents', 'start_task', 'wait_for_subtasks', 'list_pending_approvals', 'respond_to_checkpoint', 'find_similar_tasks']) {
      expect(prompt).toContain(`\`${tool}\``)
    }
  })

  it('appends per-project context only when given', () => {
    expect(buildMastermindSystemPrompt({ projectContext: '  ' })).toBe(buildMastermindSystemPrompt())
    const withContext = buildMastermindSystemPrompt({ projectContext: 'Use pnpm.' })
    expect(withContext.startsWith(buildMastermindSystemPrompt())).toBe(true)
    expect(withContext).toContain('## Project context\n\nUse pnpm.')
  })

  it('puts the agent prompt after the built-in prompt', () => {
    const prompt = withMastermindSystemPrompt('Be terse.')
    expect(prompt.startsWith(buildMastermindSystemPrompt())).toBe(true)
    expect(prompt.endsWith('Be terse.')).toBe(true)
  })
})
