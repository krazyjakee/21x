import { describe, it, expect } from 'vitest'
import { assembleSessionConfig, mcpOptionsForTask } from './session-config'
import { buildCaptainSystemPrompt } from '../prompts/captain'
import type { AgentRecord, DatabaseManager, TaskRecord } from '../database'

const BACKENDS = ['opencode', 'claude-code', 'codex', 'cursor', 'pi'] as const
const AGENT_PROMPT = 'You are a careful backend specialist.'

function agentFor(backend: typeof BACKENDS[number]): AgentRecord {
  return {
    id: `agent-${backend}`,
    name: backend,
    config: { coding_agent: backend, system_prompt: AGENT_PROMPT }
  } as unknown as AgentRecord
}

/**
 * A store with no projects: a coordinator session then gets the built-in
 * prompt and its (empty) memory section, and nothing else.
 */
const EMPTY_DB = {
  getProject: () => undefined,
  getProjectRepos: () => [],
  getProjectResources: () => [],
  getSetting: () => null
} as unknown as DatabaseManager

/** `null` means the agent has no system prompt (`undefined` would pick the default). */
function configFor(backend: typeof BACKENDS[number], task: Partial<TaskRecord>, systemPrompt: string | null = AGENT_PROMPT, db: DatabaseManager = EMPTY_DB) {
  const agent = agentFor(backend)
  return assembleSessionConfig(db, agent, {
    agentId: agent.id,
    taskId: task.id as string,
    task: task as TaskRecord,
    workspaceDir: '/tmp/ws',
    mcpServers: {},
    systemPrompt: systemPrompt ?? undefined
  })
}

describe('assembleSessionConfig system prompt', () => {
  const captain: Partial<TaskRecord> = { id: 'mm-1', title: 'Captain', role: 'captain', agent_id: null }
  const ordinary: Partial<TaskRecord> = { id: 'task-1', title: 'Fix login', role: 'task', agent_id: 'agent-x' }
  const builtIn = buildCaptainSystemPrompt()

  for (const backend of BACKENDS) {
    it(`gives a ${backend} coordinator session the built-in prompt, then the agent prompt`, () => {
      const prompt = configFor(backend, captain).systemPrompt ?? ''
      expect(prompt.startsWith(builtIn)).toBe(true)
      expect(prompt.indexOf(AGENT_PROMPT)).toBeGreaterThan(builtIn.length - 1)
    })

    it(`leaves a ${backend} ordinary task session without the built-in prompt`, () => {
      expect(configFor(backend, ordinary).systemPrompt).toBe(AGENT_PROMPT)
    })
  }

  it('gives a coordinator session the built-in prompt when the agent has none', () => {
    const prompt = configFor('opencode', captain, null).systemPrompt ?? ''
    expect(prompt.startsWith(builtIn)).toBe(true)
    // With no project row there is no project section; the memory section is always there.
    expect(prompt).not.toContain('## Project context')
    expect(prompt).toContain('## Project memory')
  })

  it("gives a coordinator session its project's context, then the agent prompt (#55)", () => {
    const db = {
      getProject: (id: string) => id === 'proj-a'
        ? { id, name: 'Alpha', description: 'Alpha brief.', git_provider: null, git_org: 'acme', archived: false }
        : undefined,
      getProjectRepos: () => [{ id: 'r1', project_id: 'proj-a', provider: 'github', org: '', name: 'alpha-api', default_branch: 'main', sort_order: 0, created_at: '' }],
      getProjectResources: () => [{ id: 'x1', project_id: 'proj-a', label: 'Runbook', url: 'https://wiki/runbook', notes: '', sort_order: 0, created_at: '' }],
      getSetting: () => null
    } as unknown as DatabaseManager
    const prompt = configFor('claude-code', { ...captain, project_id: 'proj-a' }, AGENT_PROMPT, db).systemPrompt ?? ''
    expect(prompt.startsWith(builtIn)).toBe(true)
    expect(prompt).toContain('**Alpha**')
    expect(prompt).toContain('Alpha brief.')
    expect(prompt).toContain('acme/alpha-api (github, default branch `main`)')
    expect(prompt).toContain('Runbook — https://wiki/runbook')
    expect(prompt.indexOf('## Project context')).toBeLessThan(prompt.indexOf('## Project memory'))
    expect(prompt.indexOf('## Project memory')).toBeLessThan(prompt.indexOf(AGENT_PROMPT))
  })

  it('still runs a coordinator session on the built-in prompt when the context cannot be built', () => {
    const broken = { getProject: () => { throw new Error('db closed') } } as unknown as DatabaseManager
    const prompt = configFor('opencode', { ...captain, project_id: 'proj-a' }, AGENT_PROMPT, broken).systemPrompt ?? ''
    expect(prompt.startsWith(builtIn)).toBe(true)
    expect(prompt.endsWith(AGENT_PROMPT)).toBe(true)
  })

  it('gives every backend the same coordinator prompt', () => {
    const prompts = new Set(BACKENDS.map((backend) => configFor(backend, captain).systemPrompt))
    expect(prompts.size).toBe(1)
  })
})

describe('mcpOptionsForTask scopes (#56)', () => {
  it('gives a top-level task the project scope of its project', () => {
    const opts = mcpOptionsForTask('t1', { id: 't1', project_id: 'proj-a', parent_task_id: null } as unknown as TaskRecord, null, 'agent-a')
    expect(opts).toMatchObject({ projectId: 'proj-a', taskId: 't1', agentId: 'agent-a', taskScope: undefined, artifactTaskId: 't1' })
  })

  it('keeps the subtask scope for a subtask, with no project scope', () => {
    const opts = mcpOptionsForTask('c1', { id: 'c1', project_id: 'proj-a', parent_task_id: 'p1' } as unknown as TaskRecord, null, 'agent-a')
    expect(opts).toMatchObject({ taskId: 'c1', agentId: 'agent-a', taskScope: { taskId: 'c1', parentTaskId: 'p1' }, projectId: undefined })
  })

  it("gives the Captain the project scope of its row's project", () => {
    const opts = mcpOptionsForTask('mm', { id: 'mm', role: 'captain', project_id: 'default', parent_task_id: null } as unknown as TaskRecord)
    expect(opts).toMatchObject({ projectId: 'default', artifactTaskId: undefined })
  })

  it('leaves a session with no task row unscoped', () => {
    expect(mcpOptionsForTask('heartbeat-x', null).projectId).toBeUndefined()
  })

  it("confines a heartbeat session to the checked task's project without forcing the tool on", () => {
    const checked = { id: 'x', project_id: 'proj-b', parent_task_id: null } as unknown as TaskRecord
    expect(mcpOptionsForTask('heartbeat-x', null, checked)).toEqual({ ensureTaskManagement: false, projectId: 'proj-b', artifactTaskId: 'x' })
  })
})
