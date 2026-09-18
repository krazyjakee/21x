import { describe, it, expect, vi } from 'vitest'
import {
  flattenProviderModels,
  orderedSkillIds,
  preferredModelProblem,
  resolveSkillModel
} from './skill-model'
import { assembleSessionConfig } from './session-config'
import type { AgentRecord, DatabaseManager, SkillRecord, TaskRecord } from '../database'

const skill = (name: string, preferred_model: string | null) => ({ name, preferred_model })

describe('orderedSkillIds', () => {
  it('puts task skills first, then agent skills, without repeats', () => {
    expect(orderedSkillIds(['b', 'a'], ['a', 'c'])).toEqual(['b', 'a', 'c'])
    expect(orderedSkillIds(null, undefined)).toEqual([])
  })
})

describe('resolveSkillModel', () => {
  const available = ['anthropic/claude-sonnet-5', 'openai/gpt-5.5']

  it('keeps the agent model when no skill has a preference', () => {
    const r = resolveSkillModel({ agentModel: 'openai/gpt-5.5', backend: 'opencode', skills: [skill('a', null)], availableModels: available })
    expect(r).toEqual({ model: 'openai/gpt-5.5', source: 'agent', notice: undefined })
  })

  it('uses the first skill, in order, whose preferred model is available', () => {
    const r = resolveSkillModel({
      agentModel: 'openai/gpt-5.5',
      backend: 'opencode',
      skills: [skill('first', null), skill('second', 'anthropic/claude-sonnet-5'), skill('third', 'openai/gpt-5.5')],
      availableModels: available
    })
    expect(r.model).toBe('anthropic/claude-sonnet-5')
    expect(r.source).toBe('skill')
    expect(r.skillName).toBe('second')
    expect(r.notice).toBeUndefined()
  })

  it('skips an unavailable preference and says why', () => {
    const r = resolveSkillModel({
      agentModel: 'openai/gpt-5.5',
      backend: 'opencode',
      skills: [skill('gone', 'google/gemini-9'), skill('ok', 'anthropic/claude-sonnet-5')],
      availableModels: available
    })
    expect(r.model).toBe('anthropic/claude-sonnet-5')
    expect(r.skillName).toBe('ok')
    expect(r.notice).toContain('"gone" prefers google/gemini-9')
  })

  it('falls back to the agent model when no preference is usable', () => {
    const r = resolveSkillModel({
      agentModel: 'openai/gpt-5.5',
      backend: 'opencode',
      skills: [skill('gone', 'google/gemini-9')],
      availableModels: available
    })
    expect(r.model).toBe('openai/gpt-5.5')
    expect(r.source).toBe('agent')
    expect(r.notice).toMatch(/using the agent model openai\/gpt-5\.5/)
  })

  it('leaves the backend default when the agent has no model and nothing resolves', () => {
    const r = resolveSkillModel({ backend: 'claude-code', skills: [skill('x', 'openai/gpt-5.5')] })
    expect(r.model).toBeUndefined()
    expect(r.notice).toContain('not supported by the claude-code backend')
  })
})

describe('preferredModelProblem', () => {
  it('checks against a known listing', () => {
    expect(preferredModelProblem('a/b', 'opencode', ['a/b'])).toBeNull()
    expect(preferredModelProblem('a/c', 'opencode', ['a/b'])).toMatch(/not offered/)
  })

  it('checks the id shape when the backend cannot list models', () => {
    expect(preferredModelProblem('claude-opus-5', 'claude-code')).toBeNull()
    expect(preferredModelProblem('gpt-5.5', 'claude-code')).toMatch(/not a Claude model/)
    expect(preferredModelProblem('gpt-5.5', 'codex')).toBeNull()
    expect(preferredModelProblem('anthropic/claude-opus-5', 'codex')).toMatch(/not supported/)
    expect(preferredModelProblem('claude-opus-5', 'opencode')).toMatch(/provider\/model/)
  })
})

describe('flattenProviderModels', () => {
  it('handles array and keyed model maps', () => {
    expect(flattenProviderModels({
      providers: [
        { id: 'a', models: [{ id: 'm1' }] },
        { id: 'b', models: { m2: { name: 'M2' }, k: { id: 'm3' } } }
      ]
    })).toEqual(['a/m1', 'b/m2', 'b/m3'])
    expect(flattenProviderModels(null)).toEqual([])
  })
})

describe('assembleSessionConfig model', () => {
  const skills: Record<string, Partial<SkillRecord>> = {
    s1: { id: 's1', name: 'writer', preferred_model: null },
    s2: { id: 's2', name: 'reviewer', preferred_model: 'claude-opus-5' },
    s3: { id: 's3', name: 'other', preferred_model: 'claude-haiku-4-5' }
  }
  const db = {
    getSkillsByIds: vi.fn((ids: string[]) => ids.map((id) => skills[id]).filter(Boolean))
  } as unknown as DatabaseManager

  function build(agentSkillIds: string[], taskSkillIds: string[] | null, onModelNotice?: (n: string) => void) {
    const agent = {
      id: 'agent-1',
      name: 'cc',
      config: { coding_agent: 'claude-code', model: 'claude-sonnet-5', skill_ids: agentSkillIds }
    } as unknown as AgentRecord
    const config = assembleSessionConfig(db, agent, {
      agentId: agent.id,
      taskId: 'task-1',
      task: { id: 'task-1', role: 'task', agent_id: 'agent-1', skill_ids: taskSkillIds } as unknown as TaskRecord,
      workspaceDir: '/tmp/ws',
      mcpServers: {},
      onModelNotice
    })
    return { agent, config }
  }

  it('uses the task skill preference over the agent skill preference, for this session only', () => {
    const { agent, config } = build(['s3'], ['s1', 's2'])
    expect(config.model).toBe('claude-opus-5')
    expect(agent.config.model).toBe('claude-sonnet-5')
  })

  it('keeps the agent model with no skills attached', () => {
    expect(build([], null).config.model).toBe('claude-sonnet-5')
  })

  it('falls back to the agent model and reports why when the preference is not usable', () => {
    skills.s2 = { id: 's2', name: 'reviewer', preferred_model: 'openai/gpt-5.5' }
    const notices: string[] = []
    const { config } = build([], ['s2'], (n) => notices.push(n))
    expect(config.model).toBe('claude-sonnet-5')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('reviewer')
  })
})
