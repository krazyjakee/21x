import { describe, it, expect } from 'vitest'
import { buildCaptainSystemPrompt, withCaptainSystemPrompt } from './captain'
import { FULL_ACCESS_SCOPE, listToolsForScope } from '../mcp-servers/task-management-core'

describe('buildCaptainSystemPrompt', () => {
  it('references only task-management tools the Captain really has', () => {
    const tools = new Set(listToolsForScope(FULL_ACCESS_SCOPE).map((tool) => tool.name))
    const referenced = [...buildCaptainSystemPrompt().matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
    expect(referenced.length).toBeGreaterThan(10)
    expect(referenced.filter((name) => !tools.has(name))).toEqual([])
  })

  it('covers the job: planning, agents, sessions, approvals, similar tasks', () => {
    const prompt = buildCaptainSystemPrompt()
    for (const tool of ['create_subtask', 'list_agents', 'start_task', 'wait_for_subtasks', 'list_pending_approvals', 'respond_to_checkpoint', 'find_similar_tasks']) {
      expect(prompt).toContain(`\`${tool}\``)
    }
  })

  it('appends per-project context only when given', () => {
    expect(buildCaptainSystemPrompt({ projectContext: '  ' })).toBe(buildCaptainSystemPrompt())
    const withContext = buildCaptainSystemPrompt({ projectContext: 'Use pnpm.' })
    expect(withContext.startsWith(buildCaptainSystemPrompt())).toBe(true)
    expect(withContext).toContain('## Project context\n\nUse pnpm.')
  })

  it('adds the memory section with its rule, path and content (#55)', () => {
    const memory = { path: '/ws/mm/MEMORY.md', content: '- Convention: squash merges.', truncated: false }
    const prompt = buildCaptainSystemPrompt({ projectContext: 'Project Alpha.', memory })
    expect(prompt.indexOf('## Project context')).toBeLessThan(prompt.indexOf('## Project memory'))
    expect(prompt).toContain('Your memory file is /ws/mm/MEMORY.md.')
    expect(prompt).toContain('- Convention: squash merges.')
    expect(prompt).not.toContain('cut here')

    const cut = buildCaptainSystemPrompt({ memory: { ...memory, truncated: true } })
    expect(cut).toContain('cut here')

    const empty = buildCaptainSystemPrompt({ memory: { ...memory, content: '' } })
    expect(empty).toContain('_The file does not exist yet.')
    expect(empty).not.toContain('Current content:')
  })

  it('puts the agent prompt after the built-in prompt', () => {
    const prompt = withCaptainSystemPrompt('Be terse.')
    expect(prompt.startsWith(buildCaptainSystemPrompt())).toBe(true)
    expect(prompt.endsWith('Be terse.')).toBe(true)
  })
})
