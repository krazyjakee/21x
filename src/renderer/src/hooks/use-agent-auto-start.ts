import { isAgentStatusHeartbeat } from '@shared/activity'
import { useEffect, useRef, useCallback, useReducer } from 'react'
import { useAgentSchedulerStore } from '@/stores/agent-scheduler-store'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useAgentSessionActions } from './use-agent-session'
import { onAgentStatus, onAgentStartQueueChanged, onTaskUpdated, onTaskCreated, taskApi, agentSessionApi } from '@/lib/ipc-client'
import { TaskStatus } from '@/types'
import { findBlockingSibling, isSuccessorGraphInProgress } from '@shared/subtask-graph'
import type { Task, Agent, TaskPriority } from '@/types'
import type { AgentStatusEvent } from '@/types/electron.d'
import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { useProjectStore } from '@/stores/project-store'
import type { TaskSession } from '@/stores/agent-store'

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0
}

const MAX_TRIAGE_ATTEMPTS = 2

function isSnoozed(snoozedUntil: string | null): boolean {
  if (!snoozedUntil) return false
  return new Date(snoozedUntil) > new Date()
}

/** Recurring parent templates are never triaged or auto-started. */
function isRecurringTemplate(task: Task): boolean {
  return task.is_recurring && !task.recurrence_parent_id
}

function bySortOrder(a: Task, b: Task): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0)
}

/**
 * Subtasks of one parent run strictly in sort order, one at a time, and only
 * while the parent itself is not started.
 *  - `blocked`: nothing in this family may start
 *  - `wait`:    a sibling is still running; retry when it finishes. A sibling
 *               in `ready_for_review` does not block (see findBlockingSibling).
 *  - `ready`:   `nextId` may start
 */
type FamilyGate = { state: 'blocked' | 'wait' } | { state: 'ready'; nextId: string | undefined }

function familyGate(parent: Task | undefined, siblings: Task[]): FamilyGate {
  if (!parent || parent.status !== TaskStatus.NotStarted) return { state: 'blocked' }
  // Successor edges own sequencing once the run has begun.
  if (isSuccessorGraphInProgress(siblings)) return { state: 'blocked' }
  if (findBlockingSibling(siblings)) return { state: 'wait' }
  const sorted = [...siblings].sort(bySortOrder)
  return { state: 'ready', nextId: sorted.find((s) => s.status === TaskStatus.NotStarted)?.id }
}

function subtaskMayStart(task: Task, gate: FamilyGate): boolean {
  return gate.state === 'ready' && (!gate.nextId || gate.nextId === task.id)
}

interface UseAgentAutoStartProps {
  tasks: Task[]
  agents: Agent[]
  showToast: (message: string, isError?: boolean) => void
}

/**
 * Sidebar auto-run: decides *what* to start (triage, next subtask, eligible
 * tasks by priority). Whether a start may run now is the main process's call
 * (AgentManager admission control, #47): over an agent's
 * `max_parallel_sessions` or the global cap it queues the start itself and
 * runs it when a slot frees, window open or not. This hook keeps no running
 * counts or queue of its own.
 */
export function useAgentAutoStart(props: UseAgentAutoStartProps) {
  useNativeAgentAutoStart(props)
  useLegacyAgentAutoStart(props)
}

function useLegacyAgentAutoStart({ tasks, agents, showToast }: UseAgentAutoStartProps) {
  // Sessions are read non-reactively: subscribing would re-render the whole
  // AppLayout on every agent message.
  const getSessionsSnapshot = useCallback(() => useAgentStore.getState().sessions, [])
  const isEnabled = useAgentSchedulerStore((s) => s.isEnabled) && getDesktopHost().kind === 'electron'

  // tasks/agents/showToast live in refs so callbacks and IPC listeners stay
  // stable. Recreating them on every task:updated event re-subscribed every
  // listener and pinned the renderer at 100% CPU with several agents active.
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  const { start } = useAgentSessionActions(undefined)

  // Asks the main process to start; it either starts or queues the task.
  // A queued start keeps its pre-registered (empty) session in the store, so
  // this hook does not ask again while it waits.
  const launch = useCallback(
    async (agent: Agent, task: Pick<Task, 'id' | 'title'>, kind = '') => {
      try {
        const sessionId = await start(agent.id, task.id)
        showToastRef.current(
          sessionId
            ? `Started ${kind}"${task.title}" with ${agent.name}`
            : `Queued ${kind}"${task.title}" for ${agent.name} — it starts when a slot frees`
        )
      } catch (error) {
        console.error(`[AutoStart] Failed to start task ${task.id}:`, error)
        showToastRef.current(`Failed to start task: ${error}`, true)
      }
    },
    [start]
  )

  const processedUpdatesRef = useRef<Set<string>>(new Set())
  const triagingRef = useRef<Set<string>>(new Set())
  // Caps triage retries so a task the agent cannot classify is not retried for ever.
  const triageAttemptsRef = useRef<Map<string, number>>(new Map())
  // Parents currently launching a subtask, to prevent duplicate launches.
  const launchingSubtaskForRef = useRef<Set<string>>(new Set())

  // Reads fresh subtasks from the DB, starts the next one in sequence, and
  // marks the parent ReadyForReview once every subtask is completed.
  const startNextSubtask = useCallback(
    async (parentId: string) => {
      if (launchingSubtaskForRef.current.has(parentId)) return
      launchingSubtaskForRef.current.add(parentId)

      try {
        const parentTask = await taskApi.getById(parentId)
        if (!parentTask || parentTask.status !== TaskStatus.NotStarted) return

        const sorted = (await taskApi.getSubtasks(parentId)).sort(bySortOrder)
        if (sorted.length === 0) return

        if (sorted.every((s: Task) => s.status === TaskStatus.Completed)) {
          await taskApi.update(parentId, { status: TaskStatus.ReadyForReview })
          return
        }

        // Once successor edges drive this parent, the main process starts the
        // selected successors or wakes the parent — never pick by list order.
        if (isSuccessorGraphInProgress(sorted)) return

        if (findBlockingSibling(sorted)) return

        const nextSubtask = sorted.find((s: Task) => s.status === TaskStatus.NotStarted && !!s.agent_id)
        if (!nextSubtask || !nextSubtask.agent_id) return

        const subtaskAgent = agentsRef.current.find((a) => a.id === nextSubtask.agent_id)
        if (!subtaskAgent) {
          console.warn(`[AutoStart] Agent ${nextSubtask.agent_id} not found for subtask ${nextSubtask.id}`)
          return
        }

        await launch(subtaskAgent, nextSubtask, 'subtask ')
      } catch (error) {
        console.error(`[AutoStart] startNextSubtask error for parent ${parentId}:`, error)
      } finally {
        // Hold the lock briefly so the status change can propagate first.
        setTimeout(() => launchingSubtaskForRef.current.delete(parentId), 2000)
      }
    },
    [launch]
  )

  // Tasks with no agent that need triage. Subtasks are excluded: the
  // sequential subtask orchestration owns them.
  const selectTriageCandidates = useCallback(
    (allTasks: Task[], allSessions: Map<string, TaskSession>): string[] => {
      return allTasks
        .filter((task) => {
          if (isRecurringTemplate(task)) return false
          if (task.parent_task_id) return false

          const isNotStarted = task.status === TaskStatus.NotStarted
          const hasNoAgent = !task.agent_id
          const notSnoozed = !isSnoozed(task.snoozed_until)
          const noSession = !allSessions.has(task.id)
          const notAlreadyTriaging = !triagingRef.current.has(task.id)
          const attempts = triageAttemptsRef.current.get(task.id) || 0
          const withinRetryLimit = attempts < MAX_TRIAGE_ATTEMPTS

          return isNotStarted && hasNoAgent && notSnoozed && noSession && notAlreadyTriaging && withinRetryLimit
        })
        .map((task) => task.id)
    },
    []
  )

  const startTriage = useCallback(
    async (taskId: string) => {
      const currentAgents = agentsRef.current
      const defaultAgent = currentAgents.find((a) => a.is_default) || currentAgents[0]
      if (!defaultAgent) return

      const task = tasksRef.current.find((t) => t.id === taskId)
      if (!task) return

      triagingRef.current.add(taskId)

      try {
        await taskApi.update(taskId, { status: TaskStatus.Triaging })
        await start(defaultAgent.id, taskId)
      } catch (error) {
        console.error(`[AutoStart] Failed to start triage for task ${taskId}:`, error)
        triagingRef.current.delete(taskId)
        try {
          await taskApi.update(taskId, { status: TaskStatus.NotStarted })
        } catch {
          // ignore revert error
        }
      }
    },
    [start]
  )

  // Auto-start candidates grouped by agent, each list ordered by priority.
  const selectEligibleTasks = useCallback(
    (
      allTasks: Task[],
      allSessions: Map<string, TaskSession>
    ): Map<string, string[]> => {
      const byId = new Map<string, Task>()
      const childrenByParent = new Map<string, Task[]>()
      for (const task of allTasks) {
        byId.set(task.id, task)
        if (task.parent_task_id) {
          const siblings = childrenByParent.get(task.parent_task_id)
          if (siblings) siblings.push(task)
          else childrenByParent.set(task.parent_task_id, [task])
        }
      }
      const gates = new Map<string, FamilyGate>()
      const gateFor = (parentId: string): FamilyGate => {
        let gate = gates.get(parentId)
        if (!gate) {
          gate = familyGate(byId.get(parentId), childrenByParent.get(parentId) ?? [])
          gates.set(parentId, gate)
        }
        return gate
      }

      const tasksByAgent = new Map<string, Task[]>()
      for (const task of allTasks) {
        if (isRecurringTemplate(task)) continue
        // A parent with subtasks never runs itself; its subtasks run in sequence.
        if (childrenByParent.has(task.id)) continue
        if (task.parent_task_id && !subtaskMayStart(task, gateFor(task.parent_task_id))) continue
        if (
          task.status !== TaskStatus.NotStarted ||
          !task.agent_id ||
          isSnoozed(task.snoozed_until) ||
          allSessions.has(task.id)
        ) continue

        const agentTasks = tasksByAgent.get(task.agent_id)
        if (agentTasks) agentTasks.push(task)
        else tasksByAgent.set(task.agent_id, [task])
      }

      const result = new Map<string, string[]>()
      tasksByAgent.forEach((agentTasks, agentId) => {
        agentTasks.sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority])
        result.set(agentId, agentTasks.map((t) => t.id))
      })
      return result
    },
    []
  )

  // Requests each task in priority order; the main process starts as many as
  // the limits allow and queues the rest in the same order.
  const startTasksForAgent = useCallback(
    async (_agentId: string, taskIds: string[], agent: Agent) => {
      for (const taskId of taskIds) {
        const task = tasksRef.current.find((t) => t.id === taskId)
        if (!task || getSessionsSnapshot().has(taskId)) continue
        await launch(agent, task)
      }
    },
    [getSessionsSnapshot, launch]
  )

  // Debounced so a burst of task/agent changes starts work once.
  useEffect(() => {
    if (!isEnabled) return

    const timeoutId = setTimeout(() => {
      const sessions = getSessionsSnapshot()
      const latestTasks = tasksRef.current
      const latestAgents = agentsRef.current

      selectTriageCandidates(latestTasks, sessions).forEach((taskId) => startTriage(taskId))

      selectEligibleTasks(latestTasks, sessions).forEach((taskIds, agentId) => {
        const agent = latestAgents.find((a) => a.id === agentId)
        if (agent && taskIds.length > 0) startTasksForAgent(agentId, taskIds, agent)
      })
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [isEnabled, tasks, agents, getSessionsSnapshot, selectEligibleTasks, selectTriageCandidates, startTasksForAgent, startTriage])

  // An agent going idle may finish a triage. Freed slots are the main
  // process's business: it drains its own start queue.
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onAgentStatus((event: AgentStatusEvent) => {
      if (isAgentStatusHeartbeat(event) || event.status !== SessionStatus.IDLE) return

      const agentId = event.agentId
      const taskId = event.taskId

      if (triagingRef.current.has(taskId)) {
        triagingRef.current.delete(taskId)

        // The triage session must go, or the task never becomes eligible
        // for auto-start (eligibility requires no session).
        useAgentStore.getState().removeSession(taskId)

        // Delayed so triage's DB update (agent assignment) has landed.
        setTimeout(async () => {
          const updatedTask = await taskApi.getById(taskId)
          if (updatedTask && !updatedTask.agent_id) {
            const attempts = (triageAttemptsRef.current.get(taskId) || 0) + 1
            triageAttemptsRef.current.set(taskId, attempts)
            if (attempts >= MAX_TRIAGE_ATTEMPTS) {
              showToastRef.current(`Triage failed for "${updatedTask.title}" — please assign an agent manually`, true)
            }
          } else if (updatedTask?.agent_id) {
            triageAttemptsRef.current.delete(taskId)

            // Triage may have split the task; if so the subtasks run instead.
            const subtasks = await taskApi.getSubtasks(taskId)
            if (subtasks.length > 0) {
              await startNextSubtask(taskId)
              return
            }

            const assignedAgentId = updatedTask.agent_id
            const assignedAgent = agentsRef.current.find((a) => a.id === assignedAgentId)
            if (!assignedAgent) {
              showToastRef.current(`Triage assigned an unavailable agent for "${updatedTask.title}"`, true)
              return
            }

            void startTasksForAgent(assignedAgentId, [taskId], assignedAgent)
          }
        }, 500)
        return
      }

      const task = tasksRef.current.find((t) => t.id === event.taskId)
      if (task?.status === TaskStatus.Completed) {
        const agent = agentsRef.current.find((a) => a.id === agentId)
        if (agent) {
          showToastRef.current(`"${task.title}" completed by ${agent.name}`)
        }
      }
    })

    return unsubscribe
  }, [isEnabled, startTasksForAgent, startNextSubtask])

  // A queued start that failed in the main process leaves this hook's
  // pre-registered session behind; drop it so the task can be retried.
  useEffect(() => {
    if (!isEnabled) return
    return onAgentStartQueueChanged((event) => {
      if (!event.failed) return
      const session = useAgentStore.getState().sessions.get(event.failed.taskId)
      if (session && !session.sessionId) useAgentStore.getState().removeSession(event.failed.taskId)
      showToastRef.current(`Queued start failed: ${event.failed.error}`, true)
    })
  }, [isEnabled])

  // New top-level tasks without an agent are triaged.
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onTaskCreated((event) => {
      const task = event.task as Task
      if (isRecurringTemplate(task)) return
      if (task.parent_task_id) return
      if (
        task.status === TaskStatus.NotStarted &&
        !task.agent_id &&
        !isSnoozed(task.snoozed_until) &&
        !triagingRef.current.has(task.id)
      ) {
        setTimeout(() => startTriage(task.id), 200)
      }
    })

    return unsubscribe
  }, [isEnabled, startTriage])

  // `auto_start_agent` and `auto_complete_without_review` are deliberately NOT
  // handled here.
  //
  // Both used to live in this hook, driven by one-shot `task:created` /
  // `task:updated` events. That made them silently window-dependent: an
  // occurrence created while the window was closed, hidden or reloading never
  // saw its event and was never retried, so it sat in not_started for ever.
  // The auto-start copy was worse still — it incremented the per-agent running
  // count while the decrement lived behind the `isEnabled` gate (off by
  // default), so after one occurrence every agent looked permanently at
  // capacity and all later occurrences were queued and never started.
  //
  // Both flags are now owned by the main process (TaskAutomationScheduler,
  // plus AgentManager.transitionToIdle for the immediate case), which
  // reconciles against SQLite and therefore cannot miss an event.

  // Updates can make a task startable (agent assigned) or finish a subtask.
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onTaskUpdated((event) => {
      // The same update can arrive more than once in quick succession.
      const updateKey = `${event.taskId}-${JSON.stringify(event.updates)}`
      if (processedUpdatesRef.current.has(updateKey)) return
      processedUpdatesRef.current.add(updateKey)
      setTimeout(() => processedUpdatesRef.current.delete(updateKey), 1000)

      const staleTask = tasksRef.current.find((t) => t.id === event.taskId)
      if (!staleTask) return

      const task = { ...staleTask, ...event.updates } as Task
      if (isRecurringTemplate(task)) return

      if (task.parent_task_id && task.status === TaskStatus.Completed) {
        setTimeout(() => startNextSubtask(task.parent_task_id!), 300)
        return
      }

      if (
        task.status === TaskStatus.NotStarted &&
        task.agent_id &&
        !isSnoozed(task.snoozed_until) &&
        !getSessionsSnapshot().has(task.id)
      ) {
        // Triage completion starts this task itself; starting here too would race it.
        if (triagingRef.current.has(task.id)) return

        const agentId = task.agent_id
        const agent = agentsRef.current.find((a) => a.id === agentId)
        if (!agent) return

        // A parent with subtasks starts its first subtask instead of itself.
        setTimeout(async () => {
          try {
            const subtasks = await taskApi.getSubtasks(task.id)
            if (subtasks.length > 0) {
              await startNextSubtask(task.id)
              return
            }
          } catch {
            // If subtask check fails, proceed with normal start
          }

          void startTasksForAgent(agentId, [task.id], agent)
        }, 100)
      }

      if (
        task.status === TaskStatus.NotStarted &&
        !task.agent_id &&
        !isSnoozed(task.snoozed_until) &&
        !getSessionsSnapshot().has(task.id) &&
        !triagingRef.current.has(task.id) &&
        (triageAttemptsRef.current.get(task.id) || 0) < MAX_TRIAGE_ATTEMPTS
      ) {
        if (task.parent_task_id) return
        setTimeout(() => startTriage(task.id), 200)
      }
    })

    return unsubscribe
  }, [
    isEnabled,
    getSessionsSnapshot,
    startTasksForAgent,
    startTriage,
    startNextSubtask
  ])

  // Safety net: rescan every minute so nothing stays stuck if an event was missed.
  useEffect(() => {
    if (!isEnabled) return

    const intervalId = setInterval(() => {
      const latestTasks = tasksRef.current
      const latestAgents = agentsRef.current
      const sessions = getSessionsSnapshot()

      selectTriageCandidates(latestTasks, sessions).forEach((taskId) => startTriage(taskId))

      selectEligibleTasks(latestTasks, sessions).forEach((taskIds, agentId) => {
        const agent = latestAgents.find((a) => a.id === agentId)
        if (agent && taskIds.length > 0) void startTasksForAgent(agentId, taskIds, agent)
      })
    }, 60000)

    return () => clearInterval(intervalId)
  }, [isEnabled, getSessionsSnapshot, selectEligibleTasks, selectTriageCandidates, startTasksForAgent, startTriage])
}


function nativeAutoTaskBinding(task: Task): string {
  return JSON.stringify([task.id, task.project_id, task.role ?? 'task', task.status,
    task.agent_id, task.group_id, task.parent_task_id, task.source_id, task.external_id,
    task.source, task.snoozed_until, task.heartbeat_enabled, task.is_recurring, task.recurrence_parent_id,
    task.next_subtask_ids, task.sort_order, task.attachments, task.repos, task.skill_ids])
}
function nativeAutoAgentBinding(agent: Agent): string {
  return JSON.stringify([agent.id, agent.server_url, agent.config])
}
function nativeAutoFamilyBinding(task: Task, all: Task[]): string {
  return !task.parent_task_id ? '' : JSON.stringify(all.filter(t => t.id === task.parent_task_id || t.parent_task_id === task.parent_task_id).map(nativeAutoTaskBinding).sort())
}
interface NativeAutoIntent { task: Pick<Task, 'id' | 'title' | 'parent_task_id'>; agent: Pick<Agent, 'id' | 'name'>; binding: string; agentBinding: string; familyBinding: string; cancelled: boolean; bytes: number }

/** Window AutoRun owns only captured selection and future requests. Source owns
 * admission, triage classification, recovery policy and acknowledged queues. */
function useNativeAgentAutoStart(props: UseAgentAutoStartProps) {
  const native = getDesktopHost().kind === 'tauri'
  const enabled = useAgentSchedulerStore(s => s.isEnabled)
  const projectId = useProjectStore(s => s.currentProjectId)
  const latest = useRef(props); latest.current = props
  const cohort = useRef<{ reconcile: () => void } | null>(null)
  const outstanding = useRef<Promise<unknown> | null>(null)
  const [activation, activate] = useReducer(value => value + 1, 0)
  // Observe even disable/enable in one React batch. The old generation must
  // retire synchronously; an explicit new enable creates a separate intent.
  useEffect(() => native ? useAgentSchedulerStore.subscribe((state, previous) => {
    if (state.isEnabled !== previous.isEnabled) activate()
  }) : undefined, [native])
  useEffect(() => {
    if (!native || !enabled || !useAgentSchedulerStore.getState().isEnabled) return
    const host = getDesktopHost(), scope = captureDesktopRead()
    if (!scope.isCurrent()) { useAgentSchedulerStore.getState().disable(); return }
    const initialDefault = latest.current.agents.find(a => a.is_default) ?? latest.current.agents[0]
    const defaultAgent = initialDefault && structuredClone(initialDefault)
    const seen = new Set<string>(), refused = new Set<string>(), queue: NativeAutoIntent[] = []
    let live = true, draining = false, queuedBytes = 0, currentIntent: NativeAutoIntent | undefined, timer: ReturnType<typeof setTimeout> | undefined
    const releases: Array<() => void> = []
    const remember = (release: (() => void) | undefined) => { if (release) releases.push(release) }
    const active = () => live && scope.isCurrent() && useAgentSchedulerStore.getState().isEnabled
      && useProjectStore.getState().currentProjectId === projectId
    const retire = () => {
      if (!live) return
      live = false; queue.length = 0
      clearTimeout(timer); clearInterval(interval)
      for (const release of releases.splice(0)) release()
      window.removeEventListener('pagehide', retire)
      useAgentSchedulerStore.getState().disable()
    }
    const matches = (intent: NativeAutoIntent) => {
      if (!active() || intent.cancelled) return false
      const task = latest.current.tasks.find(t => t.id === intent.task.id)
      const agent = latest.current.agents.find(a => a.id === intent.agent.id)
      const currentDefault = latest.current.agents.find(a => a.is_default) ?? latest.current.agents[0]
      return !!task && !!agent && nativeAutoTaskBinding(task) === intent.binding
        && nativeAutoAgentBinding(agent) === intent.agentBinding
        && nativeAutoFamilyBinding(task, latest.current.tasks) === intent.familyBinding
        && (!!task.agent_id || currentDefault?.id === intent.agent.id)
    }
    const eligible = (task: Task) => (!task.role || task.role === 'task')
      && task.status === TaskStatus.NotStarted && !task.heartbeat_enabled && !isRecurringTemplate(task) && !isSnoozed(task.snoozed_until)
    const family = (task: Task, all: Task[]) => !task.parent_task_id || subtaskMayStart(task,
      familyGate(all.find(t => t.id === task.parent_task_id), all.filter(t => t.parent_task_id === task.parent_task_id)))
    const drain = async () => {
      if (draining) return
      draining = true
      try {
        while (active() && queue.length) {
          const intent = queue.shift()!; queuedBytes -= intent.bytes; currentIntent = intent
          if (!matches(intent) || refused.has(intent.task.id)) continue
          try {
            if (outstanding.current) { try { await outstanding.current } catch { /* Original cohort owns its receipt. */ } }
            if (!matches(intent)) continue
            const fresh = await taskApi.getById(intent.task.id)
            if (!matches(intent) || !fresh || nativeAutoTaskBinding(fresh) !== intent.binding || !eligible(fresh)) continue
            const children = await taskApi.getSubtasks(fresh.id)
            if (!matches(intent) || children.length) continue
            if (fresh.parent_task_id) {
              const capturedParent = latest.current.tasks.find(t => t.id === fresh.parent_task_id)
              const capturedSiblings = latest.current.tasks.filter(t => t.parent_task_id === fresh.parent_task_id)
              if (!capturedParent || !family(fresh, latest.current.tasks)) continue
              const parentBinding = nativeAutoTaskBinding(capturedParent)
              if (nativeAutoFamilyBinding(fresh, [capturedParent, ...capturedSiblings]) !== intent.familyBinding) continue
              const parent = await taskApi.getById(fresh.parent_task_id)
              if (!matches(intent) || !parent || nativeAutoTaskBinding(parent) !== parentBinding) continue
              const siblings = await taskApi.getSubtasks(fresh.parent_task_id)
              if (!matches(intent) || nativeAutoFamilyBinding(fresh, [parent, ...siblings]) !== intent.familyBinding
                || !subtaskMayStart(fresh, familyGate(parent, siblings))) continue
            }
            if (!matches(intent) || !family(fresh, latest.current.tasks)) continue
            // Exact selected target: unlike startTask this does not lift a
            // manual Stop or choose another child. No status/session prewrite,
            // workspace override, skipInitialPrompt or local session creation.
            const raw = agentSessionApi.start(intent.agent.id, fresh.id)
            outstanding.current = raw
            let result: Awaited<typeof raw>
            try { result = await raw } finally { if (outstanding.current === raw) outstanding.current = null }
            if (!matches(intent)) continue
            latest.current.showToast(result.queued
              ? `Queued "${intent.task.title}" — Source owns its admission queue`
              : `Started "${intent.task.title}" with ${intent.agent.name}`)
          } catch {
            refused.add(intent.task.id)
            if (matches(intent)) latest.current.showToast('AutoRun could not confirm this request. Review the task and queue before trying again.', true)
          }
        }
      } finally { currentIntent = undefined; draining = false; if (active()) reconcile() }
    }
    const reconcile = () => {
      if (!active()) return
      const snapshot = latest.current
      for (const task of [...snapshot.tasks].sort((a,b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority] || bySortOrder(a,b))) {
        if (!eligible(task) || !family(task, snapshot.tasks) || snapshot.tasks.some(t => t.parent_task_id === task.id)
          || !task.agent_id && task.parent_task_id || refused.has(task.id)) continue
        const agent = task.agent_id ? snapshot.agents.find(a => a.id === task.agent_id) : defaultAgent
        if (!agent) continue
        const key = JSON.stringify([task.id, task.agent_id])
        if (seen.has(key)) continue
        if (seen.size >= 4096 || refused.size >= 4096) { retire(); return }
        const binding = nativeAutoTaskBinding(task), agentBinding = nativeAutoAgentBinding(agent), familyBinding = nativeAutoFamilyBinding(task, snapshot.tasks)
        const bytes = new TextEncoder().encode(binding + agentBinding + familyBinding).byteLength
        if (bytes > 262_144) { refused.add(task.id); continue }
        if (queue.length >= 64 || queuedBytes + bytes > 2_097_152) break
        seen.add(key); queuedBytes += bytes
        queue.push({ task: { id: task.id, title: task.title, parent_task_id: task.parent_task_id }, agent: { id: agent.id, name: agent.name }, binding, agentBinding, familyBinding, cancelled: false, bytes })
      }
      if (!draining && queue.length && timer === undefined) timer = setTimeout(() => {
        timer = undefined; void drain().catch(retire)
      }, 300)
    }
    const interval = setInterval(reconcile, 60_000)
    const current = { reconcile }; cohort.current = current
    remember(host.subscribeConnection(() => { if (!scope.isCurrent()) retire() }))
    remember(useProjectStore.subscribe((state, previous) => { if (state.currentProjectId !== previous.currentProjectId) retire() }))
    remember(useAgentSchedulerStore.subscribe(state => { if (!state.isEnabled) retire() }))
    remember(onTaskCreated(reconcile))
    remember(onTaskUpdated(event => {
      // Authority withdrawals are observed synchronously even if React batches
      // a move/assignment away and back before the next render.
      const projected = latest.current.tasks.map(task => task.id === event.taskId ? { ...task, ...event.updates } : task)
      for (const intent of [...queue, ...(currentIntent ? [currentIntent] : [])]) {
        const task = projected.find(t => t.id === intent.task.id)
        if (!task || nativeAutoTaskBinding(task) !== intent.binding || nativeAutoFamilyBinding(task, projected) !== intent.familyBinding) intent.cancelled = true
      }
      reconcile()
    }))
    remember(onAgentStatus(event => { if (!isAgentStatusHeartbeat(event) && event.status === SessionStatus.IDLE) reconcile() }))
    remember(onAgentStartQueueChanged(event => {
      if (event.failed && active() && [...seen].some(key => JSON.parse(key)[0] === event.failed!.taskId)) {
        refused.add(event.failed.taskId)
        latest.current.showToast('A queued AutoRun request failed. Review the task and queue before trying again.', true)
      }
    }))
    window.addEventListener('pagehide', retire)
    reconcile()
    return () => { if (cohort.current === current) cohort.current = null; retire() }
  }, [native, enabled, activation, projectId])
  useEffect(() => { cohort.current?.reconcile() }, [props.tasks, props.agents])
}
