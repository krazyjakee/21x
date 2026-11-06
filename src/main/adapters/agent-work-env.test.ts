/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { AGENT_WORK_MARKER } from '../../shared/agent-work-marker'
import { AcpAdapter } from './acp-adapter'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import { PiAdapter } from './pi-adapter'
import type { SessionConfig } from './coding-agent-adapter'

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn()
}))

const config: SessionConfig = { agentId: 'agent', taskId: 'task', workspaceDir: '/workspace' }

describe('agent process environment', () => {
  // An agent running this suite has the marker itself, so start from a known state.
  beforeEach(() => { vi.stubEnv(AGENT_WORK_MARKER, undefined) })
  afterEach(() => { vi.mocked(spawn).mockReset(); vi.unstubAllEnvs() })

  // The workspace sweep can only tell agent work from a user's own process on
  // Linux by this marker, so an agent backend without it leaks silently.
  it('marks every agent process 21x spawns, with process.env left unmarked', async () => {
    const seen: Array<Record<string, unknown>> = [
      (new ClaudeCodeAdapter() as any).buildClaudeEnvironment(config),
      (new CodexAppServerAdapter() as any).buildEnvironment(config).env,
      (new PiAdapter() as any).processEnv(config)
    ]
    vi.mocked(spawn).mockImplementation(() => { throw new Error('stop at the spawn') })
    await expect((new AcpAdapter('cursor') as any).startSession('session', null, config)).rejects.toThrow()
    seen.push(vi.mocked(spawn).mock.calls[0][2].env as Record<string, unknown>)

    for (const env of seen) expect(env[AGENT_WORK_MARKER]).toBe('1')
    expect(process.env[AGENT_WORK_MARKER]).toBeUndefined()
  })
})
