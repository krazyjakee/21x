import { DesktopClient } from '../renderer/src/lib/desktop-client'
import { createTauriDesktopTransport, getTauriEngineEpoch, type TauriDesktopApi } from '../renderer/src/lib/tauri-desktop-transport'
import { DATABASE_COMMAND_CODECS, DATABASE_EVENT_CODECS } from '../shared/database-desktop-codecs'
import { createProjection, applyPartsToProjection } from '../shared/transcript/projection'
import { isRecord, ServiceProtocolError } from '../shared/service-protocol'
import type { Task } from '../renderer/src/types'

const smokeKey = '21x.database-slice.reload.v1'
const proofKeys = [
  'taskCreated', 'taskEventObserved', 'taskUpdated', 'updateEventObserved', 'projectCreated',
  'missingResultPreserved', 'settingPersisted', 'transcriptSnapshotRead', 'transcriptDeltaRead',
  'rendererReloaded', 'rehydrated', 'retiredOperationDenied', 'staleEpochDenied'
] as const
type Proof = Record<typeof proofKeys[number], boolean>
type SmokeWindow = Window & { __TWENTYONEX_DATABASE_SMOKE__?: () => Promise<Proof | { reloadRequired: true }> }

/** A migration test surface; it is mounted only when the host identifies its synthetic service. */
export async function mountSyntheticTaskSlice(native: TauriDesktopApi): Promise<void> {
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
  let revision = 0
  let hydrated = false
  const projection = createProjection()
  const observers = new Map<string, Set<(id: string) => void>>()
  const client = new DesktopClient({
    transport: createTauriDesktopTransport(native), commands: DATABASE_COMMAND_CODECS, events: DATABASE_EVENT_CODECS,
    onState: state => {
      if (state.status !== 'ready') hydrated = false
      status.textContent = state.status === 'ready' ? 'Connected to isolated test data.' :
        state.status === 'connecting' ? 'Connecting…' : 'Connection unavailable. Reload the window to reconnect.'
      create.disabled = state.status !== 'ready' || !hydrated
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
  }
  function notify(operation: string, id: string): void { for (const callback of observers.get(operation) ?? []) callback(id) }
  function failed(): void { status.textContent = 'The isolated data operation failed.' }
  async function selectTask(id: string, reset = false): Promise<void> {
    const generation = ++selectionGeneration
    if (selected !== id || reset) {
      projection.parts.clear(); projection.sorted.length = 0; projection.rev = 0
    }
    selected = id
    const snapshot = await client.invoke('agentSession:getTranscriptSnapshot', [id])
    if (generation !== selectionGeneration) return
    applyPartsToProjection(projection, snapshot, Math.max(0, ...snapshot.map(part => part.rev)))
    const delta = await client.invoke('agentSession:getTranscriptDelta', [id, projection.rev])
    if (generation !== selectionGeneration) return
    applyPartsToProjection(projection, delta.parts, delta.maxRev)
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
    if (event.reloadRequired) { void selectTask(event.taskId, true).catch(failed); return }
    applyPartsToProjection(projection, event.parts, event.maxRev)
    drawTranscript()
  })

  const ready = (async () => {
    await client.connect(await getTauriEngineEpoch(native))
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = revision
      const snapshot = await client.invoke('db:getTasks', [])
      if (before !== revision) continue
      tasks.clear()
      for (const task of snapshot) tasks.set(task.id, task)
      drawTasks()
      hydrated = true
      create.disabled = false
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
  async function waitFor(check: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 3000
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
          if (proofKeys.filter(key => !['rendererReloaded', 'rehydrated'].includes(key)).some(key => !proof[key])) return proof
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
      sessionStorage.removeItem(smokeKey)
    } catch { /* Return partial fixed metadata only; no native data/errors are exported. */ }
    return proof
  }
  window.addEventListener('beforeunload', () => { client.dispose(); observers.clear() }, { once: true })
  await ready
}
