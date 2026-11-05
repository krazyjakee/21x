import { devNull } from 'os'
import { describe, it, expect, vi } from 'vitest'
import { assembleSessionConfig, mcpOptionsForTask } from './session-config'
import { assembleSessionConfig as assemblePortableSessionConfig } from './session-config-core'
import type { SessionConfigHost } from './host'
import { buildCaptainSystemPrompt } from '../prompts/captain'
import type { AgentRecord, DatabaseManager, TaskRecord } from '../database'

// These prompts must not depend on whether the machine running the tests has RTK.
vi.mock('../adapters/shared/rtk-session', async importOriginal => ({
  ...await importOriginal<typeof import('../adapters/shared/rtk-session')>(),
  findRtkExecutable: () => null
}))

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
    const opts = mcpOptionsForTask('t1', { id: 't1', project_id: 'proj-a', parent_task_id: null } as unknown as TaskRecord, null, 'agent-a', 'nonce-a')
    expect(opts).toMatchObject({ projectId: 'proj-a', taskId: 't1', agentId: 'agent-a', sessionNonce: 'nonce-a', taskScope: undefined, artifactTaskId: 't1' })
  })

  it('keeps the subtask scope for a subtask, with no project scope', () => {
    const opts = mcpOptionsForTask('c1', { id: 'c1', project_id: 'proj-a', parent_task_id: 'p1' } as unknown as TaskRecord, null, 'agent-a', 'nonce-a')
    expect(opts).toMatchObject({ taskId: 'c1', agentId: 'agent-a', sessionNonce: 'nonce-a', taskScope: { taskId: 'c1', parentTaskId: 'p1' }, projectId: undefined })
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

describe('assembleSessionConfig access', () => {
  const task: Partial<TaskRecord> = { id: 'task-1', title: 'Fix login', role: 'task', agent_id: 'agent-x' }
  const configWith = (extra: Record<string, unknown>) => {
    const agent = { id: 'agent-a', name: 'a', config: { coding_agent: 'claude-code', ...extra } } as unknown as AgentRecord
    return assembleSessionConfig(EMPTY_DB, agent, { agentId: agent.id, taskId: 'task-1', task: task as TaskRecord, workspaceDir: '/tmp/ws', mcpServers: {} })
  }

  for (const backend of BACKENDS) {
    it(`runs a ${backend} agent at full access and no sandbox`, () => {
      const config = configFor(backend, task)
      expect(config.permissionMode).toBe('allow')
      expect(config.sandboxMode).toBe('danger-full-access')
    })
  }

  it('ignores a stored ask or sandbox setting: there is no permission setting', () => {
    const config = configWith({ permission_mode: 'ask', sandbox_mode: 'read-only' })
    expect(config.permissionMode).toBe('allow')
    expect(config.sandboxMode).toBe('danger-full-access')
  })
})

describe('assembleSessionConfig RTK', () => {
  const RTK_PATH = '/opt/bin/rtk'
  const INSTRUCTION = 'Prefix shell commands with `rtk`'
  const OFF = 'RTK is turned off for this session'
  const ordinary = { id: 'task-1', title: 'Fix login', role: 'task', agent_id: 'agent-x' } as unknown as TaskRecord
  const captain = { id: 'mm-1', title: 'Captain', role: 'captain', agent_id: null } as unknown as TaskRecord

  function rtkConfig(
    backend: typeof BACKENDS[number],
    setting: string | null,
    executable: string | null,
    { task = ordinary, agentConfig = {} }: { task?: TaskRecord; agentConfig?: Record<string, unknown> } = {}
  ) {
    const base = agentFor(backend)
    const agent = { ...base, config: { ...base.config, ...agentConfig } } as AgentRecord
    const db = {
      ...EMPTY_DB,
      getSetting: (key: string) => key === 'rtk_enabled' ? setting : null,
      getSecretsByIds: () => [],
      getSecretsWithValues: () => [{ env_var_name: 'API_TOKEN', value: 'canary-secret-value' }]
    } as unknown as DatabaseManager
    const host: SessionConfigHost = {
      secrets: { kind: 'broker', getPort: () => null, register: () => undefined, unregister: () => undefined, writeShellWrapper: () => '/tmp/shell' },
      configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' },
      findRtkExecutable: () => executable
    }
    return assemblePortableSessionConfig(db, agent, {
      agentId: agent.id, taskId: task.id, task, workspaceDir: '/tmp/ws', mcpServers: {}, systemPrompt: AGENT_PROMPT
    }, host)
  }

  for (const backend of ['claude-code', 'opencode', 'pi'] as const) {
    it(`rewrites ${backend} commands by default and tells the agent how to get raw output`, () => {
      const config = rtkConfig(backend, null, RTK_PATH)
      expect(config.rtkExecutable).toBe(RTK_PATH)
      expect(config.rtkEnv).toBeUndefined()
      expect(config.systemPrompt).toContain(AGENT_PROMPT)
      expect(config.systemPrompt).toContain('rtk proxy <command>')
      expect(config.systemPrompt).not.toContain(INSTRUCTION)
    })
  }

  for (const backend of ['codex', 'cursor'] as const) {
    it(`gives ${backend} an instruction by default, not a rewrite it cannot perform`, () => {
      const config = rtkConfig(backend, null, RTK_PATH)
      expect(config.rtkExecutable).toBeUndefined()
      expect(config.systemPrompt).toContain(AGENT_PROMPT)
      expect(config.systemPrompt).toContain(INSTRUCTION)
    })
  }

  it('reaches Captain sessions the same way as task sessions', () => {
    expect(rtkConfig('claude-code', null, RTK_PATH, { task: captain }).rtkExecutable).toBe(RTK_PATH)
    expect(rtkConfig('codex', null, RTK_PATH, { task: captain }).systemPrompt).toContain(INSTRUCTION)
  })

  for (const backend of BACKENDS) {
    it(`honours the opt-out on ${backend}`, () => {
      const config = rtkConfig(backend, 'false', RTK_PATH)
      expect(config.rtkExecutable).toBeUndefined()
      expect(config.rtkEnv).toEqual({ RTK_DISABLED: '1' })
      expect(config.systemPrompt).toContain(OFF)
      expect(config.systemPrompt).not.toContain(INSTRUCTION)
    })

    it(`honours the opt-out on ${backend} even when RTK was not found, because a global hook may still use it`, () => {
      const config = rtkConfig(backend, 'false', null)
      expect(config.rtkEnv).toEqual({ RTK_DISABLED: '1' })
      expect(config.systemPrompt).toContain(OFF)
    })

    it(`leaves ${backend} sessions untouched when RTK is unavailable`, () => {
      for (const setting of [null, 'true']) {
        const config = rtkConfig(backend, setting, null)
        expect(config.rtkExecutable).toBeUndefined()
        expect(config.rtkEnv).toBeUndefined()
        expect(config.systemPrompt).toBe(AGENT_PROMPT)
      }
    })

    // The shell expands $API_TOKEN before rtk starts, so RTK would store the value.
    for (const [kind, agentConfig] of [
      ['secrets', { secret_ids: ['secret-1'] }],
      ['its own API key', { api_keys: { openai: 'canary-secret-value' } }]
    ] as const) {
      it(`never lets RTK near a ${backend} session with ${kind}, even with RTK on`, () => {
        const config = rtkConfig(backend, null, RTK_PATH, { agentConfig })
        expect(config.rtkExecutable).toBeUndefined()
        expect(config.systemPrompt).not.toContain(INSTRUCTION)
        expect(config.systemPrompt).toContain(OFF)
        expect(config.rtkEnv).toEqual({ RTK_DISABLED: '1', RTK_DB_PATH: devNull, RTK_RECALL: '0', RTK_TEE: '0' })
      })
    }

    it(`stops storage in a ${backend} session with secrets even when RTK was not found`, () => {
      const config = rtkConfig(backend, null, null, { agentConfig: { secret_ids: ['secret-1'] } })
      expect(config.rtkEnv).toMatchObject({ RTK_DB_PATH: devNull })
      expect(config.systemPrompt).not.toContain(OFF)
    })
  }

  it('leaves sessions untouched on a host that cannot look for RTK', () => {
    const agent = agentFor('claude-code')
    const host: SessionConfigHost = { secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' } }
    const config = assemblePortableSessionConfig(EMPTY_DB, agent, {
      agentId: agent.id, taskId: 'task-1', task: ordinary, workspaceDir: '/tmp/ws', mcpServers: {}, systemPrompt: AGENT_PROMPT
    }, host)
    expect(config.rtkExecutable).toBeUndefined()
    expect(config.rtkEnv).toBeUndefined()
    expect(config.systemPrompt).toBe(AGENT_PROMPT)
  })
})
