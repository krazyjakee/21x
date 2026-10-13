import { useEffect, useState } from 'react'
import type { TaskGroupRecord } from '@shared/task-groups'
import { onTasksRefresh, onTaskUpdated, taskGroupsApi } from '@/lib/ipc-client'
import { TaskGroupDialog } from './TaskGroupDialog'

/** Historical memberships remain readable after removal and dissolution. */
export function TaskGroupHistoryNotice({ taskId }: { taskId: string }) {
  const [history, setHistory] = useState<TaskGroupRecord[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false, request = 0, scheduled = false
    const reload = async () => {
      const mine = ++request
      try { const groups = await taskGroupsApi.history(taskId); if (!disposed && request === mine) { setHistory(groups); setError('') } }
      catch { if (!disposed && request === mine) setError('Group history could not be loaded.') }
    }
    const queueReload = () => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; if (!disposed) void reload() })
    }
    setHistory([]); setError(''); setOpen(null); void reload()
    const offRefresh = onTasksRefresh(queueReload)
    const offUpdate = onTaskUpdated(queueReload)
    return () => { disposed = true; offRefresh?.(); offUpdate?.() }
  }, [taskId])
  if (!history.length && !error) return null
  return <aside className="shrink-0 border-b border-border bg-primary/5 px-4 py-2 text-sm" aria-label="Task group history">
    {error && <p className="text-muted-foreground">{error}</p>}
    {history.map(group => <p key={group.id}>{group.state === 'active' && group.task_ids.includes(taskId) ? 'Shares an agent session with its task group.' : 'Previously worked in a task group. Shared history is retained.'} <button className="font-medium underline" onClick={() => setOpen(group.id)} aria-label={`Open shared conversation for ${group.title}`}>{group.title}</button></p>)}
    <TaskGroupDialog groupId={open} onClose={() => setOpen(null)} />
  </aside>
}
