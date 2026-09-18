import { describe, it, expect } from 'vitest'
import { assembleSessionConfig } from './session-config'
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
