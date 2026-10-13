import { useRef, useEffect } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { Layers } from 'lucide-react'
import type { TaskGroupRecord } from '@shared/task-groups'
import { TaskStatus, type Task } from '@/types'
import { TaskActivityBadge } from '@/components/activity/TaskActivityBadge'
import { useTaskGroupStore } from '@/stores/task-group-store'

export function TaskGroupCard({ group, members, onOpen, onMember }: { group: TaskGroupRecord; members: Task[]; onOpen: () => void; onMember: (id: string) => void }) {
  const busy = useTaskGroupStore(state => state.busy[group.id])
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `group:${group.id}`, data: { groupId: group.id, status: group.status }, disabled: busy })
  const didDrag = useRef(false)
  if (isDragging) didDrag.current = true
  useEffect(() => { if (!isDragging && didDrag.current) { const timer = setTimeout(() => { didDrag.current = false }, 0); return () => clearTimeout(timer) } return undefined }, [isDragging])
  const error = useTaskGroupStore(state => state.errors[group.id])
  const owned = ['triaging', 'agent_working', 'agent_learning'].includes(group.status)
  return <article ref={setNodeRef} {...attributes} {...listeners} data-testid={`task-group-${group.id}`} aria-label={`${group.title}. Task group, ${group.task_ids.length} members. Drag to move the group or press Enter to open.`}
    className={`rounded-xl border-2 border-primary/40 bg-primary/5 p-3 shadow-xs ${isDragging ? 'opacity-30' : ''}`}
    onClick={event => { if (!(event.target as HTMLElement).closest('button, details') && !didDrag.current) onOpen() }}
    onKeyDown={event => {
      if (!isDragging && event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); onOpen(); return }
      listeners?.onKeyDown?.(event)
    }}>
    <div className="flex items-center gap-2 text-xs font-semibold text-primary"><Layers className="size-icon-sm" aria-hidden="true" />Task group · {group.task_ids.length} tasks</div>
    <button className="mt-2 w-full break-words text-left text-base font-semibold" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={onOpen}>{group.title}</button>
    <TaskActivityBadge taskId={group.execution_task_id} title={group.title} region="task-board" />
    <details className="mt-3" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <summary className="cursor-pointer text-sm">Show members</summary>
      <p className="mt-2 text-xs text-muted-foreground">Members move together. Remove a member before moving it separately.</p>
      <ul className="mt-2 space-y-2">{group.task_ids.map(id => {
        const member = members.find(task => task.id === id), progress = group.progress.find(item => item.task_id === id)
        return <li key={id} data-testid={`group-member-${id}`} data-group-member="true" className="rounded-md border border-border bg-card p-2 text-sm">
          <button className="w-full break-words text-left font-medium underline" onClick={() => onMember(id)}>{member?.title ?? 'Task details'}</button>
          <p className="mt-1 text-xs text-muted-foreground">{member?.status === TaskStatus.Completed ? 'Approved' : progress?.state === 'done' ? 'Agent finished · awaiting review' : progress?.state === 'blocked' ? 'Blocked' : progress?.state === 'working' ? 'Working' : 'Pending'}</p>
          {progress?.message && <p className="mt-1 break-words text-xs">{progress.message}</p>}
          <button disabled={owned || busy} className="mt-2 text-xs underline disabled:opacity-50" onClick={() => { void useTaskGroupStore.getState().remove(group.id, id).catch(() => {}) }} aria-label={`Remove ${member?.title ?? 'task'} from group`}>Remove from group</button>
        </li>
      })}</ul>
      {owned && <p className="mt-2 text-xs text-muted-foreground">Stop the shared session before changing membership.</p>}
    </details>
    {error && <p role="alert" className="mt-2 break-words text-sm text-destructive">{error}</p>}
  </article>
}
