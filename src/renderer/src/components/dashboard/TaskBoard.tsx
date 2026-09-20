import { useMemo, useCallback, useEffect, useRef, useState, memo } from 'react'
import { Clock, AlertCircle, CheckCircle2, ExternalLink, Bot, Terminal } from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type CollisionDetection
} from '@dnd-kit/core'
import { Badge } from '@/components/ui/Badge'
import { OpenCodeLogo, AnthropicLogo, OpenAILogo, PiLogo } from '@/components/icons/AgentLogos'
import { useTaskStore } from '@/stores/task-store'
import { useProjectTasks } from '@/hooks/use-project-tasks'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { useProjectStore } from '@/stores/project-store'
import { useBoardOrderStore } from '@/stores/board-order-store'
import { boardColumnKey, sortBoardColumn } from '@/lib/board-order'
import { useSnoozeTick } from '@/hooks/use-snooze-tick'
import { isSnoozed, isOverdue, formatDueDistance } from '@/lib/utils'
import { agentApi, onAgentStartQueueChanged } from '@/lib/ipc-client'
import { TASK_STATUS_STYLES, type TaskStatusStyle } from '@shared/task-status-styles'
import { TaskStatus, CodingAgentType } from '@/types'
import type { Task, Agent } from '@/types'
import type { TaskBoardTransitionPhase, TaskBoardTransitionResult } from './task-board-transition'

// ── Status column definitions ─────────────────────────────────
// Styling comes from the shared status map so the board, the task lists and
// the mobile UI stay in step. Completed remains a compact drop target in the
// header so a long task history does not take over the active board.

interface StatusColumn extends TaskStatusStyle {
  key: TaskStatus
}

const COLUMNS: StatusColumn[] = [
  TaskStatus.NotStarted,
  TaskStatus.Triaging,
  TaskStatus.AgentWorking,
  TaskStatus.ReadyForReview,
  TaskStatus.AgentLearning
].map((key) => ({ key, ...TASK_STATUS_STYLES[key] }))

// Pointer drops must land inside a target. Using closestCenter for pointer
// input can select the Completed badge (or another nearby column) even when
// the cursor is not over it. Keyboard dragging has no pointer coordinates, so
// it keeps the directional closest-target behaviour.
const boardCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  if (pointerCollisions.length > 0) return pointerCollisions
  return args.pointerCoordinates ? [] : closestCenter(args)
}

function getPriorityVariant(priority: string): 'red' | 'orange' | 'yellow' | 'default' {
  switch (priority) {
    case 'critical':
      return 'red'
    case 'high':
      return 'orange'
    case 'medium':
      return 'yellow'
    case 'low':
      return 'default'
    default:
      return 'default'
  }
}

function getPriorityAccent(priority: string): string {
  switch (priority) {
    case 'critical':
      return 'border-l-red-500/40'
    case 'high':
      return 'border-l-orange-500/40'
    case 'medium':
      return 'border-l-amber-400/35'
    case 'low':
      return 'border-l-gray-500/25'
    default:
      return 'border-l-gray-500/15'
  }
}

// ── Initials Avatar ──────────────────────────────────────────

const AVATAR_COLORS = [
  'bg-blue-500/80',
  'bg-emerald-500/80',
  'bg-teal-500/80',
  'bg-amber-500/80',
  'bg-rose-500/80',
  'bg-cyan-500/80',
  'bg-indigo-500/80',
  'bg-teal-500/80',
]

function getAvatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function AssigneeAvatar({ name }: { name: string }) {
  return (
    <div
      className={`h-6 w-6 rounded-full flex items-center justify-center text-2xs font-bold text-white shrink-0 ring-1 ring-white/10 ${getAvatarColor(name)}`}
      title={name}
    >
      {getInitials(name)}
    </div>
  )
}

// ── Source badge ──────────────────────────────────────────────

function getSourceConfig(source: string): { label: string; color: string } {
  const s = source.toLowerCase()
  if (s.includes('trello')) return { label: 'Trello', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' }
  if (s.includes('jira')) return { label: 'Jira', color: 'text-blue-300 bg-blue-400/10 border-blue-400/20' }
  if (s.includes('linear')) return { label: 'Linear', color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' }
  if (s.includes('asana')) return { label: 'Asana', color: 'text-rose-400 bg-rose-500/10 border-rose-500/20' }
  if (s.includes('github')) return { label: 'GitHub', color: 'text-gray-300 bg-gray-500/10 border-gray-500/20' }
  if (s.includes('notion')) return { label: 'Notion', color: 'text-gray-300 bg-gray-400/10 border-gray-400/20' }
  return { label: source, color: 'text-muted-foreground bg-muted/20 border-border/30' }
}

// ── Agent display helper ─────────────────────────────────

function getAgentDisplay(agent: Agent | undefined): { name: string; Logo: React.FC<{ className?: string }> } | null {
  if (!agent) return null
  const name = agent.name || 'Agent'
  const codingAgent = agent.config?.coding_agent
  switch (codingAgent) {
    case CodingAgentType.CLAUDE_CODE:
      return { name, Logo: AnthropicLogo }
    case CodingAgentType.OPENCODE:
      return { name, Logo: OpenCodeLogo }
    case CodingAgentType.CODEX:
      return { name, Logo: OpenAILogo }
    case CodingAgentType.CURSOR:
      return { name, Logo: Terminal }
    case CodingAgentType.PI:
      return { name, Logo: PiLogo }
    default:
      return { name, Logo: ({ className }: { className?: string }) => <Bot className={className} /> }
  }
}

// ── Task Card ──────────────────────────────────────────────

function TaskCardContent({ task, agent, transitionPhase }: { task: Task; agent?: Agent; transitionPhase?: TaskBoardTransitionPhase }) {
  const overdue = task.due_date && task.status !== TaskStatus.Completed && isOverdue(task.due_date)
  const sourceConfig = task.source && task.source !== 'local' ? getSourceConfig(task.source) : null

  return (
    <>
      {/* Title + Priority */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <h4 className="text-base font-medium leading-snug line-clamp-2 flex-1 text-foreground/90 group-hover:text-foreground transition-colors">
          {task.title}
        </h4>
        {task.priority && task.priority !== 'low' && (
          <Badge variant={getPriorityVariant(task.priority)} className="text-2xs px-1.5 py-0 shrink-0 uppercase tracking-wider font-semibold">
            {task.priority}
          </Badge>
        )}
      </div>

      {transitionPhase && (
        <div
          role="status"
          data-testid={`task-transition-${task.id}`}
          className={`mb-2 inline-flex rounded-full border px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide ${
            transitionPhase === 'failed'
              ? 'border-red-500/30 bg-red-500/10 text-red-400'
              : transitionPhase === 'queued'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                : 'border-blue-500/30 bg-blue-500/10 text-blue-400'
          }`}
        >
          {transitionPhase}
        </div>
      )}

      {/* Description */}
      {task.description && (
        <p className="text-xs text-muted-foreground/80 line-clamp-2 mb-2.5 leading-relaxed">{task.description}</p>
      )}

      {/* Labels */}
      {task.labels && task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {task.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="text-xs font-medium px-2 py-0.5 rounded-full bg-muted/30 text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {task.labels.length > 3 && (
            <span className="text-xs text-muted-foreground/60 px-1 py-0.5">
              +{task.labels.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Footer: metadata + assignee/agent */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
          {task.due_date && (
            <span className={`flex items-center gap-1.5 shrink-0 ${overdue ? 'text-red-400 font-medium' : ''}`}>
              {overdue ? <AlertCircle className="size-icon-sm" /> : <Clock className="size-icon-sm opacity-60" />}
              {formatDueDistance(task.due_date)}
            </span>
          )}
          {sourceConfig && (
            <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border shrink-0 ${sourceConfig.color}`}>
              <ExternalLink className="size-icon-xs" />
              {sourceConfig.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          {(() => {
            const agentDisplay = getAgentDisplay(agent)
            if (!agentDisplay) return null
            const { name, Logo } = agentDisplay
            return (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0" title={name}>
                <Logo className="size-icon-sm opacity-70 shrink-0" />
                <span className="truncate">{name}</span>
              </span>
            )
          })()}
          {task.assignee && (
            <AssigneeAvatar name={task.assignee} />
          )}
        </div>
      </div>
    </>
  )
}

const TaskCard = memo(function TaskCard({ task, onSelect, agent, transitionPhase }: { task: Task; onSelect: (id: string) => void; agent?: Agent; transitionPhase?: TaskBoardTransitionPhase }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { taskId: task.id, status: task.status }
  })
  // A pointer drag ends with a click in some browser/Electron versions. Keep
  // that click from opening the task the user just moved.
  const didDragRef = useRef(false)
  if (isDragging) didDragRef.current = true
  useEffect(() => {
    if (isDragging || !didDragRef.current) return
    const timer = window.setTimeout(() => { didDragRef.current = false }, 0)
    return () => window.clearTimeout(timer)
  }, [isDragging])

  return (
    <div
      ref={setNodeRef}
      data-testid={`task-card-${task.id}`}
      className={`group touch-none rounded-lg border border-border/30 bg-card/80 p-3.5 hover:border-border/60 hover:bg-card hover:shadow-pop transition-[color,opacity,box-shadow] duration-200 cursor-grab active:cursor-grabbing border-l-2 ${getPriorityAccent(task.priority)} ${isDragging ? 'opacity-30' : ''}`}
      {...attributes}
      {...listeners}
      onClick={(event) => {
        if (didDragRef.current) {
          event.preventDefault()
          return
        }
        onSelect(task.id)
      }}
      onKeyDown={(event) => {
        listeners?.onKeyDown?.(event)
        if (!event.defaultPrevented && event.key === 'Enter') {
          event.preventDefault()
          onSelect(task.id)
        }
      }}
      aria-label={`${task.title}. Drag to change status, or press Enter to open.`}
    >
      <TaskCardContent task={task} agent={agent} transitionPhase={transitionPhase} />
    </div>
  )
})

function TaskCardOverlay({ task, agent }: { task: Task; agent?: Agent }) {
  return (
    <div
      className={`w-[292px] rounded-lg border border-border/70 bg-card p-3.5 shadow-2xl cursor-grabbing border-l-2 ${getPriorityAccent(task.priority)}`}
    >
      <TaskCardContent task={task} agent={agent} />
    </div>
  )
}

// ── Column header ────────────────────────────────────────────

const ColumnHeader = memo(function ColumnHeader({ column, count }: { column: StatusColumn; count: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-3">
      <div className={`h-2.5 w-2.5 rounded-full ${column.dot} ring-2 ring-black/20`} />
      <span className={`text-sm font-semibold tracking-wide ${column.text}`}>{column.label}</span>
      <span className={`text-xs font-medium rounded-full px-2 py-0.5 min-w-[24px] text-center ${column.headerBg} ${column.text}`}>
        {count}
      </span>
    </div>
  )
})

// ── Column wrapper ───────────────────────────────────────────

const BoardColumn = memo(function BoardColumn({ column, tasks, onSelect, agentMap, isDraggingTask, transitionStates, manualOrder, onSortByActivity }: { column: StatusColumn; tasks: Task[]; onSelect: (id: string) => void; agentMap: Map<string, Agent>; isDraggingTask: boolean; transitionStates: Record<string, TaskBoardTransitionPhase>; manualOrder: boolean; onSortByActivity: (status: TaskStatus) => void }) {
  const { isOver, setNodeRef } = useDroppable({
    id: `status:${column.key}`,
    data: { status: column.key }
  })

  return (
    <div
      ref={setNodeRef}
      role="group"
      data-testid={`task-column-${column.key}`}
      data-drop-active={isDraggingTask || undefined}
      data-drop-over={isOver || undefined}
      aria-label={`${column.label} column, ${tasks.length} task${tasks.length === 1 ? '' : 's'}`}
      className={`relative min-w-[248px] max-w-[340px] flex-1 flex flex-col rounded-xl ${column.columnBg} border transition-[border-color,box-shadow,background-color] ${isOver ? `border-current ring-2 ring-current/50 ${column.text}` : isDraggingTask ? 'border-foreground/30' : 'border-border/15'}`}
    >
      {/* Sticky header within column */}
      <div className={`sticky top-0 z-10 ${column.columnBg} backdrop-blur-md rounded-t-xl border-b border-border/15`}>
        <ColumnHeader column={column} count={tasks.length} />
        {manualOrder && (
          <button type="button" className="mx-3 mb-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onSortByActivity(column.key)}>
            Sort by activity
          </button>
        )}
      </div>

      {/* Cards */}
      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="text-xs text-muted-foreground/50 text-center py-8 px-2">
            No tasks
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} onSelect={onSelect} agent={task.agent_id ? agentMap.get(task.agent_id) : undefined} transitionPhase={transitionStates[task.id]} />)
        )}
      </div>

      {/* Full-column visual target. pointer-events-none keeps the underlying
          droppable element as the only hit target. */}
      {isDraggingTask && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-1 z-20 flex items-start justify-center rounded-lg border-2 border-dashed pt-14 transition-colors ${isOver ? `border-current bg-background/25 ${column.text}` : 'border-foreground/25'}`}
        >
          <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold shadow-sm backdrop-blur-md ${isOver ? `${column.headerBg} border-current ${column.text}` : 'border-border bg-card/90 text-muted-foreground'}`}>
            {isOver ? `Release in ${column.label}` : `Drop in ${column.label}`}
          </span>
        </div>
      )}
    </div>
  )
})

function CompletedDropTarget({ count, isDraggingTask }: { count: number; isDraggingTask: boolean }) {
  const completed = TASK_STATUS_STYLES[TaskStatus.Completed]
  const { isOver, setNodeRef } = useDroppable({
    id: `status:${TaskStatus.Completed}`,
    data: { status: TaskStatus.Completed }
  })

  return (
    <span
      ref={setNodeRef}
      role="group"
      data-testid="task-column-completed"
      data-drop-active={isDraggingTask || undefined}
      data-drop-over={isOver || undefined}
      aria-label={`Completed drop target, ${count} task${count === 1 ? '' : 's'}`}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-all ${completed.text} ${completed.headerBg} ${isOver ? 'border-emerald-400 ring-2 ring-emerald-400/30 scale-105' : isDraggingTask ? 'border-emerald-400/50' : 'border-transparent'}`}
    >
      <CheckCircle2 className="size-icon-sm" />
      {isDraggingTask ? (isOver ? 'Release to complete' : 'Drop to complete') : `${count} completed`}
    </span>
  )
}

export interface TaskBoardProps {
  onStatusChange?: (task: Task, status: TaskStatus) => void | TaskBoardTransitionResult | Promise<void | TaskBoardTransitionResult>
}

// ── TaskBoard ──────────────────────────────────────────────

export function TaskBoard({ onStatusChange }: TaskBoardProps = {}) {
  // Use individual selectors to prevent re-renders from unrelated store changes
  // The board shows the current project's tasks only.
  const tasks = useProjectTasks()
  const isLoading = useTaskStore((s) => s.isLoading)
  const agents = useAgentStore((s) => s.agents)
  const openDashboardPreview = useUIStore((s) => s.openDashboardPreview)
  const projectId = useProjectStore((s) => s.currentProjectId)
  const manualOrders = useBoardOrderStore((s) => s.orders)
  const resetColumnOrder = useBoardOrderStore((s) => s.resetColumnOrder)
  const previewTaskId = useUIStore((s) => s.dashboardPreviewTaskId)
  const handleSortByActivity = useCallback((status: TaskStatus) => {
    resetColumnOrder(projectId, status)
  }, [projectId, resetColumnOrder])
  const snoozeTick = useSnoozeTick(tasks)
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null)
  const [transitionStates, setTransitionStates] = useState<Record<string, TaskBoardTransitionPhase>>({})
  const [durableStates, setDurableStates] = useState<Record<string, TaskBoardTransitionPhase>>({})
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  )

  // Build agent lookup map by id
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>()
    for (const agent of agents) {
      map.set(agent.id, agent)
    }
    return map
  }, [agents])

  // Only show top-level tasks that are not snoozed (not subtasks) and not recurring templates
  const topLevelTasks = useMemo(
    () => tasks.filter((t) => !t.parent_task_id && !isSnoozed(t.snoozed_until) && !(t.is_recurring && !t.recurrence_parent_id)),
    [tasks, snoozeTick]
  )

  const visibleTaskIds = topLevelTasks.map(task => task.id).sort().join(',')
  // The durable queue is authoritative across reloads. Rehydrate it on mount
  // and follow main-process state changes so Queued/Starting never depend on
  // an optimistic drag that existed only in this renderer lifetime.
  useEffect(() => {
    let disposed = false
    let revision = 0
    const applyQueue = (queue: Awaited<ReturnType<typeof agentApi.getStartQueue>>): void => {
      if (disposed) return
      setDurableStates((current) => {
        const next = { ...current }
        for (const [taskId, phase] of Object.entries(next)) {
          if (phase === 'queued' || phase === 'starting') delete next[taskId]
        }
        for (const entry of queue) {
          next[entry.taskId] = entry.state === 'claimed' || entry.state === 'starting' ? 'starting' : 'queued'
        }
        return next
      })
    }
    const hydrate = async (): Promise<void> => {
      const requestedRevision = ++revision
      const ids = visibleTaskIds ? visibleTaskIds.split(',') : []
      try {
        // The active queue deliberately excludes terminal rows. Read the
        // existing per-task recovery endpoint to retain Failed across reloads.
        const states = await Promise.all(ids.map(id => agentApi.getStartRecoveryState(id)))
        if (disposed || revision !== requestedRevision) return
        const next: Record<string, TaskBoardTransitionPhase> = {}
        for (const entry of states) {
          if (!entry) continue
          if (entry.state === 'failed') next[entry.taskId] = 'failed'
          else if (entry.state === 'claimed' || entry.state === 'starting') next[entry.taskId] = 'starting'
          else if (entry.state === 'queued' || entry.state === 'retrying') next[entry.taskId] = 'queued'
        }
        setDurableStates(next)
        setTransitionStates(current => {
          const cleared = { ...current }
          for (const entry of states) {
            if (entry && (entry.state === 'started' || entry.state === 'recovered')) delete cleared[entry.taskId]
          }
          return cleared
        })
      } catch (error) {
        console.error('[TaskBoard] Could not load durable start recovery:', error)
      }
    }
    void hydrate()
    const unsubscribe = onAgentStartQueueChanged((event) => {
      applyQueue(event.queue)
      void hydrate()
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [visibleTaskIds])

  const displayedTransitions = useMemo(() => ({ ...transitionStates, ...durableStates }), [transitionStates, durableStates])

  // Open task preview modal (rendered by AppLayout with full TaskWorkspace)
  const handleSelectTask = useCallback((taskId: string) => {
    openDashboardPreview(taskId)
  }, [openDashboardPreview])

  const sortedTasksByStatus = useMemo(() => {
    const grouped: Record<string, Task[]> = {}
    for (const col of COLUMNS) {
      grouped[col.key] = []
    }
    let completedCount = 0
    for (const task of topLevelTasks) {
      const status = task.status || TaskStatus.NotStarted
      if (status === TaskStatus.Completed) {
        completedCount++
      } else if (grouped[status]) {
        grouped[status].push(task)
      } else {
        grouped[TaskStatus.NotStarted].push(task)
      }
    }
    // Recompute only when task data, status overrides, or manual preferences change.
    for (const col of COLUMNS) {
      grouped[col.key] = sortBoardColumn(grouped[col.key], manualOrders[boardColumnKey(projectId, col.key)])
    }
    return { grouped, completedCount }
  }, [topLevelTasks, manualOrders, projectId])

  // Once the acknowledged task status reaches an execution column, that
  // column itself is the truthful Working signal and the transient badge can
  // disappear. Failed remains until the user retries the drag.
  useEffect(() => {
    setTransitionStates((current) => {
      let changed = false
      const next = { ...current }
      for (const task of topLevelTasks) {
        if (
          next[task.id] !== 'failed' &&
          (task.status === TaskStatus.Triaging || task.status === TaskStatus.AgentWorking)
        ) {
          delete next[task.id]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [topLevelTasks])

  // Freeze column membership and order during dragging or an open task preview.
  // Data received during the interaction is applied when it closes. A project
  // switch must never show the previous project's held cards.
  const heldOrder = useRef({ projectId, value: sortedTasksByStatus })
  const interactionLocked = !!draggedTaskId || topLevelTasks.some((task) => task.id === previewTaskId)
  const tasksByStatus = interactionLocked && heldOrder.current.projectId === projectId
    ? heldOrder.current.value : sortedTasksByStatus
  useEffect(() => {
    if (!interactionLocked) heldOrder.current = { projectId, value: sortedTasksByStatus }
  }, [interactionLocked, projectId, sortedTasksByStatus])

  const activeTasks = topLevelTasks.length - tasksByStatus.completedCount
  const draggedTask = draggedTaskId
    ? topLevelTasks.find((task) => task.id === draggedTaskId) ?? null
    : null

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const taskId = String(event.active.id)
    setTransitionStates((current) => {
      if (!(taskId in current)) return current
      const next = { ...current }
      delete next[taskId]
      return next
    })
    setDraggedTaskId(taskId)
  }, [])

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const taskId = String(event.active.id)
    const status = event.over?.data.current?.status as TaskStatus | undefined
    const task = topLevelTasks.find((candidate) => candidate.id === taskId)
    if (!task || !status || task.status === status) {
      setDraggedTaskId(null)
      return
    }

    setDraggedTaskId(null)
    if (status === TaskStatus.Triaging || status === TaskStatus.AgentWorking) {
      setTransitionStates((current) => ({ ...current, [task.id]: 'starting' }))
    }

    try {
      const result = onStatusChange
        ? await onStatusChange(task, status)
        : await useTaskStore.getState().updateTask(task.id, { status })
      if (result && typeof result === 'object' && 'phase' in result) {
        const phase = result.phase
        if (phase === 'moved' || phase === 'working') {
          setTransitionStates((current) => {
            if (!(task.id in current)) return current
            const next = { ...current }
            delete next[task.id]
            return next
          })
        } else {
          setTransitionStates((current) => ({ ...current, [task.id]: phase }))
        }
      }
    } catch (error) {
      setTransitionStates((current) => ({ ...current, [task.id]: 'failed' }))
      console.error(`[TaskBoard] Failed to move task ${task.id} to ${status}:`, error)
    }
  }, [onStatusChange, topLevelTasks])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      onDragStart={handleDragStart}
      onDragCancel={() => setDraggedTaskId(null)}
      onDragEnd={(event) => { void handleDragEnd(event) }}
    >
      <section>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold tracking-wide">Task Board</h2>
          <div className="flex items-center gap-3">
            <CompletedDropTarget count={tasksByStatus.completedCount} isDraggingTask={!!draggedTask} />
            <span className="text-sm text-muted-foreground">
              {activeTasks} active task{activeTasks !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {isLoading ? (
          <div className="flex gap-3 pb-2 overflow-x-auto">
            {COLUMNS.map((col) => (
              <div key={col.key} className={`min-w-[248px] max-w-[340px] flex-1 rounded-xl ${col.columnBg} border border-border/15`}>
                <div className="px-3 py-3 border-b border-border/15">
                  <div className="flex items-center gap-2">
                    <div className={`h-2.5 w-2.5 rounded-full ${col.dot} opacity-40`} />
                    <span className="text-sm font-semibold text-muted-foreground/50">{col.label}</span>
                  </div>
                </div>
                <div className="p-2 space-y-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="rounded-lg border border-border/20 bg-card/40 p-3.5 border-l-2 border-l-gray-500/30">
                      <div className="h-3 w-24 rounded-md bg-muted/40 animate-pulse mb-2.5" />
                      <div className="h-2.5 w-36 rounded-md bg-muted/25 animate-pulse mb-2" />
                      <div className="h-2 w-20 rounded-md bg-muted/15 animate-pulse" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : topLevelTasks.length === 0 ? (
          <div className="rounded-xl border border-border/30 bg-card/50 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No tasks yet. Create tasks or sync from an integration to see them here.
            </p>
          </div>
        ) : (
          <div className="flex gap-3 pb-2 overflow-x-auto">
            {COLUMNS.map((col) => (
              <BoardColumn
                key={col.key}
                column={col}
                tasks={tasksByStatus.grouped[col.key] || []}
                onSelect={handleSelectTask}
                agentMap={agentMap}
                isDraggingTask={!!draggedTask}
                transitionStates={displayedTransitions}
                manualOrder={manualOrders[boardColumnKey(projectId, col.key)] !== undefined}
                onSortByActivity={handleSortByActivity}
              />
            ))}
          </div>
        )}
      </section>
      <DragOverlay dropAnimation={{ duration: 160, easing: 'ease-out' }}>
        {draggedTask ? (
          <TaskCardOverlay
            task={draggedTask}
            agent={draggedTask.agent_id ? agentMap.get(draggedTask.agent_id) : undefined}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
