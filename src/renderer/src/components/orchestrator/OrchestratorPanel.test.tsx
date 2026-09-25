import { describe, it, expect, beforeEach, vi } from 'vitest'

const agentSessionApi = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
  send: vi.fn(async () => ({ newSessionId: null })),
  sendByTaskId: vi.fn(async () => ({ success: true, sessionId: null, newSessionId: 'session-1' })),
  respondToApproval: vi.fn(async () => undefined),
  resume: vi.fn(),
  getTranscriptSnapshot: vi.fn(async () => ({ parts: [], rev: 0 })),
}))
const settingsApi = vi.hoisted(() => ({
  get: vi.fn(async () => null as string | null),
  set: vi.fn(async () => undefined),
}))
const agentApi = vi.hoisted(() => ({
  getAll: vi.fn(async () => [
    { id: 'default-agent', name: 'Claude', is_default: true },
    { id: 'other-agent', name: 'Codex', is_default: false },
  ]),
}))
/** Each project's Captain is a hidden task row; the panel asks main for the current project's id. */
const CAPTAIN = 'captain-row-1'
const CAPTAIN_B = 'captain-row-b'
const taskApi = vi.hoisted(() => ({
  getCoordinatorTaskId: vi.fn(async (projectId?: string) =>
    (projectId === 'proj-b' ? 'captain-row-b' : 'captain-row-1') as string | null),
}))
const projectApi = vi.hoisted(() => ({
  getAll: vi.fn(async (): Promise<unknown[]> => []),
  update: vi.fn(async (id: string, data: Record<string, unknown>) => ({ id, ...data })),
}))
const captainRuntimeApi = vi.hoisted(() => {
  const state = (projectId: string, agentId: string, phase = 'healthy') => ({
    ownerId: projectId === 'proj-b' ? 'captain-row-b' : 'captain-row-1',
    projectId,
    generation: 1,
    agentId,
    candidateAgentId: null,
    lastGoodAgentId: agentId,
    sessionId: 'session-1',
    phase,
    deadlineAt: null,
    lastProbeAt: Date.now(),
    probeOk: true,
    attemptCount: 1,
    errorCode: null,
    errorDetail: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return {
    state,
    get: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    switch: vi.fn(async (projectId: string, agentId: string) => state(projectId, agentId)),
    retry: vi.fn(async (projectId: string) => state(projectId, 'other-agent')),
    rollback: vi.fn(async (projectId: string) => state(projectId, 'default-agent', 'rolled_back')),
  }
})

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  agentApi,
  settingsApi,
  agentSessionApi,
  taskApi,
  projectApi,
  captainRuntimeApi,
}))

/**
 * The transcript is a large tree with its own IPC; this file is about the
 * session. Its send handler is captured so a test can send like a user.
 */
const composer = vi.hoisted(() => ({ send: null as ((text: string) => void) | null }))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({
  AgentTranscriptPanel: ({ onSend }: { onSend?: (text: string) => void }) => {
    composer.send = onSend ?? null
    return null
  },
}))

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { OrchestratorPanel } from './OrchestratorPanel'
import { useAgentStore } from '@/stores/agent-store'
import { useCoordinatorStore } from '@/stores/coordinator-store'
import { useProjectStore } from '@/stores/project-store'
import { DEFAULT_PROJECT_ID, type ProjectRecord } from '@shared/projects'

function projectRecord(overrides: Partial<ProjectRecord> & { id: string; name: string }): ProjectRecord {
  return {
    description: '',
    default_agent_id: null,
    captain_agent_id: null,
    git_provider: null,
    git_org: null,
    settings: {},
    sort_order: 0,
    archived: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Captain starts before there is anything to say.
 *
 * The rule this file protects: warming creates a window in which a message can
 * arrive while the session is still coming up. A message sent in that window
 * must wait for the session, not be dropped.
 */


/** The Default project as a real row, which the app always has; the agent choice is saved on it. */
function seedDefaultProject(): void {
  const row = projectRecord({ id: DEFAULT_PROJECT_ID, name: 'Default' })
  useProjectStore.setState({ projects: [row], currentProjectId: DEFAULT_PROJECT_ID })
  projectApi.update.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ ...row, id, ...data }))
}

/** Resolves `start` by hand, so the warm-up can be held mid-flight. */
function deferredStart(): { resolve: () => void } {
  let release!: () => void
  agentSessionApi.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ sessionId: 'session-1' })
      })
  )
  return { resolve: () => release() }
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAgentStore.setState({ sessions: new Map() })
  useCoordinatorStore.setState({ captainTaskIds: {} })
  useProjectStore.setState({ projects: [], currentProjectId: DEFAULT_PROJECT_ID })
  taskApi.getCoordinatorTaskId.mockImplementation(async (projectId?: string) =>
    projectId === 'proj-b' ? CAPTAIN_B : CAPTAIN)
  projectApi.getAll.mockResolvedValue([])
  settingsApi.get.mockResolvedValue(null)
  agentSessionApi.start.mockResolvedValue({ sessionId: 'session-1' })
  captainRuntimeApi.get.mockResolvedValue(null)
  captainRuntimeApi.switch.mockImplementation(async (projectId: string, agentId: string) => captainRuntimeApi.state(projectId, agentId))
  captainRuntimeApi.retry.mockImplementation(async (projectId: string) => captainRuntimeApi.state(projectId, 'other-agent'))
  captainRuntimeApi.rollback.mockImplementation(async (projectId: string) => captainRuntimeApi.state(projectId, 'default-agent', 'rolled_back'))
  composer.send = null
})

describe('OrchestratorPanel — warming the session', () => {
  it('sends a message while warm-up is still in flight', async () => {
    const pending = deferredStart()
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())
    await act(async () => { void composer.send?.('Merge PR #12') })
    await waitFor(() => expect(agentSessionApi.sendByTaskId).toHaveBeenCalled())
    await act(async () => { pending.resolve() })
  })

  it('sends a dashboard prefill', async () => {
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())
    act(() => { window.dispatchEvent(new CustomEvent('captain-prefill', { detail: { message: 'Merge PR #12' } })) })
    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalled())
  })

  it('starts the default agent at launch, before any message', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })

    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    // skipInitialPrompt: the agent must stay quiet until the user speaks.
    expect(agentSessionApi.start).toHaveBeenCalledWith('default-agent', CAPTAIN, undefined, true)
    expect(agentSessionApi.send).not.toHaveBeenCalled()
  })

  it('does not start anything when the preference is off', async () => {
    settingsApi.get.mockResolvedValue('false')
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(agentSessionApi.start).not.toHaveBeenCalled()
  })

  it('leaves the agent choice open while the session is only warm', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())

    // Warm is not a conversation: locking here would make the agent
    // unchangeable from the moment the app opens.
    expect(screen.getByRole('combobox')).not.toBeDisabled()
  })

  it('lets the user swap agents once a conversation is in flight', async () => {
    seedDefaultProject()
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    // Wait for the session to actually be live before we switch agents.
    await waitFor(() => {
      expect(useAgentStore.getState().sessions.get(CAPTAIN)?.sessionId).toBe('session-1')
    })
    // ensureSession holds its start promise for a ~100 ms settle window; let
    // it clear so the switch is not de-duped against the initial warm-up.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })

    // A conversation exists. The old code locked the picker here; it stays
    // usable, and picking a different agent re-warms the session on that agent.
    await act(async () => {
      useAgentStore.setState((state) => {
        const sessions = new Map(state.sessions)
        const current = sessions.get(CAPTAIN) as Record<string, unknown> | undefined
        sessions.set(CAPTAIN, {
          ...current,
          messages: [{ id: 'm1', role: 'user', content: 'hello' }],
        } as never)
        return { sessions }
      })
    })

    const combobox = screen.getByRole('combobox') as HTMLSelectElement
    expect(combobox).not.toBeDisabled()

    let finishSwitch!: () => void
    captainRuntimeApi.switch.mockImplementationOnce((projectId: string, agentId: string) => new Promise((resolve) => {
      finishSwitch = () => resolve(captainRuntimeApi.state(projectId, agentId))
    }))
    await act(async () => {
      combobox.value = 'other-agent'
      combobox.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Main owns the transaction and only returns healthy after persisting the
    // candidate selection; the renderer never tears down the good session.
    await waitFor(() => expect(captainRuntimeApi.switch).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, 'other-agent'))
    expect(screen.getByTestId('captain-runtime-state')).toHaveTextContent('Captain is starting server on Codex')
    expect(combobox.value).toBe('default-agent')
    expect(agentSessionApi.start.mock.calls.every((call) => call[0] !== 'other-agent')).toBe(true)
    expect(agentSessionApi.stop).not.toHaveBeenCalled()
    expect(projectApi.update).not.toHaveBeenCalled()
    await act(async () => finishSwitch())
  })

  it('starts the session only once, however many times it re-renders', async () => {
    const view = render(<OrchestratorPanel onClose={vi.fn()} />)
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    await act(async () => {
      view.rerender(<OrchestratorPanel onClose={vi.fn()} />)
    })
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
  })

  /**
   * The reason warming needs care. Between the click and the session there is
   * a window in which there is no session yet and one is already being made.
   * The old code sent nothing in that window and said nothing about it.
   */
  it('holds a message sent while the session is still coming up', async () => {
    const started = deferredStart()
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    expect(composer.send).toBeTypeOf('function')

    // The user speaks before the agent has finished coming up.
    let sent: Promise<unknown> | undefined
    await act(async () => {
      sent = (composer.send as (t: string) => Promise<unknown>)('what is blocking the release')
    })
    expect(agentSessionApi.send).not.toHaveBeenCalled()

    await act(async () => {
      started.resolve()
      await sent
    })

    // One session, and the sentence survived the wait.
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.sendByTaskId).toHaveBeenCalledWith(
      CAPTAIN,
      'what is blocking the release',
      undefined,
      expect.stringMatching(/^captain-drawer:/)
    )
  })

  it('retains image attachments and the delivery ID when a failed send is queued and retried', async () => {
    settingsApi.get.mockResolvedValue('false')
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await waitFor(() => expect(composer.send).toBeTypeOf('function'))
    const attachments = [{ id: 'image-1', filename: 'failure.png', size: 64, mime_type: 'image/png' }]
    agentSessionApi.sendByTaskId.mockRejectedValueOnce(new Error('Captain unavailable'))
    await act(async () => {
      await (composer.send as (text: string, options?: unknown) => Promise<unknown>)('Inspect this', { attachments })
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('1 message is waiting')
    const firstCall = vi.mocked(agentSessionApi.sendByTaskId).mock.calls[0] as unknown[]
    expect(firstCall).toEqual([CAPTAIN, 'Inspect this', attachments, expect.stringMatching(/^captain-drawer:/)])

    // A subsequent send drains the held message first, with the same ID.
    await act(async () => { await composer.send?.('Next message') })
    expect(agentSessionApi.sendByTaskId).toHaveBeenNthCalledWith(2, ...firstCall)
    expect(agentSessionApi.send).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.send).toHaveBeenCalledWith('session-1', 'Next message', CAPTAIN, '', undefined, expect.stringMatching(/^captain-drawer:/))
  })

  it('keeps an image-only message while warm-up is pending', async () => {
    const pending = deferredStart()
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())
    const attachments = [{ id: 'image-only', filename: 'shot.png', size: 64, mime_type: 'image/png' }]
    await act(async () => {
      await (composer.send as (text: string, options?: unknown) => Promise<unknown>)('', { attachments })
    })
    expect(agentSessionApi.sendByTaskId).toHaveBeenCalledWith(CAPTAIN, '', attachments, expect.stringMatching(/^captain-drawer:/))
    await act(async () => pending.resolve())
  })

  it('sends at once when the session is already warm', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))

    await act(async () => {
      await (composer.send as (t: string) => Promise<unknown>)('hello')
    })

    // No second start: the whole point of warming.
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.send).toHaveBeenCalledTimes(1)
  })
})

/**
 * One Captain per project (#55). The drawer shows the current project's
 * conversation, runs it on the project's agent, and follows a project switch.
 */
describe('OrchestratorPanel — the current project\'s Captain', () => {
  const alpha = projectRecord({ id: 'proj-a', name: 'Alpha', captain_agent_id: 'other-agent' })
  const beta = projectRecord({ id: 'proj-b', name: 'Beta', default_agent_id: 'other-agent' })

  it("names the project and warms its Captain on the project's agent", async () => {
    useProjectStore.setState({ projects: [alpha, beta], currentProjectId: 'proj-a' })
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })

    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    expect(taskApi.getCoordinatorTaskId).toHaveBeenCalledWith('proj-a')
    // Alpha's Captain agent, not the app default.
    expect(agentSessionApi.start).toHaveBeenCalledWith('other-agent', CAPTAIN, undefined, true)
    expect(screen.getByTestId('captain-project')).toHaveTextContent('Alpha')
  })

  it("falls back to the project's default agent, then the app default", async () => {
    useProjectStore.setState({ projects: [alpha, beta], currentProjectId: 'proj-b' })
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    expect(agentSessionApi.start).toHaveBeenCalledWith('other-agent', CAPTAIN_B, undefined, true)
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('other-agent')
  })

  it('switches to the other project\'s conversation when the project changes', async () => {
    useProjectStore.setState({ projects: [alpha, beta], currentProjectId: 'proj-a' })
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))

    await act(async () => {
      useProjectStore.getState().setCurrentProject('proj-b')
    })

    // Beta's Captain is asked for, warmed, and shown; Alpha's session is left alone.
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(2))
    expect(taskApi.getCoordinatorTaskId).toHaveBeenCalledWith('proj-b')
    expect(agentSessionApi.start).toHaveBeenLastCalledWith('other-agent', CAPTAIN_B, undefined, true)
    expect(agentSessionApi.stop).not.toHaveBeenCalled()
    expect(screen.getByTestId('captain-project')).toHaveTextContent('Beta')

    await act(async () => {
      await (composer.send as (t: string) => Promise<unknown>)('status?')
    })
    expect(agentSessionApi.send).toHaveBeenCalledWith('session-1', 'status?', CAPTAIN_B, 'other-agent', undefined, expect.stringMatching(/^captain-drawer:/))
  })
})

/**
 * A Captain that will not start. The drawer must not sit on "Agent is
 * starting..." forever: it says why, offers Retry and the way back to the
 * previous agent, and delivers what the user said in the meantime once.
 */
describe('OrchestratorPanel — a Captain that will not start', () => {
  const failure = new Error("Error invoking remote method 'agentSession:start': Error: Sol did not come up within 90 seconds")

  it('shows persisted unhealthy probe state instead of calling the process healthy', async () => {
    seedDefaultProject()
    captainRuntimeApi.get.mockResolvedValue({
      ...captainRuntimeApi.state(DEFAULT_PROJECT_ID, 'other-agent', 'unhealthy'),
      candidateAgentId: 'other-agent',
      lastGoodAgentId: 'default-agent',
      errorCode: 'HEALTH_PROBE_FAILED',
      errorDetail: 'protocol health check failed',
      probeOk: false,
    })
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })

    expect(await screen.findByTestId('captain-runtime-state')).toHaveTextContent('Captain is unhealthy on Codex')
    expect(screen.getByRole('alert')).toHaveTextContent('protocol health check failed')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('explains the failure and retries on request', async () => {
    agentSessionApi.start.mockRejectedValueOnce(failure)
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The Captain could not start on Claude.')
    expect(alert).toHaveTextContent('Sol did not come up within 90 seconds')
    expect(alert).not.toHaveTextContent('invoking remote method')
    // Not "starting" any more.
    expect(useAgentStore.getState().sessions.get(CAPTAIN)?.status).not.toBe('working')

    await act(async () => {
      screen.getByRole('button', { name: 'Retry' }).click()
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('restores a persisted failed switch and retries it manually', async () => {
    seedDefaultProject()
    captainRuntimeApi.get.mockResolvedValue({
      ...captainRuntimeApi.state(DEFAULT_PROJECT_ID, 'default-agent', 'rolled_back'),
      candidateAgentId: 'other-agent',
      lastGoodAgentId: 'default-agent',
      errorCode: 'STARTUP_TIMEOUT',
      errorDetail: 'Codex readiness probe timed out',
      probeOk: false,
    })
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Codex readiness probe timed out')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('default-agent')
    projectApi.getAll.mockResolvedValue([
      projectRecord({ id: DEFAULT_PROJECT_ID, name: 'Default', captain_agent_id: 'other-agent' })
    ])

    await act(async () => {
      screen.getByRole('button', { name: 'Retry' }).click()
    })
    await waitFor(() => expect(captainRuntimeApi.retry).toHaveBeenCalledWith(DEFAULT_PROJECT_ID))
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('other-agent'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('offers and completes an explicit rollback to the last-known-good Captain', async () => {
    seedDefaultProject()
    captainRuntimeApi.get.mockResolvedValue({
      ...captainRuntimeApi.state(DEFAULT_PROJECT_ID, 'default-agent', 'rolled_back'),
      candidateAgentId: 'other-agent',
      lastGoodAgentId: 'default-agent',
      errorCode: 'STARTUP_FAILED',
      errorDetail: 'Candidate process exited during startup',
      probeOk: false,
    })
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Candidate process exited during startup')

    await act(async () => {
      screen.getByRole('button', { name: 'Roll back to Claude' }).click()
    })
    await waitFor(() => expect(captainRuntimeApi.rollback).toHaveBeenCalledWith(DEFAULT_PROJECT_ID))
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('default-agent')
  })
})
