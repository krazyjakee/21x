import { describe, it, expect, beforeEach, vi } from 'vitest'

const agentSessionApi = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
  stopByTaskId: vi.fn(async () => ({ success: true, sessionId: null })),
  send: vi.fn(async () => ({ newSessionId: null })),
  sendByTaskId: vi.fn(async () => ({ success: true, sessionId: null, newSessionId: 'session-1' })),
  respondToApproval: vi.fn(async () => undefined),
  approve: vi.fn(async () => ({ success: true })),
  getDeliveryState: vi.fn(async (_taskId: string, _deliveryId: string) => null as string | null),
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
const composer = vi.hoisted(() => ({ send: null as ((text: string) => void) | null, draftKey: null as string | null, stop: null as (() => void) | null }))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({
  AgentTranscriptPanel: ({ onSend, draftKey, onStop }: { onSend?: (text: string) => void; draftKey?: string; onStop?: () => void }) => {
    composer.send = onSend ?? null
    composer.draftKey = draftKey ?? null
    composer.stop = onStop ?? null
    return null
  },
}))

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { OrchestratorPanel } from './OrchestratorPanel'
import { SessionStatus, useAgentStore } from '@/stores/agent-store'
import { useCoordinatorStore } from '@/stores/coordinator-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { clearComposerDrafts, readComposerDraft } from '@/lib/composer-drafts'
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

/** The app opening on a project: the selection arrives with the first load, so it is not a move. */
function launchOn(projects: ProjectRecord[], currentProjectId: string): void {
  useProjectStore.setState({ isLoaded: false })
  useProjectStore.setState({ projects, currentProjectId, isLoaded: true, leftLaunchProject: false })
  projectApi.getAll.mockResolvedValue(projects)
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
  launchOn([], DEFAULT_PROJECT_ID)
  useUIStore.setState({ showOrchestrator: false })
  clearComposerDrafts()
  taskApi.getCoordinatorTaskId.mockImplementation(async (projectId?: string) =>
    projectId === 'proj-b' ? CAPTAIN_B : CAPTAIN)
  projectApi.getAll.mockResolvedValue([])
  settingsApi.get.mockResolvedValue(null)
  agentSessionApi.start.mockResolvedValue({ sessionId: 'session-1' })
  agentSessionApi.getDeliveryState.mockImplementation(async () => null)
  captainRuntimeApi.get.mockResolvedValue(null)
  captainRuntimeApi.switch.mockImplementation(async (projectId: string, agentId: string) => captainRuntimeApi.state(projectId, agentId))
  captainRuntimeApi.retry.mockImplementation(async (projectId: string) => captainRuntimeApi.state(projectId, 'other-agent'))
  captainRuntimeApi.rollback.mockImplementation(async (projectId: string) => captainRuntimeApi.state(projectId, 'default-agent', 'rolled_back'))
  composer.send = null
  composer.draftKey = null
  composer.stop = null
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
    launchOn([alpha, beta], 'proj-a')
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })

    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    expect(taskApi.getCoordinatorTaskId).toHaveBeenCalledWith('proj-a')
    // Alpha's Captain agent, not the app default.
    expect(agentSessionApi.start).toHaveBeenCalledWith('other-agent', CAPTAIN, undefined, true)
    expect(screen.getByTestId('captain-project')).toHaveValue('proj-a')
  })

  it("falls back to the project's default agent, then the app default", async () => {
    launchOn([alpha, beta], 'proj-b')
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    expect(agentSessionApi.start).toHaveBeenCalledWith('other-agent', CAPTAIN_B, undefined, true)
    expect(screen.getByRole('combobox', { name: 'Captain agent' })).toHaveValue('other-agent')
  })

  it('switches to the other project\'s conversation when the project changes', async () => {
    launchOn([alpha, beta], 'proj-a')
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))

    await act(async () => {
      useProjectStore.getState().setCurrentProject('proj-b')
    })

    // Beta's Captain is asked for and shown, not started; Alpha's session is left alone.
    await waitFor(() => expect(composer.draftKey).toBe(CAPTAIN_B))
    expect(taskApi.getCoordinatorTaskId).toHaveBeenCalledWith('proj-b')
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.stop).not.toHaveBeenCalled()
    expect(screen.getByTestId('captain-project')).toHaveValue('proj-b')

    // Its first message is what brings it up, in main, addressed to that Captain.
    await act(async () => {
      await (composer.send as (t: string) => Promise<unknown>)('status?')
    })
    expect(agentSessionApi.sendByTaskId).toHaveBeenCalledWith(CAPTAIN_B, 'status?', undefined, expect.stringMatching(/^captain-drawer:/))
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
  })
})

/**
 * Flipping is looking. It moves the app's current project and nothing else:
 * no Captain is started, woken, stopped or sent to, and nothing that belongs to
 * one Captain turns up on the next.
 */
describe('OrchestratorPanel — flipping between projects', () => {
  const alpha = projectRecord({ id: 'proj-a', name: 'Alpha', captain_agent_id: 'other-agent' })
  const beta = projectRecord({ id: 'proj-b', name: 'Beta', default_agent_id: 'other-agent' })
  const archived = projectRecord({ id: 'proj-old', name: 'Old', archived: true })

  const seedProjects = (...rows: ProjectRecord[]): void => launchOn(rows, rows[0].id)

  const projectControl = (): HTMLElement => screen.getByRole('combobox', { name: 'Captain project' })

  async function flipTo(projectId: string, captain: string): Promise<void> {
    fireEvent.change(projectControl(), { target: { value: projectId } })
    await waitFor(() => expect(composer.draftKey).toBe(captain))
  }

  async function warmAlpha(): Promise<void> {
    seedProjects(alpha, beta)
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await waitFor(() => expect(useAgentStore.getState().sessions.get(CAPTAIN)?.sessionId).toBe('session-1'))
  }

  it('offers every active project by name, under a label', async () => {
    seedProjects(alpha, beta, archived)
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })

    expect(projectControl()).toHaveValue('proj-a')
    expect(within(projectControl()).getAllByRole('option').map((option) => option.textContent)).toEqual(['Alpha', 'Beta'])
  })

  it('is a tab stop only while the drawer is open', async () => {
    seedProjects(alpha, beta)
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    expect(projectControl()).toHaveAttribute('tabindex', '-1')

    await act(async () => { useUIStore.setState({ showOrchestrator: true }) })
    expect(projectControl()).not.toHaveAttribute('tabindex')
  })

  it('names the only project instead of offering a choice of one', async () => {
    seedProjects(alpha, archived)
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })

    expect(screen.queryByRole('combobox', { name: 'Captain project' })).toBeNull()
    expect(screen.getByTestId('captain-project')).toHaveTextContent('Alpha')
  })

  it('changes the app\'s current project and starts, stops and sends nothing', async () => {
    await warmAlpha()

    await flipTo('proj-b', CAPTAIN_B)
    // Past the warm-up's settle window, so a start would have shown by now.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })

    expect(useProjectStore.getState().currentProjectId).toBe('proj-b')
    expect(settingsApi.set).toHaveBeenCalledWith('current_project_id', 'proj-b')
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.resume).not.toHaveBeenCalled()
    expect(agentSessionApi.stop).not.toHaveBeenCalled()
    expect(agentSessionApi.send).not.toHaveBeenCalled()
    expect(agentSessionApi.sendByTaskId).not.toHaveBeenCalled()
  })

  it('leaves a busy Captain working and finds it there on the way back', async () => {
    await warmAlpha()
    await act(async () => {
      useAgentStore.setState((state) => {
        const sessions = new Map(state.sessions)
        sessions.set(CAPTAIN, { ...sessions.get(CAPTAIN)!, status: SessionStatus.WORKING })
        return { sessions }
      })
    })

    await flipTo('proj-b', CAPTAIN_B)
    await flipTo('proj-a', CAPTAIN)

    const session = useAgentStore.getState().sessions.get(CAPTAIN)
    expect(session?.sessionId).toBe('session-1')
    expect(session?.status).toBe(SessionStatus.WORKING)
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.stop).not.toHaveBeenCalled()
  })

  it('does not restart a Captain whose session ended while the user was away', async () => {
    await warmAlpha()
    await flipTo('proj-b', CAPTAIN_B)
    await act(async () => { useAgentStore.getState().endSession(CAPTAIN) })

    await flipTo('proj-a', CAPTAIN)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })

    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
  })

  it('gives the composer to one Captain at a time, with no send while the next is unknown', async () => {
    await warmAlpha()
    expect(composer.draftKey).toBe(CAPTAIN)

    let finishLoad!: (id: string) => void
    taskApi.getCoordinatorTaskId.mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve }))
    fireEvent.change(projectControl(), { target: { value: 'proj-b' } })

    await waitFor(() => expect(composer.draftKey).toBeNull())
    expect(composer.send).toBeNull()
    await act(async () => finishLoad(CAPTAIN_B))
    await waitFor(() => expect(composer.draftKey).toBe(CAPTAIN_B))
    expect(composer.send).toBeTypeOf('function')
  })

  async function sendNow(): Promise<void> {
    const button = await screen.findByRole('button', { name: 'Send now' })
    await act(async () => { button.click() })
  }

  /** Project A, with nothing warmed and these messages failed and held. */
  async function holdInAlpha(...texts: string[]): Promise<void> {
    seedProjects(alpha, beta)
    settingsApi.get.mockResolvedValue('false')
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await waitFor(() => expect(composer.draftKey).toBe(CAPTAIN))
    await holdHere(...texts)
  }

  /** Each send also retries what is already held, so every attempt fails once. */
  async function holdHere(...texts: string[]): Promise<void> {
    for (const [index, text] of texts.entries()) {
      for (let attempt = 0; attempt <= index; attempt++) agentSessionApi.sendByTaskId.mockRejectedValueOnce(new Error('Captain unavailable'))
      await act(async () => { await composer.send?.(text) })
    }
  }

  /** A new part reaches the transcript, which is one of the two things that re-reads delivery state. */
  async function transcriptGrows(taskId: string, content: string): Promise<void> {
    await act(async () => {
      useAgentStore.setState((state) => {
        const sessions = new Map(state.sessions)
        const row = sessions.get(taskId)!
        sessions.set(taskId, { ...row, messages: [...row.messages, { id: `delivery-${row.messages.length}`, role: 'user', content, timestamp: new Date() }] })
        return { sessions }
      })
    })
  }

  /** The delivery id of the nth attempt to send a message, as main would know it. */
  const deliveryIdOf = (attempt: number): string => (agentSessionApi.sendByTaskId.mock.calls as unknown as unknown[][])[attempt][3] as string

  function mainSays(state: string, onlyDeliveryId?: string): void {
    agentSessionApi.getDeliveryState.mockImplementation(async (_taskId, deliveryId) => !onlyDeliveryId || deliveryId === onlyDeliveryId ? state : 'pending')
  }

  it('keeps a held message with its Captain, and Send now pushes it', async () => {
    await holdInAlpha('hold this')
    expect(await screen.findByRole('alert')).toHaveTextContent('1 message is waiting')

    await flipTo('proj-b', CAPTAIN_B)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.queryByRole('status')).toBeNull()

    await flipTo('proj-a', CAPTAIN)
    expect(await screen.findByRole('status')).toHaveTextContent('1 message is waiting')
    expect(agentSessionApi.sendByTaskId).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.start).not.toHaveBeenCalled()

    await act(async () => { screen.getByRole('button', { name: 'Send now' }).click() })
    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalledWith(
      'session-1', 'hold this', CAPTAIN, 'other-agent', undefined, expect.stringMatching(/^captain-drawer:/)
    ))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('says main retries a held message rather than that it waits for the button', async () => {
    await holdInAlpha('hold this')
    await flipTo('proj-b', CAPTAIN_B)
    await flipTo('proj-a', CAPTAIN)

    expect(await screen.findByRole('status')).toHaveTextContent('21x retries on its own')
  })

  it('keeps holding a message the transcript shows but main has not acknowledged', async () => {
    await holdInAlpha('hold this')
    await screen.findByRole('alert')
    mainSays('pending')
    agentSessionApi.getDeliveryState.mockClear()

    // A failed attempt on a running Captain writes the user part before the backend accepts anything.
    await transcriptGrows(CAPTAIN, 'hold this')

    await waitFor(() => expect(agentSessionApi.getDeliveryState).toHaveBeenCalled())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(screen.getByRole('alert')).toHaveTextContent('1 message is waiting')
  })

  it('stops listing a held message once main acknowledges it', async () => {
    await holdInAlpha('hold this')
    await screen.findByRole('alert')
    mainSays('acknowledged')

    await transcriptGrows(CAPTAIN, 'hold this')

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.queryByRole('status')).toBeNull()
    expect(agentSessionApi.sendByTaskId).toHaveBeenCalledTimes(1)
  })

  it('tells two held messages with the same words apart', async () => {
    await holdInAlpha('again', 'again')
    expect(await screen.findByRole('alert')).toHaveTextContent('2 messages are waiting')
    mainSays('acknowledged', deliveryIdOf(0))

    await transcriptGrows(CAPTAIN, 'again')

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('1 message is waiting'))
  })

  it('says so once main has stopped retrying', async () => {
    await holdInAlpha('hold this')
    await screen.findByRole('alert')
    mainSays('failed')

    await transcriptGrows(CAPTAIN, 'hold this')

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('21x has stopped retrying'))
    await flipTo('proj-b', CAPTAIN_B)
    await flipTo('proj-a', CAPTAIN)
    expect(await screen.findByRole('status')).toHaveTextContent('21x has stopped retrying')
    expect(screen.getByRole('button', { name: 'Send now' })).toBeInTheDocument()
  })

  it.each(['timed_out', 'cancelled'])('returns the words and attachments of a message main ended as %s', async (state) => {
    const attachments = [{ id: 'file-1', filename: 'notes.txt', size: 4, mime_type: 'text/plain' }]
    await holdInAlpha()
    agentSessionApi.sendByTaskId.mockRejectedValueOnce(new Error('Captain unavailable'))
    await act(async () => { await (composer.send as (text: string, options?: unknown) => Promise<unknown>)('hold this', { attachments }) })
    await screen.findByRole('alert')
    mainSays(state)

    await transcriptGrows(CAPTAIN, 'hold this')

    await waitFor(() => expect(readComposerDraft(CAPTAIN)).toMatchObject({ text: 'hold this', attachments }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('still sends the messages behind one that fails', async () => {
    await holdInAlpha('stuck', 'behind it')
    await flipTo('proj-b', CAPTAIN_B)
    await flipTo('proj-a', CAPTAIN)
    agentSessionApi.send.mockRejectedValueOnce(new Error('Delivery ended'))

    await sendNow()

    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalledWith('session-1', 'behind it', CAPTAIN, 'other-agent', undefined, expect.stringMatching(/^captain-drawer:/)))
    expect(await screen.findByRole('alert')).toHaveTextContent('1 message is waiting')
  })

  it('does not let one Captain\'s slow drain stop Send now on another', async () => {
    await holdInAlpha('slow')
    await flipTo('proj-b', CAPTAIN_B)
    await holdHere('quick')
    await flipTo('proj-a', CAPTAIN)
    agentSessionApi.send.mockImplementationOnce(() => new Promise(() => {}))
    await sendNow()
    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalledTimes(1))

    await flipTo('proj-b', CAPTAIN_B)
    await sendNow()

    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalledWith('session-1', 'quick', CAPTAIN_B, 'other-agent', undefined, expect.stringMatching(/^captain-drawer:/)))
  })

  it('does not let a new message overtake the older one still going out', async () => {
    await holdInAlpha('older')
    await flipTo('proj-b', CAPTAIN_B)
    await flipTo('proj-a', CAPTAIN)
    let finish!: () => void
    agentSessionApi.send.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ newSessionId: null }) }))
    await sendNow()
    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalledTimes(1))

    await act(async () => { void composer.send?.('newer') })
    expect(agentSessionApi.send).toHaveBeenCalledTimes(1)

    await act(async () => finish())
    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalledTimes(2))
    expect(agentSessionApi.send.mock.calls.map((call) => (call as unknown[])[1])).toEqual(['older', 'newer'])
  })

  it('delivers held messages after a healthy Retry outside the launch project', async () => {
    await warmAlpha()
    captainRuntimeApi.get.mockResolvedValue({ ...captainRuntimeApi.state('proj-b', 'other-agent', 'failed'), candidateAgentId: 'default-agent', errorDetail: 'Will not start' })
    await flipTo('proj-b', CAPTAIN_B)
    await screen.findByRole('alert')
    await holdHere('held')

    await act(async () => { screen.getByRole('button', { name: 'Retry' }).click() })

    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalledWith('session-1', 'held', CAPTAIN_B, expect.any(String), undefined, expect.stringMatching(/^captain-drawer:/)))
  })

  it('delivers held messages after a healthy agent switch outside the launch project', async () => {
    await warmAlpha()
    await flipTo('proj-b', CAPTAIN_B)
    await holdHere('held')

    fireEvent.change(screen.getByRole('combobox', { name: 'Captain agent' }), { target: { value: 'default-agent' } })

    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalledWith('session-1', 'held', CAPTAIN_B, expect.any(String), undefined, expect.stringMatching(/^captain-drawer:/)))
  })

  it('returns held words and attachments once Stop has cancelled them in main', async () => {
    const attachments = [{ id: 'file-1', filename: 'notes.txt', size: 4, mime_type: 'text/plain' }]
    await holdInAlpha()
    agentSessionApi.sendByTaskId.mockRejectedValueOnce(new Error('Captain unavailable'))
    await act(async () => { await (composer.send as (text: string, options?: unknown) => Promise<unknown>)('take this back', { attachments }) })
    await screen.findByRole('alert')
    mainSays('cancelled')

    await act(async () => { composer.stop?.() })

    await waitFor(() => expect(readComposerDraft(CAPTAIN)).toMatchObject({ text: 'take this back', attachments }))
    expect(agentSessionApi.stopByTaskId).toHaveBeenCalledWith(CAPTAIN)
  })

  it('gives nothing back when Stop cancelled nothing, or a resend would deliver it twice', async () => {
    await holdInAlpha('still pending')
    await screen.findByRole('alert')
    mainSays('pending')
    agentSessionApi.getDeliveryState.mockClear()

    await act(async () => { composer.stop?.() })

    await waitFor(() => expect(agentSessionApi.getDeliveryState).toHaveBeenCalled())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(readComposerDraft(CAPTAIN)).toBeUndefined()
    expect(screen.getByRole('alert')).toHaveTextContent('1 message is waiting')
  })

  function captainAsksAQuestion(): void {
    useAgentStore.setState((state) => {
      const sessions = new Map(state.sessions)
      sessions.set(CAPTAIN, {
        sessionId: 'session-1', agentId: 'other-agent', taskId: CAPTAIN, status: SessionStatus.WAITING_APPROVAL,
        messages: [{ id: 'question-1', role: 'assistant', content: 'Which one?', timestamp: new Date(), partType: 'question', tool: { name: 'question', status: 'running', questions: [{ header: 'Pick', question: 'Which one?', options: [] }] } }],
      } as never)
      return { sessions }
    })
  }

  it('sends a held message as itself while a question is open, because main still has its row', async () => {
    await holdInAlpha('hold this')
    await screen.findByRole('alert')
    await act(async () => { captainAsksAQuestion() })

    await act(async () => { screen.getByRole('button', { name: 'Retry' }).click() })

    await waitFor(() => expect(agentSessionApi.send).toHaveBeenCalledWith('session-1', 'hold this', CAPTAIN, 'other-agent', undefined, expect.stringMatching(/^captain-drawer:/)))
    expect(agentSessionApi.approve).not.toHaveBeenCalled()
  })

  it('answers an open question, and retries a failed answer as an answer', async () => {
    seedProjects(alpha, beta)
    settingsApi.get.mockResolvedValue('false')
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await waitFor(() => expect(composer.draftKey).toBe(CAPTAIN))
    await act(async () => { captainAsksAQuestion() })
    agentSessionApi.approve.mockRejectedValueOnce(new Error('Captain unavailable'))

    await act(async () => { await composer.send?.('the first') })
    await screen.findByRole('alert')
    await act(async () => { screen.getByRole('button', { name: 'Retry' }).click() })

    await waitFor(() => expect(agentSessionApi.approve).toHaveBeenCalledTimes(2))
    expect(agentSessionApi.send).not.toHaveBeenCalled()
    expect(agentSessionApi.sendByTaskId).not.toHaveBeenCalled()
  })

  it('waits for the saved project before warming, so launch starts one Captain', async () => {
    useProjectStore.setState({ isLoaded: false })
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(agentSessionApi.start).not.toHaveBeenCalled()

    await act(async () => { useProjectStore.setState({ projects: [alpha, beta], currentProjectId: 'proj-b', isLoaded: true }) })

    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    expect(agentSessionApi.start).toHaveBeenCalledWith('other-agent', CAPTAIN_B, undefined, true)
  })

  it('does not warm after a move made before the panel mounted', async () => {
    seedProjects(alpha, beta)
    useProjectStore.getState().setCurrentProject('proj-b')

    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await waitFor(() => expect(composer.draftKey).toBe(CAPTAIN_B))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(agentSessionApi.start).not.toHaveBeenCalled()
  })

  describe('choosing by keyboard', () => {
    async function stepToBeta(): Promise<void> {
      seedProjects(alpha, beta)
      await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
      fireEvent.keyDown(projectControl(), { key: 'ArrowDown' })
      fireEvent.change(projectControl(), { target: { value: 'proj-b' } })
    }

    it('does not visit a project an arrow key only passes over', async () => {
      await stepToBeta()

      expect(projectControl()).toHaveValue('proj-b')
      expect(useProjectStore.getState().currentProjectId).toBe('proj-a')
    })

    it('applies the step on Enter', async () => {
      await stepToBeta()
      fireEvent.keyDown(projectControl(), { key: 'Enter' })

      expect(useProjectStore.getState().currentProjectId).toBe('proj-b')
    })

    it('applies the step on leaving the control', async () => {
      await stepToBeta()
      fireEvent.blur(projectControl())

      expect(useProjectStore.getState().currentProjectId).toBe('proj-b')
    })

    it('puts the step back on Escape', async () => {
      await stepToBeta()
      fireEvent.keyDown(projectControl(), { key: 'Escape' })

      expect(projectControl()).toHaveValue('proj-a')
      expect(useProjectStore.getState().currentProjectId).toBe('proj-a')
    })

    it('applies a choice from the open list at once', async () => {
      seedProjects(alpha, beta)
      await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
      fireEvent.keyDown(projectControl(), { key: ' ' })
      fireEvent.change(projectControl(), { target: { value: 'proj-b' } })

      expect(useProjectStore.getState().currentProjectId).toBe('proj-b')
    })

    it('still steps on the next arrow key after a list is dismissed', async () => {
      seedProjects(alpha, beta)
      await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
      fireEvent.keyDown(projectControl(), { key: ' ' })
      fireEvent.keyDown(projectControl(), { key: 'ArrowDown' })
      fireEvent.change(projectControl(), { target: { value: 'proj-b' } })

      expect(projectControl()).toHaveValue('proj-b')
      expect(useProjectStore.getState().currentProjectId).toBe('proj-a')
    })

    it('forgets a step when the current project is chosen from the list', async () => {
      await stepToBeta()
      fireEvent.keyDown(projectControl(), { key: ' ' })
      fireEvent.change(projectControl(), { target: { value: 'proj-a' } })
      fireEvent.blur(projectControl())

      expect(projectControl()).toHaveValue('proj-a')
      expect(useProjectStore.getState().currentProjectId).toBe('proj-a')
    })
  })

  it('does not show one Captain\'s failed start on the next', async () => {
    let fail!: (reason: Error) => void
    agentSessionApi.start.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    seedProjects(alpha, beta)
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))

    // Both run on the same agent: the failure has only its Captain to tell it apart.
    await flipTo('proj-b', CAPTAIN_B)
    await act(async () => { fail(new Error('No server')); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not apply a late agent switch to the Captain flipped to', async () => {
    seedProjects(alpha, beta)
    await act(async () => { render(<OrchestratorPanel onClose={vi.fn()} />) })
    const agentControl = screen.getByRole('combobox', { name: 'Captain agent' })
    await waitFor(() => expect(agentControl).toHaveValue('other-agent'))

    let finish!: (value: ReturnType<typeof captainRuntimeApi.state>) => void
    captainRuntimeApi.switch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.change(agentControl, { target: { value: 'default-agent' } })
    expect(await screen.findByTestId('captain-runtime-state')).toBeInTheDocument()

    await flipTo('proj-b', CAPTAIN_B)
    await waitFor(() => expect(screen.queryByTestId('captain-runtime-state')).toBeNull())

    await act(async () => { finish(captainRuntimeApi.state('proj-a', 'default-agent', 'failed')); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Captain agent' })).toHaveValue('other-agent')
    expect(useProjectStore.getState().currentProjectId).toBe('proj-b')
  })
})

/**
 * A Captain that will not start. The drawer must not sit on "Agent is
 * starting..." forever: it says why, offers Retry and the way back to the
 * previous agent, and delivers what the user said in the meantime once.
 */
describe('OrchestratorPanel — a Captain that will not start', () => {
  it('leaves a completed retry with its original owner after the panel is unmounted', async () => {
    seedDefaultProject()
    captainRuntimeApi.get.mockResolvedValue({ ...captainRuntimeApi.state(DEFAULT_PROJECT_ID, 'default-agent', 'failed'), candidateAgentId: 'other-agent', errorDetail: 'Retry this Captain.' })
    let finish!: (value: ReturnType<typeof captainRuntimeApi.state>) => void
    captainRuntimeApi.retry.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<OrchestratorPanel onClose={vi.fn()} />)
    await screen.findByRole('alert')
    await act(async () => { screen.getByRole('button', { name: 'Retry' }).click() })
    await waitFor(() => expect(captainRuntimeApi.retry).toHaveBeenCalled())
    view.unmount(); projectApi.getAll.mockClear()
    await act(async () => { finish(captainRuntimeApi.state(DEFAULT_PROJECT_ID, 'other-agent')); await Promise.resolve() })
    expect(projectApi.getAll).not.toHaveBeenCalled()
  })
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
