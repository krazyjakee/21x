import { describe, it, expect } from 'vitest'
import { assembleSessionConfig, mcpOptionsForTask } from './session-config'
import { buildMastermindSystemPrompt } from '../prompts/mastermind'
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

/** `null` means the agent has no system prompt (`undefined` would pick the default). */
function configFor(backend: typeof BACKENDS[number], task: Partial<TaskRecord>, systemPrompt: string | null = AGENT_PROMPT) {
  const agent = agentFor(backend)
  return assembleSessionConfig({} as DatabaseManager, agent, {
    agentId: agent.id,
    taskId: task.id as string,
    task: task as TaskRecord,
    workspaceDir: '/tmp/ws',
    mcpServers: {},
    systemPrompt: systemPrompt ?? undefined
  })
}

describe('assembleSessionConfig system prompt', () => {
  const mastermind: Partial<TaskRecord> = { id: 'mm-1', title: 'Mastermind', role: 'mastermind', agent_id: null }
  const ordinary: Partial<TaskRecord> = { id: 'task-1', title: 'Fix login', role: 'task', agent_id: 'agent-x' }
  const builtIn = buildMastermindSystemPrompt()

  for (const backend of BACKENDS) {
    it(`gives a ${backend} coordinator session the built-in prompt, then the agent prompt`, () => {
      const prompt = configFor(backend, mastermind).systemPrompt ?? ''
      expect(prompt.startsWith(builtIn)).toBe(true)
      expect(prompt.indexOf(AGENT_PROMPT)).toBeGreaterThan(builtIn.length - 1)
    })

    it(`leaves a ${backend} ordinary task session without the built-in prompt`, () => {
      expect(configFor(backend, ordinary).systemPrompt).toBe(AGENT_PROMPT)
    })
  }

  it('gives a coordinator session the built-in prompt when the agent has none', () => {
    expect(configFor('opencode', mastermind, null).systemPrompt).toBe(builtIn)
  })

  it('gives every backend the same coordinator prompt', () => {
    const prompts = new Set(BACKENDS.map((backend) => configFor(backend, mastermind).systemPrompt))
    expect(prompts.size).toBe(1)
  })
})

describe('mcpOptionsForTask scopes (#56)', () => {
  it('gives a top-level task the project scope of its project', () => {
    const opts = mcpOptionsForTask('t1', { id: 't1', project_id: 'proj-a', parent_task_id: null } as unknown as TaskRecord)
    expect(opts).toMatchObject({ projectId: 'proj-a', taskScope: undefined, artifactTaskId: 't1' })
  })

  it('keeps the subtask scope for a subtask, with no project scope', () => {
    const opts = mcpOptionsForTask('c1', { id: 'c1', project_id: 'proj-a', parent_task_id: 'p1' } as unknown as TaskRecord)
    expect(opts).toMatchObject({ taskScope: { taskId: 'c1', parentTaskId: 'p1' }, projectId: undefined })
  })

  it("gives the Mastermind the project scope of its row's project", () => {
    const opts = mcpOptionsForTask('mm', { id: 'mm', role: 'mastermind', project_id: 'default', parent_task_id: null } as unknown as TaskRecord)
    expect(opts).toMatchObject({ projectId: 'default', artifactTaskId: undefined })
  })

  it('leaves a session with no task row unscoped', () => {
    expect(mcpOptionsForTask('heartbeat-x', null).projectId).toBeUndefined()
  })

  it("confines a heartbeat session to the checked task's project without forcing the tool on", () => {
    const checked = { id: 'x', project_id: 'proj-b', parent_task_id: null } as unknown as TaskRecord
    expect(mcpOptionsForTask('heartbeat-x', null, checked)).toEqual({ ensureTaskManagement: false, projectId: 'proj-b' })
  })
})

