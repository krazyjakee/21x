import { nodeWorkerRuntime } from '../node-worker-runtime'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('child_process', () => ({
  spawn: spawnMock,
  execFile: vi.fn(),
}))

import { PiAdapter } from './pi-adapter'
import {
  buildPiMcpConfigDocument,
  sanitizePiMcpServerName,
  sanitizePiSessionName,
  slugPiMcpServers,
  withProviderNameLimitHint,
} from './pi-config'
import { MessagePartType } from './coding-agent-adapter'

function fakeProcess() {
  const process = new EventEmitter() as EventEmitter & Record<string, any>
  process.pid = 12345
  process.exitCode = null
  process.stdin = {
    writable: true,
    write: vi.fn((_value: string, callback?: (error?: Error | null) => void) => {
      callback?.(null)
      return true
    }),
  }
  process.stdout = new EventEmitter()
  process.stderr = new EventEmitter()
  process.kill = vi.fn(() => true)
  return process
}

// The adapter strips variables set by a parent agent harness (see processEnv),
// so the expectation must too, or the test fails when run from inside an agent.
function expectedPiEnv(): NodeJS.ProcessEnv {
  const env = { ...nodeWorkerRuntime().env }
  delete env.AI_AGENT
  delete env.PI_CODING_AGENT
  delete env.MCP_DIRECT_TOOLS
  return env
}

function fakeSession(process = fakeProcess()): any {
  return {
    id: 'session-1',
    process,
    config: {
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceDir: '/workspace',
      permissionMode: 'ask',
    },
    status: 'busy',
    lastError: null,
    pending: new Map(),
    parts: [],
    allMessages: [],
    textByBlock: new Map(),
    reasoningByBlock: new Map(),
    toolParts: new Map(),
    pendingUiRequests: new Map(),
    turn: 1,
    assistantMessageOrdinal: 0,
    pendingTurnError: null,
    pendingTurnErrorMonotonicTime: null,
    sawAgentActivity: true,
    promptMayBeCommandOnly: false,
    closing: false,
  }
}

describe('PiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the native Pi session file and applies model selection through RPC', async () => {
    const child = fakeProcess()
    spawnMock.mockReturnValue(child)
    const adapter = new PiAdapter()
    vi.spyOn(adapter as any, 'findPiExecutable').mockResolvedValue('/usr/local/bin/pi')
    vi.spyOn(adapter as any, 'removeLegacyGatewayProvider').mockReturnValue(undefined)
    vi.spyOn(adapter as any, 'buildMcpConfig').mockReturnValue(undefined)
    vi.spyOn(adapter as any, 'installPermissionExtension').mockReturnValue('/tmp/20x-permissions.ts')
    vi.spyOn(adapter as any, 'attachProcess').mockImplementation(() => undefined)
    const command = vi.spyOn(adapter as any, 'command')
      .mockResolvedValueOnce({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionFile: '/sessions/native-session.jsonl' },
      })
      .mockResolvedValueOnce({ type: 'response', command: 'set_model', success: true })

    const id = await adapter.createSession({
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceDir: '/workspace',
      model: 'anthropic/model-one',
      permissionMode: 'ask',
    })

    expect(id).toBe('/sessions/native-session.jsonl')
    expect(spawnMock.mock.calls[0][0]).toBe(nodeWorkerRuntime().execPath)
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args[0]).toBe('/usr/local/bin/pi')
    expect(args).toContain('--mode')
    expect(args).toContain('--extension')
    expect(args).not.toContain('--session-dir')
    expect(args).not.toContain('--provider')
    expect(args).not.toContain('--model')
    expect(spawnMock.mock.calls[0][2]).toMatchObject({
      env: expectedPiEnv(),
      shell: false,
    })
    expect(command).toHaveBeenLastCalledWith(
      expect.anything(),
      { type: 'set_model', provider: 'anthropic', modelId: 'model-one' },
    )
  })

  it('surfaces Pi stderr output in the error when the process exits before the first response', async () => {
    const child = fakeProcess()
    spawnMock.mockReturnValue(child)
    // Write to stderr and exit while the pending `get_state` RPC is in flight
    // — the silent early exit that left users guessing WHY the start failed.
    child.stdin.write = vi.fn((_value: string, callback?: (error?: Error | null) => void) => {
      child.stderr.emit('data', 'unknown model: cerebras/gpt-oss-120b\n')
      child.emit('exit', 1, null)
      child.exitCode = 1
      callback?.(null)
      return true
    })
    const adapter = new PiAdapter()
    vi.spyOn(adapter as any, 'findPiExecutable').mockResolvedValue('/usr/local/bin/pi')
    vi.spyOn(adapter as any, 'removeLegacyGatewayProvider').mockReturnValue(undefined)
    vi.spyOn(adapter as any, 'buildMcpConfig').mockReturnValue(undefined)
    vi.spyOn(adapter as any, 'installPermissionExtension').mockReturnValue('/tmp/20x-permissions.ts')

    const started = adapter.createSession({
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceDir: '/workspace',
      permissionMode: 'ask',
    })

    await expect(started).rejects.toThrow(/Pi process exited: unknown model: cerebras\/gpt-oss-120b/)
  })

  it('discovers the effective Pi model catalog through RPC', async () => {
    const child = fakeProcess()
    spawnMock.mockReturnValue(child)
    const adapter = new PiAdapter()
    vi.spyOn(adapter as any, 'findPiExecutable').mockResolvedValue('/usr/local/bin/pi')
    vi.spyOn(adapter as any, 'removeLegacyGatewayProvider').mockReturnValue(undefined)
    vi.spyOn(adapter as any, 'attachProcess').mockImplementation(() => undefined)
    vi.spyOn(adapter as any, 'terminateProcess').mockResolvedValue(undefined)
    vi.spyOn(adapter as any, 'command')
      .mockResolvedValueOnce({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { model: { provider: 'anthropic', id: 'model-one' } },
      })
      .mockResolvedValueOnce({
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: {
          models: [
            { provider: 'anthropic', id: 'model-one', name: 'Model One' },
            { provider: 'openai', id: 'model-two', name: 'Model Two' },
          ],
        },
      })

    await expect(adapter.getProviders(undefined, '/workspace')).resolves.toEqual({
      providers: [
        { id: 'anthropic', name: 'anthropic', models: [{ id: 'model-one', name: 'Model One' }] },
        { id: 'openai', name: 'openai', models: [{ id: 'model-two', name: 'Model Two' }] },
      ],
      default: { anthropic: 'model-one' },
    })
    expect(spawnMock.mock.calls[0][0]).toBe(nodeWorkerRuntime().execPath)
    expect(spawnMock.mock.calls[0][1]).toEqual([
      '/usr/local/bin/pi',
      '--mode',
      'rpc',
      '--no-session',
      '--approve',
    ])
    expect(spawnMock.mock.calls[0][2]).toMatchObject({
      env: expectedPiEnv(),
      shell: false,
    })
  })

  it('waits for agent_settled instead of agent_end', () => {
    const adapter = new PiAdapter()
    const session = fakeSession()

    ;(adapter as any).handleEvent(session, { type: 'agent_end' })
    expect(session.status).toBe('busy')

    ;(adapter as any).handleEvent(session, { type: 'agent_settled' })
    expect(session.status).toBe('idle')
  })

  it('steers an active Pi turn instead of queueing a follow-up', async () => {
    const adapter = new PiAdapter()
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    await adapter.sendPrompt(session.id, [{ type: MessagePartType.TEXT, text: 'Stop and do this instead' }], session.config)

    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'prompt',
        message: 'Stop and do this instead',
        streamingBehavior: 'steer',
      })}\n`,
      expect.any(Function),
    )
  })

  it('sends a normal prompt when Pi is idle', async () => {
    const adapter = new PiAdapter()
    const process = fakeProcess()
    const session = fakeSession(process)
    session.status = 'idle'
    ;(adapter as any).sessions.set(session.id, session)

    await adapter.sendPrompt(session.id, [{ type: MessagePartType.TEXT, text: 'Start work' }], session.config)

    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'prompt', message: 'Start work' })}\n`,
      expect.any(Function),
    )
  })

  it('routes Pi confirmation requests through the approval API', async () => {
    const adapter = new PiAdapter()
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'request-1',
      method: 'confirm',
      title: 'Allow bash?',
      message: 'Run a command',
    })

    expect(adapter.getPendingApproval(session.id)?.question).toContain('Run a command')
    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({
      type: 'waiting_approval',
      message: 'Pi is waiting for input',
    })

    await expect(adapter.respondToApproval(session.id, true)).resolves.toBe(true)
    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'extension_ui_response', id: 'request-1', confirmed: true })}\n`,
      expect.any(Function),
    )
    expect(adapter.getPendingApproval(session.id)).toBeNull()
    expect(session.parts.at(-1)).toMatchObject({
      id: 'question-request-1',
      type: 'question',
      update: true,
      tool: {
        name: 'permission',
        status: 'completed',
        requestId: 'request-1',
      },
    })
  })

  it('routes Pi select requests through structured questions', async () => {
    const adapter = new PiAdapter()
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'request-2',
      method: 'select',
      title: 'Environment',
      message: 'Select an environment',
      options: ['Stage', 'Production'],
    })

    expect(session.parts[0].tool.questions[0].options).toEqual([
      { label: 'Stage', description: 'Stage' },
      { label: 'Production', description: 'Production' },
    ])
    expect(session.parts[0].type).toBe('question')
    expect(session.parts[0].tool.requestId).toBe('request-2')
    await expect(
      adapter.respondToQuestion(session.id, { Environment: 'Stage' }, session.config, 'request-2'),
    ).resolves.toBe(true)
    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'extension_ui_response', id: 'request-2', value: 'Stage' })}\n`,
      expect.any(Function),
    )

    vi.mocked(process.stdin.write).mockClear()
    const staleResponse = await adapter.respondToQuestion(
      session.id,
      { Environment: 'Production' },
      session.config,
      'request-2',
    )
    expect(process.stdin.write).not.toHaveBeenCalled()
    expect(staleResponse).toMatchObject({
      handled: false,
      resolutionPart: {
        id: 'pi-question-request-2',
        update: true,
        tool: {
          name: 'question',
          status: 'cancelled',
        },
      },
    })
  })

  it('does not answer a newer confirmation with a stale request ID', async () => {
    const adapter = new PiAdapter()
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'current-request',
      method: 'confirm',
      title: 'Allow bash?',
      message: 'Run a command',
    })

    await expect(
      adapter.respondToApproval(session.id, true, 'approved', 'stale-request'),
    ).resolves.toBe(false)
    expect(process.stdin.write).not.toHaveBeenCalled()
    expect(adapter.getPendingApproval(session.id)?.requestId).toBe('current-request')
  })

  it('keeps UTF-8 JSONL frames intact across buffer boundaries', async () => {
    const adapter = new PiAdapter()
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)
    ;(adapter as any).attachProcess(session)

    const line = Buffer.from(`${JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ราคา €\u2028ok' },
    })}\n`)
    const euroByte = line.indexOf(Buffer.from('€'))
    process.stdout.emit('data', line.subarray(0, euroByte + 1))
    process.stdout.emit('data', line.subarray(euroByte + 1))

    await expect(adapter.pollMessages(session.id)).resolves.toEqual([
      expect.objectContaining({ text: 'ราคา €\u2028ok' }),
    ])
  })

  it('uses distinct stream IDs for separate assistant messages in one run', async () => {
    const adapter = new PiAdapter()
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, { type: 'message_start', message: { role: 'assistant' } })
    ;(adapter as any).handleEvent(session, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'First' },
    })
    ;(adapter as any).handleEvent(session, { type: 'message_start', message: { role: 'assistant' } })
    ;(adapter as any).handleEvent(session, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Second' },
    })

    const parts = await adapter.pollMessages(session.id)
    expect(parts.map((part) => part.id)).toEqual(['pi-text-1:1:0', 'pi-text-1:2:0'])
    expect(parts.map((part) => part.text)).toEqual(['First', 'Second'])
  })

  it('uses the completed assistant message as the authoritative text', async () => {
    const adapter = new PiAdapter()
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, { type: 'message_start', message: { role: 'assistant' } })
    ;(adapter as any).handleEvent(session, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Partial' },
    })
    ;(adapter as any).handleEvent(session, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Final text' }], stopReason: 'stop' },
    })

    expect((await adapter.pollMessages(session.id)).at(-1)).toMatchObject({
      id: 'pi-text-1:1:0',
      text: 'Final text',
      update: true,
    })
  })

  it('does not surface a transient model error when Pi retry succeeds', async () => {
    const adapter = new PiAdapter()
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Temporary overload' },
    })
    ;(adapter as any).handleEvent(session, { type: 'auto_retry_start' })
    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({ type: 'busy' })

    ;(adapter as any).handleEvent(session, { type: 'auto_retry_end', success: true })
    ;(adapter as any).handleEvent(session, { type: 'agent_settled' })
    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({ type: 'idle' })
    expect((await adapter.pollMessages(session.id)).some((part) => part.type === 'error')).toBe(false)
  })

  it('settles a terminal model error when Pi omits agent_settled', async () => {
    const adapter = new PiAdapter()
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)
    vi.spyOn(adapter as any, 'command').mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { isStreaming: false },
    })

    const monotonicSpy = vi.spyOn(performance, 'now').mockReturnValue(100)
    ;(adapter as any).handleEvent(session, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    })
    monotonicSpy.mockReturnValue(1_101)

    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({
      type: 'error',
      message: 'Provider unavailable',
    })
    expect((await adapter.pollMessages(session.id)).at(-1)).toMatchObject({
      id: 'pi-error-1',
      type: 'error',
      text: 'Provider unavailable',
    })
    monotonicSpy.mockRestore()
  })

  it('closes timed-out dialogs when the Pi run settles', async () => {
    const adapter = new PiAdapter()
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'timed-request',
      method: 'input',
      title: 'Name',
      placeholder: 'Type a name',
      timeout: 10,
    })
    ;(adapter as any).handleEvent(session, { type: 'agent_settled' })

    expect(session.pendingUiRequests.size).toBe(0)
    expect((await adapter.pollMessages(session.id)).at(-1)).toMatchObject({
      id: 'pi-question-timed-request',
      type: 'question',
      tool: { name: 'question', status: 'cancelled', requestId: 'timed-request' },
    })
    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({ type: 'idle' })
  })

  it('includes editor prefill in the structured question', async () => {
    const adapter = new PiAdapter()
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'editor-request',
      method: 'editor',
      title: 'Edit release notes',
      prefill: 'Existing notes',
    })

    expect(session.parts[0].tool.questions[0].question).toContain('Current value:\nExisting notes')
  })

  it('clears queued messages and pending dialogs before aborting', async () => {
    const adapter = new PiAdapter()
    const process = fakeProcess()
    const session = fakeSession(process)
    session.pendingUiRequests.set('request-1', {
      id: 'request-1',
      method: 'confirm',
      title: 'Allow bash?',
      message: 'Run a command',
      options: [],
    })
    ;(adapter as any).sessions.set(session.id, session)
    const command = vi.spyOn(adapter as any, 'command').mockResolvedValue({
      type: 'response',
      command: 'abort',
      success: true,
    })

    await adapter.abortPrompt(session.id)

    expect(command.mock.calls.map((call) => call[1])).toEqual([
      { type: 'clear_queue' },
      { type: 'abort' },
    ])
    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'extension_ui_response', id: 'request-1', cancelled: true })}\n`,
      expect.any(Function),
    )
    expect(session.pendingUiRequests.size).toBe(0)
    expect(session.status).toBe('idle')
  })

  it('keeps Pi session names within the provider 64-char limit', () => {
    expect(sanitizePiSessionName('task-1')).toBe('task-1')
    const long = `task_${'a'.repeat(100)}`
    const slug = sanitizePiSessionName(long)
    expect(slug.length).toBeLessThanOrEqual(64)
    expect(slug).not.toMatch(/-$/)
  })

  it('keeps long generated workflow tools behind a short MCP namespace proxy', () => {
    // Generated workflow tools can be 50 characters. A 24-character server
    // slug plus separator plus this tool is the reported 76-character failure.
    const workflowTool = 'wf_acme_travels_voice_agent_call_summary_acme_rep1'
    expect(workflowTool).toHaveLength(50)
    expect(`${'s'.repeat(24)}__${workflowTool}`).toHaveLength(76)

    const used = new Set<string>()
    // Bracket rule: "[Team] Workspace" → "team-workspace"
    expect(sanitizePiMcpServerName('[Team] Workspace', used)).toBe('team-workspace')
    // Second use dedupes instead of colliding
    expect(sanitizePiMcpServerName('[Team] Workspace', used)).not.toBe('team-workspace')
    expect(sanitizePiMcpServerName('[Team] My tasks', new Set())).toBe('team-my-tasks')

    const document = buildPiMcpConfigDocument({
      '[Team] Workspace': {
        type: 'http',
        url: 'https://example.com/mcp',
      },
    }) as {
      settings: { directTools: boolean }
      mcpServers: Record<string, unknown>
    }
    expect(document.settings.directTools).toBe(false)
    expect(Object.keys(document.mcpServers)).toEqual(['team-workspace'])
    // With direct tools disabled, this is the only server-specific tool name
    // registered with the provider; the 50-character suffix stays in MCP.
    expect('mcp__team-workspace').toHaveLength(19)
  })

  it('keeps AGENTS.md tool names and registered server keys in lockstep', () => {
    // workspace-docs documents `<slug>_<tool>` names computed by slugPiMcpServers
    // from the same server map the adapter passes to buildPiMcpConfigDocument.
    // If the two drifted, the model would be told names it cannot call.
    const servers = {
      '[Team] Dashboard': { type: 'http', url: 'https://example.com/a' },
      '[Team] Dashboard V2': { type: 'http', url: 'https://example.com/b' },
    } as any
    const renamed: Array<[string, string]> = []
    const doc = buildPiMcpConfigDocument(servers, (name, slug) => renamed.push([name, slug])) as {
      mcpServers: Record<string, unknown>
    }
    const slugs = slugPiMcpServers(Object.keys(servers))
    expect(new Set(Object.keys(doc.mcpServers))).toEqual(new Set(slugs.values()))
    for (const [name] of renamed) {
      expect(slugs.get(name)).toBeDefined()
    }
  })

  it('removes only the legacy hosted gateway provider from the Pi models file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-models-'))
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
    try {
      const modelsPath = join(dir, 'models.json')
      writeFileSync(modelsPath, JSON.stringify({
        providers: {
          peakflo: { baseUrl: 'https://gateway.example.com', apiKey: '$PEAKFLO_AI_GATEWAY_API_KEY' },
          mine: { baseUrl: 'https://llm.example.com', apiKey: '$MY_KEY' },
        },
      }))
      ;(new PiAdapter() as any).removeLegacyGatewayProvider()
      expect(JSON.parse(readFileSync(modelsPath, 'utf8'))).toEqual({
        providers: { mine: { baseUrl: 'https://llm.example.com', apiKey: '$MY_KEY' } },
      })

      const ownPeakflo = { providers: { peakflo: { baseUrl: 'https://mine.example.com', apiKey: '$OTHER' } } }
      writeFileSync(modelsPath, JSON.stringify(ownPeakflo))
      ;(new PiAdapter() as any).removeLegacyGatewayProvider()
      expect(JSON.parse(readFileSync(modelsPath, 'utf8'))).toEqual(ownPeakflo)
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prevents the parent environment from forcing direct MCP tools back on', () => {
    const previous = process.env.MCP_DIRECT_TOOLS
    process.env.MCP_DIRECT_TOOLS = '*'
    try {
      const adapter = new PiAdapter()
      const env = (adapter as any).processEnv({ permissionMode: 'ask' })
      expect(env.MCP_DIRECT_TOOLS).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.MCP_DIRECT_TOOLS
      else process.env.MCP_DIRECT_TOOLS = previous
    }
  })

  it('adds a retry hint to provider 64-char name errors', () => {
    const hinted = withProviderNameLimitHint('Error from provider (Console): name must be at most 64 characters, got 76')
    expect(hinted).toContain('Stop and start the agent')
    expect(withProviderNameLimitHint('Provider unavailable')).toBe('Provider unavailable')
  })
})
