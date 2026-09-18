import { useEffect, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSchedulerStore } from '@/stores/agent-scheduler-store'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useAgentSessionActions } from './use-agent-session'
import { onAgentStatus, onTaskUpdated, onTaskCreated, taskApi } from '@/lib/ipc-client'
import { TaskStatus } from '@/types'
import { isSuccessorGraphInProgress } from '@shared/subtask-graph'
import type { Task, Agent, TaskPriority } from '@/types'
import type { AgentStatusEvent } from '@/types/electron.d'
import type { TaskSession } from '@/stores/agent-store'

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0
}

const MAX_TRIAGE_ATTEMPTS = 2

const ACTIVE_STATUSES = new Set<TaskStatus>([
  TaskStatus.AgentWorking,
  TaskStatus.ReadyForReview,
  TaskStatus.Triaging,
  TaskStatus.AgentLearning
])

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
 *  - `wait`:    a sibling is still active; retry when it finishes
 *  - `ready`:   `nextId` may start
 */
type FamilyGate = { state: 'blocked' | 'wait' } | { state: 'ready'; nextId: string | undefined }

function familyGate(parent: Task | undefined, siblings: Task[]): FamilyGate {
  if (!parent || parent.status !== TaskStatus.NotStarted) return { state: 'blocked' }
  // Successor edges own sequencing once the run has begun.
  if (isSuccessorGraphInProgress(siblings)) return { state: 'blocked' }
  if (siblings.some((s) => ACTIVE_STATUSES.has(s.status))) return { state: 'wait' }
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

export function useAgentAutoStart({ tasks, agents, showToast }: UseAgentAutoStartProps) {
  // Sessions are read non-reactively: subscribing would re-render the whole
  // AppLayout on every agent message.
  const getSessionsSnapshot = useCallback(() => useAgentStore.getState().sessions, [])
  // Select only the flag and the (stable) actions; the running/queue maps
  // change constantly and would re-render AppLayout on every change.
  const isEnabled = useAgentSchedulerStore((s) => s.isEnabled)
  const {
    incrementRunningCount,
    decrementRunningCount,
    getRunningCount,
    addToQueue,
    removeFromQueue,
    getNextQueuedTask,
    clearQueues
  } = useAgentSchedulerStore(useShallow((s) => ({
    incrementRunningCount: s.incrementRunningCount,
    decrementRunningCount: s.decrementRunningCount,
    getRunningCount: s.getRunningCount,
    addToQueue: s.addToQueue,
    removeFromQueue: s.removeFromQueue,
    getNextQueuedTask: s.getNextQueuedTask,
    clearQueues: s.clearQueues
  })))

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

        if (sorted.some((s: Task) => ACTIVE_STATUSES.has(s.status))) return

        const nextSubtask = sorted.find((s: Task) => s.status === TaskStatus.NotStarted && !!s.agent_id)
        if (!nextSubtask || !nextSubtask.agent_id) return

        const subtaskAgent = agentsRef.current.find((a) => a.id === nextSubtask.agent_id)
        if (!subtaskAgent) {
          console.warn(`[AutoStart] Agent ${nextSubtask.agent_id} not found for subtask ${nextSubtask.id}`)
          return
        }

        const maxParallel = subtaskAgent.config.max_parallel_sessions || 1
        const currentRunning = getRunningCount(nextSubtask.agent_id)
        if (currentRunning < maxParallel) {
          incrementRunningCount(nextSubtask.agent_id)
          try {
            await start(nextSubtask.agent_id, nextSubtask.id)
            showToastRef.current(`Started subtask "${nextSubtask.title}" with ${subtaskAgent.name}`)
          } catch (error) {
            console.error(`[AutoStart] Failed to start subtask ${nextSubtask.id}:`, error)
            decrementRunningCount(nextSubtask.agent_id)
          }
        } else {
          addToQueue(nextSubtask.agent_id, nextSubtask.id)
        }
      } catch (error) {
        console.error(`[AutoStart] startNextSubtask error for parent ${parentId}:`, error)
      } finally {
        // Hold the lock briefly so the status change can propagate first.
        setTimeout(() => launchingSubtaskForRef.current.delete(parentId), 2000)
      }
    },
    [getRunningCount, incrementRunningCount, start, decrementRunningCount, addToQueue]
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
        incrementRunningCount(defaultAgent.id)
        await start(defaultAgent.id, taskId)
      } catch (error) {
        console.error(`[AutoStart] Failed to start triage for task ${taskId}:`, error)
        triagingRef.current.delete(taskId)
        try {
          await taskApi.update(taskId, { status: TaskStatus.NotStarted })
        } catch {
          // ignore revert error
        }

        decrementRunningCount(defaultAgent.id)
      }
    },
    [incrementRunningCount, start, decrementRunningCount]
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

  // Starts as many tasks as the agent has free slots for; queues the rest.
  const startTasksForAgent = useCallback(
    async (agentId: string, taskIds: string[], agent: Agent) => {
      const maxParallel = agent.config.max_parallel_sessions || 1
      const availableSlots = maxParallel - getRunningCount(agentId)

      if (availableSlots <= 0) {
        taskIds.forEach((taskId) => addToQueue(agentId, taskId))
        return
      }

      taskIds.slice(availableSlots).forEach((taskId) => addToQueue(agentId, taskId))

      for (const taskId of taskIds.slice(0, availableSlots)) {
        try {
          const task = tasksRef.current.find((t) => t.id === taskId)
          if (!task) continue

          incrementRunningCount(agentId)
          await start(agentId, taskId)

          showToastRef.current(`Started "${task.title}" with ${agent.name}`)
        } catch (error) {
          console.error(`Failed to start task ${taskId}:`, error)
          decrementRunningCount(agentId)
          showToastRef.current(`Failed to start task: ${error}`, true)
        }
      }
    },
    [getRunningCount, addToQueue, incrementRunningCount, start, decrementRunningCount]
  )

  const processNextTask = useCallback(
    async (agentId: string) => {
      const agent = agentsRef.current.find((a) => a.id === agentId)
      if (!agent) return

      const maxParallel = agent.config.max_parallel_sessions || 1
      const currentRunning = getRunningCount(agentId)

      if (currentRunning >= maxParallel) return

      const nextTaskId = getNextQueuedTask(agentId)
      if (!nextTaskId) return

      const task = tasksRef.current.find((t) => t.id === nextTaskId)
      if (!task) {
        removeFromQueue(agentId, nextTaskId)
        return
      }

      if (
        isRecurringTemplate(task) ||
        task.status !== TaskStatus.NotStarted ||
        task.agent_id !== agentId ||
        isSnoozed(task.snoozed_until) ||
        getSessionsSnapshot().has(task.id)
      ) {
        removeFromQueue(agentId, nextTaskId)
        return
      }

      if (task.parent_task_id) {
        const parentId = task.parent_task_id
        const currentTasks = tasksRef.current
        const gate = familyGate(
          currentTasks.find((t) => t.id === parentId),
          currentTasks.filter((t) => t.parent_task_id === parentId)
        )
        // An active sibling keeps this subtask queued until the sibling finishes.
        if (gate.state === 'wait') return
        if (!subtaskMayStart(task, gate)) {
          removeFromQueue(agentId, nextTaskId)
          return
        }
      }

      try {
        removeFromQueue(agentId, nextTaskId)
        incrementRunningCount(agentId)
        await start(agentId, nextTaskId)

        showToastRef.current(`Started "${task.title}" with ${agent.name}`)
      } catch (error) {
        console.error(`Failed to start task ${nextTaskId}:`, error)
        decrementRunningCount(agentId)
        showToastRef.current(`Failed to start task: ${error}`, true)
      }
    },
    [
      getSessionsSnapshot,
      getRunningCount,
      getNextQueuedTask,
      removeFromQueue,
      incrementRunningCount,
      start,
      decrementRunningCount
    ]
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

  // An agent going idle frees a slot (and may finish a triage).
  useEffect(() => {
    if (!isEnabled) return

    const unsubscribe = onAgentStatus((event: AgentStatusEvent) => {
      if (event.status !== SessionStatus.IDLE) return

      const agentId = event.agentId
      const taskId = event.taskId

      if (triagingRef.current.has(taskId)) {
        triagingRef.current.delete(taskId)
        decrementRunningCount(agentId)

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

            const maxParallel = assignedAgent.config.max_parallel_sessions || 1
            const currentRunning = getRunningCount(assignedAgentId)
            if (currentRunning < maxParallel) {
              void startTasksForAgent(assignedAgentId, [taskId], assignedAgent)
            } else {
              addToQueue(assignedAgentId, taskId)
            }
          }
        }, 500)

        setTimeout(() => processNextTask(agentId), 100)
        return
      }

      decrementRunningCount(agentId)

      const task = tasksRef.current.find((t) => t.id === event.taskId)
      if (task?.status === TaskStatus.Completed) {
        const agent = agentsRef.current.find((a) => a.id === agentId)
        if (agent) {
          showToastRef.current(`"${task.title}" completed by ${agent.name}`)
        }
      }

      setTimeout(() => processNextTask(agentId), 100)
    })

    return unsubscribe
  }, [isEnabled, decrementRunningCount, processNextTask, getRunningCount, addToQueue, startTasksForAgent, startNextSubtask])

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

          const maxParallel = agent.config.max_parallel_sessions || 1
          const currentRunning = getRunningCount(agentId)

          if (currentRunning < maxParallel) {
            startTasksForAgent(agentId, [task.id], agent)
          } else {
            addToQueue(agentId, task.id)
          }
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
    getRunningCount,
    addToQueue,
    startTasksForAgent,
    startTriage,
    startNextSubtask
  ])

  useEffect(() => {
    if (!isEnabled) {
      clearQueues()
    }
  }, [isEnabled, clearQueues])

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
        if (!agent) return
        const availableSlots = (agent.config.max_parallel_sessions || 1) - getRunningCount(agentId)
        if (availableSlots > 0 && taskIds.length > 0) startTasksForAgent(agentId, taskIds, agent)
      })
    }, 60000)

    return () => clearInterval(intervalId)
  }, [isEnabled, getSessionsSnapshot, selectEligibleTasks, selectTriageCandidates, getRunningCount, startTasksForAgent, startTriage])
}
