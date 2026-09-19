import { useEffect, useRef, useCallback } from 'react'
import { useAgentSchedulerStore } from '@/stores/agent-scheduler-store'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useAgentSessionActions } from './use-agent-session'
import { onAgentStatus, onAgentStartQueueChanged, onTaskUpdated, onTaskCreated, taskApi } from '@/lib/ipc-client'
import { TaskStatus } from '@/types'
import { findBlockingSibling, isSuccessorGraphInProgress } from '@shared/subtask-graph'
import { PRIORITY_ORDER } from '@shared/constants'
import { isSnoozed } from '@shared/date-format'
import type { Task, Agent } from '@/types'
import type { AgentStatusEvent } from '@/types/electron.d'
import type { TaskSession } from '@/stores/agent-store'

const MAX_TRIAGE_ATTEMPTS = 2

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
export function useAgentAutoStart({ tasks, agents, showToast }: UseAgentAutoStartProps) {
  // Sessions are read non-reactively: subscribing would re-render the whole
  // AppLayout on every agent message.
  const getSessionsSnapshot = useCallback(() => useAgentStore.getState().sessions, [])
  const isEnabled = useAgentSchedulerStore((s) => s.isEnabled)

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
      if (event.status !== SessionStatus.IDLE) return

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
