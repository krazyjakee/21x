import { DesktopClient } from '../renderer/src/lib/desktop-client'
import { createTauriDesktopTransport, getTauriEngineEpoch, type TauriDesktopApi } from '../renderer/src/lib/tauri-desktop-transport'
import { DATABASE_COMMAND_CODECS, DATABASE_EVENT_CODECS } from '../shared/database-desktop-codecs'
import { AGENT_COMMAND_CODECS, AGENT_EVENT_CODECS } from '../shared/agent-desktop-codecs'
import { CONFIGURATION_COMMAND_CODECS, CONFIGURATION_CONTENT_OPERATIONS, CONFIGURATION_EVENT_CODECS } from '../shared/configuration-desktop-codecs'
import { createProjection, applyPartsToProjection } from '../shared/transcript/projection'
import { hydrateTranscriptProjection } from '../renderer/src/lib/transcript-pagination'
import { isRecord, ServiceProtocolError } from '../shared/service-protocol'
import type { Task } from '../renderer/src/types'

const smokeKey = '21x.database-slice.reload.v1'
const databaseProofKeys = [
  'taskCreated', 'taskEventObserved', 'taskUpdated', 'updateEventObserved', 'projectCreated',
  'missingResultPreserved', 'settingPersisted', 'transcriptSnapshotRead', 'transcriptDeltaRead',
  'rendererReloaded', 'rehydrated', 'retiredOperationDenied', 'staleEpochDenied'
] as const
const agentProofKeys = ['agentStarted', 'approvalRequested', 'staleApprovalDenied', 'approvalAccepted', 'agentCompleted', 'agentStatusEventObserved', 'agentTranscriptRehydrated'] as const
type Proof = Partial<Record<typeof databaseProofKeys[number] | typeof agentProofKeys[number], boolean>>
type SmokeWindow = Window & { __TWENTYONEX_DATABASE_SMOKE__?: () => Promise<Proof | { reloadRequired: true }> }

/** A migration test surface; it is mounted only when the host identifies its synthetic service. */
export async function mountSyntheticTaskSlice(native: TauriDesktopApi, agentEnabled = false): Promise<void> {
  const proofKeys = agentEnabled ? [...databaseProofKeys, ...agentProofKeys] : [...databaseProofKeys]
  const section = document.querySelector<HTMLElement>('#database-slice')!
  const status = document.querySelector<HTMLElement>('#database-status')!
  const list = document.querySelector<HTMLElement>('#database-tasks')!
  const transcript = document.querySelector<HTMLElement>('#database-transcript')!
  const form = document.querySelector<HTMLFormElement>('#database-create')!
  const input = document.querySelector<HTMLInputElement>('#database-title')!
  const create = document.querySelector<HTMLButtonElement>('#database-create button')!
  section.hidden = false
  const tasks = new Map<string, Task>()
  let selected: string | undefined
  let selectionGeneration = 0
  let selectionRead: AbortController | undefined
  let requiredTranscriptRev = 0
  let revision = 0
  let hydrated = false
  let transcriptHydrated = false
  const projection = createProjection()
  const observers = new Map<string, Set<(id: string) => void>>()
  let refreshAgentControls = (): void => {}
  const client = new DesktopClient({
    transport: createTauriDesktopTransport(native), commands: { ...DATABASE_COMMAND_CODECS,
      ...Object.fromEntries(CONFIGURATION_CONTENT_OPERATIONS.map(operation => [operation, CONFIGURATION_COMMAND_CODECS[operation]])),
      ...(agentEnabled ? AGENT_COMMAND_CODECS : {}) },
    events: { ...DATABASE_EVENT_CODECS, ...CONFIGURATION_EVENT_CODECS, ...(agentEnabled ? AGENT_EVENT_CODECS : {}) },
    onState: state => {
      if (state.status !== 'ready') { hydrated = false; transcriptHydrated = false; selectionRead?.abort() }
      status.textContent = state.status === 'ready' ? 'Connected to isolated test data.' :
        state.status === 'connecting' ? 'Connecting…' : 'Connection unavailable. Reload the window to reconnect.'
      create.disabled = state.status !== 'ready' || !hydrated
      refreshAgentControls()
    }
  })

  function drawTasks(): void {
    list.replaceChildren()
    for (const task of tasks.values()) {
      const row = document.createElement('li')
      row.dataset.taskId = task.id
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = task.title
      button.addEventListener('click', () => { void selectTask(task.id).catch(failed) })
      row.append(button)
      list.append(row)
    }
  }
  function drawTranscript(): void {
    transcript.textContent = projection.sorted.map(part => part.content).join('\n') || 'No transcript parts for this task.'
    refreshAgentControls()
  }
  function notify(operation: string, id: string): void { for (const callback of observers.get(operation) ?? []) callback(id) }
  function failed(): void { status.textContent = 'The isolated data operation failed.' }
  async function selectTask(id: string, reset = false): Promise<void> {
    const generation = ++selectionGeneration
    selectionRead?.abort()
    const reading = new AbortController()
    selectionRead = reading
    transcriptHydrated = false
    refreshAgentControls()
    if (selected !== id || reset) {
      projection.parts.clear(); projection.sorted.length = 0; projection.rev = 0
    }
    if (selected !== id) requiredTranscriptRev = 0
    selected = id
    try {
      let recovered = false
      for (let attempt = 0; attempt < 3; attempt++) {
        const cursor = await hydrateTranscriptProjection((taskId, page, options) => client.invoke('agentSession:getTranscriptPage', [taskId, page], options), id, projection,
          { signal: reading.signal })
        if (cursor >= requiredTranscriptRev) { recovered = true; break }
      }
      if (!recovered) throw new ServiceProtocolError('BACKPRESSURE')
    } catch (error) {
      if (reading.signal.aborted) return
      throw error
    } finally { if (selectionRead === reading) selectionRead = undefined }
    if (generation !== selectionGeneration) return
    transcriptHydrated = true
    drawTranscript()
  }
  client.subscribe('task:created', ({ task }) => { tasks.set(task.id, task); revision++; drawTasks(); notify('task:created', task.id) })
  client.subscribe('task:updated', ({ taskId, updates }) => {
    const previous = tasks.get(taskId)
    if (previous) tasks.set(taskId, { ...previous, ...updates })
    revision++; drawTasks(); notify('task:updated', taskId)
  })
  client.subscribe('task:deleted', ({ taskId }) => { tasks.delete(taskId); revision++; drawTasks(); notify('task:deleted', taskId) })
  client.subscribe('transcript:changed', event => {
    if (event.taskId !== selected) return
    if (event.reloadRequired) {
      requiredTranscriptRev = Math.max(requiredTranscriptRev, event.maxRev)
      transcriptHydrated = false
      refreshAgentControls()
      // Coalesce invalidations while a read is active; repeated large updates
      // must not continually abort their own recovery or enable stale approval.
      if (!selectionRead) void selectTask(event.taskId, true).catch(failed)
      return
    }
    applyPartsToProjection(projection, event.parts, event.maxRev)
    drawTranscript()
  })

  let fixtureAgentId: string | undefined
  let fixtureTaskId: string | undefined
  let fixtureSessionId: string | undefined
  let conversationUsed = false
  let agentStatus = 'idle'
  let agentStatusObserved = false
  const agentControls = document.createElement('div')
  agentControls.hidden = !agentEnabled
  agentControls.innerHTML = '<p data-agent-state>Isolated deterministic agent.</p><button type="button" data-agent-start>Start fixture agent</button> <button type="button" data-agent-approve>Approve</button> <button type="button" data-agent-reject>Reject</button> <button type="button" data-agent-stop>Stop</button>'
  transcript.before(agentControls)
  const agentStart = agentControls.querySelector<HTMLButtonElement>('[data-agent-start]')!
  const agentApprove = agentControls.querySelector<HTMLButtonElement>('[data-agent-approve]')!
  const agentReject = agentControls.querySelector<HTMLButtonElement>('[data-agent-reject]')!
  const agentStop = agentControls.querySelector<HTMLButtonElement>('[data-agent-stop]')!
  function pendingApproval(): string | undefined {
    if (selected !== fixtureTaskId) return undefined
    const part = projection.sorted.find(part => isRecord(part.tool) && part.tool.name === 'permission' && part.tool.status === 'running' && typeof part.tool.requestId === 'string')
    return part && isRecord(part.tool) ? part.tool.requestId as string : undefined
  }
  refreshAgentControls = () => {
    const connected = hydrated && client.connection.status === 'ready'
    agentStart.disabled = !connected || !fixtureAgentId || conversationUsed
    agentApprove.disabled = agentReject.disabled = !connected || !transcriptHydrated || agentStatus !== 'waiting_approval' || !pendingApproval()
    agentStop.disabled = !connected || !fixtureSessionId
    agentControls.querySelector('[data-agent-state]')!.textContent = `Isolated deterministic agent: ${agentStatus}.`
  }
  if (agentEnabled) client.subscribe('agent:status', event => {
    if (event.taskId !== fixtureTaskId) return
    agentStatusObserved = true; agentStatus = event.status; fixtureSessionId = event.sessionId
    refreshAgentControls()
  })
  async function startFixtureAgent(): Promise<void> {
    if (!fixtureAgentId || !fixtureTaskId) throw new ServiceProtocolError('INVALID_REQUEST')
    await selectTask(fixtureTaskId)
    const outcome = await client.invoke('agentSession:start', [fixtureAgentId, fixtureTaskId])
    if (outcome.queued || !outcome.sessionId) throw new ServiceProtocolError('INVALID_RESULT')
    fixtureSessionId = outcome.sessionId
    conversationUsed = true
    refreshAgentControls()
  }
  async function answerFixture(approved: boolean): Promise<void> {
    const requestId = pendingApproval()
    if (!requestId || !fixtureSessionId) throw new ServiceProtocolError('INVALID_REQUEST')
    await client.invoke('agentSession:approve', [fixtureSessionId, approved, undefined, 'permission', requestId])
  }
  agentStart.addEventListener('click', () => { void startFixtureAgent().catch(failed) })
  agentApprove.addEventListener('click', () => { void answerFixture(true).catch(failed) })
  agentReject.addEventListener('click', () => { void answerFixture(false).catch(failed) })
  agentStop.addEventListener('click', () => { if (fixtureSessionId) void client.invoke('agentSession:stop', [fixtureSessionId]).then(() => { fixtureSessionId = undefined; agentStatus = 'stopped'; refreshAgentControls() }).catch(failed) })

  const ready = (async () => {
    await client.connect(await getTauriEngineEpoch(native))
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = revision
      const snapshot = await client.invoke('db:getTasks', [])
      if (before !== revision) continue
      tasks.clear()
      for (const task of snapshot) tasks.set(task.id, task)
      drawTasks()
      if (agentEnabled) {
        const agents = await client.invoke('agent:getAll', [])
        const fixture = snapshot.find(task => task.title === 'Synthetic approval task')
        if (agents.length !== 1 || !fixture) throw new ServiceProtocolError('INVALID_RESULT')
        fixtureAgentId = agents[0].id; fixtureTaskId = fixture.id; fixtureSessionId = fixture.session_id ?? undefined; conversationUsed = !!fixtureSessionId
        if (fixtureSessionId) {
          await selectTask(fixtureTaskId)
          const resumed = await client.invoke('agentSession:resume', [fixtureAgentId, fixtureTaskId, fixtureSessionId])
          if (resumed.sessionId !== fixtureSessionId) throw new ServiceProtocolError('INVALID_RESULT')
        }
      }
      hydrated = true
      create.disabled = false
      refreshAgentControls()
      return
    }
    // Bound recovery rather than restoring an older list after a racing deletion/update.
    throw new ServiceProtocolError('BACKPRESSURE')
  })()
  void ready.catch(failed)
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (!input.value.trim() || create.disabled) return
    create.disabled = true
    void client.invoke('db:createTask', [{ title: input.value.trim() }]).then(task => {
      tasks.set(task.id, task); drawTasks(); input.value = ''
    }).catch(failed).finally(() => { create.disabled = client.connection.status !== 'ready' || !hydrated })
  })

  function observe(operation: string): { seen: Set<string>; stop: () => void } {
    const seen = new Set<string>()
    const callback = (id: string): void => { seen.add(id) }
    let callbacks = observers.get(operation)
    if (!callbacks) { callbacks = new Set(); observers.set(operation, callbacks) }
    callbacks.add(callback)
    return { seen, stop: () => { callbacks.delete(callback) } }
  }
  async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    return check()
  }

  ;(window as SmokeWindow).__TWENTYONEX_DATABASE_SMOKE__ = async () => {
    const proof = Object.fromEntries(proofKeys.map(key => [key, false])) as Proof
    try {
      await ready
      const saved = sessionStorage.getItem(smokeKey)
      if (!saved) {
        const created = observe('task:created')
        const updated = observe('task:updated')
        try {
          const task = await client.invoke('db:createTask', [{ title: 'Synthetic migration task' }])
          proof.taskCreated = !!task.id && task.title === 'Synthetic migration task'
          proof.taskEventObserved = await waitFor(() => created.seen.has(task.id) && tasks.has(task.id))
          const changed = await client.invoke('db:updateTask', [task.id, { title: 'Synthetic task after edit' }])
          proof.taskUpdated = changed?.title === 'Synthetic task after edit'
          proof.updateEventObserved = await waitFor(() => updated.seen.has(task.id))
          const project = await client.invoke('project:create', [{ name: 'Synthetic migration project' }])
          if (!project) throw new ServiceProtocolError('INVALID_RESULT')
          proof.projectCreated = !!project.id
          proof.missingResultPreserved = await client.invoke('db:getTask', ['missing-synthetic-task']) === undefined
          const value = crypto.randomUUID()
          await client.invoke('settings:set', ['synthetic_ui_value', value])
          proof.settingPersisted = await client.invoke('settings:get', ['synthetic_ui_value']) === value
          await selectTask(task.id)
          proof.transcriptSnapshotRead = true
          proof.transcriptDeltaRead = true
          try { await native.core.invoke('desktop_invoke', { operation: 'browser:new', payload: {}, engineEpoch: client.connection.engineEpoch }) }
          catch (error) { proof.retiredOperationDenied = isRecord(error) && error.code === 'UNKNOWN_OPERATION' }
          try { await native.core.invoke('desktop_invoke', { operation: 'db:getTasks', payload: {}, engineEpoch: 'wrong-epoch' }) }
          catch (error) { proof.staleEpochDenied = isRecord(error) && error.code === 'STALE_EPOCH' }
          if (agentEnabled) {
            await startFixtureAgent()
            proof.agentStarted = !!fixtureSessionId
            proof.approvalRequested = await waitFor(() => agentStatus === 'waiting_approval' && !!pendingApproval(), 12000)
            proof.agentStatusEventObserved = agentStatusObserved
            if (!fixtureSessionId || !pendingApproval()) return proof
            try { await client.invoke('agentSession:approve', [fixtureSessionId, true, undefined, 'permission', 'stale-fixture-request']) }
            catch (error) { proof.staleApprovalDenied = error instanceof ServiceProtocolError && error.code === 'INVALID_REQUEST' }
          }
          if (proofKeys.filter(key => !['rendererReloaded', 'rehydrated', 'agentTranscriptRehydrated', 'approvalAccepted', 'agentCompleted'].includes(key)).some(key => !proof[key])) return proof
          sessionStorage.setItem(smokeKey, JSON.stringify({ taskId: task.id, projectId: project.id, value, proof }))
          return { reloadRequired: true }
        } finally { created.stop(); updated.stop() }
      }
      const original: unknown = JSON.parse(saved)
      if (!isRecord(original) || !isRecord(original.proof) || typeof original.taskId !== 'string' ||
        typeof original.projectId !== 'string' || typeof original.value !== 'string') throw new ServiceProtocolError('INVALID_RESULT')
      for (const key of proofKeys) proof[key] = original.proof[key] === true
      const task = await client.invoke('db:getTask', [original.taskId])
      const project = await client.invoke('project:get', [original.projectId])
      const setting = await client.invoke('settings:get', ['synthetic_ui_value'])
      await selectTask(original.taskId)
      proof.rendererReloaded = true
      proof.rehydrated = task?.title === 'Synthetic task after edit' && tasks.has(original.taskId) &&
        project?.id === original.projectId && setting === original.value && !!list.querySelector(`[data-task-id="${original.taskId}"]`)
      if (agentEnabled && fixtureTaskId && fixtureAgentId && fixtureSessionId) {
        await selectTask(fixtureTaskId)
        const pending = await waitFor(() => agentStatus === 'waiting_approval' && !!pendingApproval(), 12000)
        proof.agentTranscriptRehydrated = pending && !agentApprove.disabled && transcript.textContent?.includes('Allow the synthetic change?') === true
        await answerFixture(true)
        proof.approvalAccepted = await waitFor(() => projection.sorted.some(part => part.content === 'Applied the approved synthetic change.'), 12000)
        proof.agentCompleted = await waitFor(() => tasks.get(fixtureTaskId!)?.status === 'ready_for_review', 12000)
      }
      sessionStorage.removeItem(smokeKey)
    } catch { /* Return partial fixed metadata only; no native data/errors are exported. */ }
    return proof
  }
  window.addEventListener('beforeunload', () => { client.dispose(); observers.clear() }, { once: true })
  await ready
}
