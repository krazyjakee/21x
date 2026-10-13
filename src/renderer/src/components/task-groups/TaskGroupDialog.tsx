import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { useTaskGroupStore } from '@/stores/task-group-store'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus } from '@/types'

export function TaskGroupDialog({ groupId, onClose }: { groupId: string | null; onClose: () => void }) {
  const snapshot = useTaskGroupStore(state => groupId ? state.snapshots[groupId] : undefined)
  const error = useTaskGroupStore(state => groupId ? state.errors[groupId] : undefined)
  const busy = useTaskGroupStore(state => !!groupId && state.busy[groupId])
  const agents = useAgentStore(state => state.agents)
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [atSource, setAtSource] = useState(true)
  const [failures, setFailures] = useState<Array<{ task_id: string; message: string }>>([])
  const [feedback, setFeedback] = useState('')
  useEffect(() => { setSelected([]); setFailures([]); setFeedback(''); setMessage(''); setAtSource(true); return groupId ? useTaskGroupStore.getState().retainSnapshot(groupId) : undefined }, [groupId])
  const group = snapshot?.group
  const current = snapshot?.members.filter(task => group?.task_ids.includes(task.id)) ?? []
  const active = group?.state === 'active'
  const owned = !!group && ['triaging', 'agent_working', 'agent_learning'].includes(group.status)
  const reviewable = current.filter(task => task.status === TaskStatus.ReadyForReview)
  useEffect(() => {
    if (!snapshot) return
    setSelected(ids => {
      const retained = ids.filter(id => snapshot.group.state === 'active' && snapshot.group.task_ids.includes(id) && snapshot.members.some(task => task.id === id && task.status === TaskStatus.ReadyForReview))
      return retained.length === ids.length ? ids : retained
    })
  }, [snapshot])
  const review = async (action: 'approve' | 'send_back') => {
    if (!groupId || !selected.length) return
    setFailures([]); setFeedback('')
    try {
      const result = await useTaskGroupStore.getState().review({ group_id: groupId, task_ids: selected, action, message: message.trim() || undefined, complete_at_source: atSource })
      setFailures(result.failures)
      setFeedback(action === 'approve' ? `${result.completed_task_ids.length} ${result.completed_task_ids.length === 1 ? 'task approved' : 'tasks approved'}.` : result.failures.length ? 'Some tasks could not be sent back. Review the errors below.' : 'Selected tasks sent back.')
      // Failed source completions remain selected so they can be retried.
      if (action === 'approve') setSelected(ids => ids.filter(id => !result.completed_task_ids.includes(id)))
    } catch { /* The store exposes the service refusal and retains selection. */ }
  }
  return <Dialog open={!!groupId} onOpenChange={open => { if (!open) onClose() }}><DialogContent className="ui-scale flex h-[90vh] max-w-[1500px] flex-col overflow-hidden">
    <DialogHeader><DialogTitle>{group?.title ?? 'Task group'}</DialogTitle><DialogDescription>{active ? 'One shared agent session. Review and approve each task individually.' : 'Retained shared conversation and membership history.'}</DialogDescription></DialogHeader>
    {error && <p role="alert" className="mx-6 text-sm text-destructive">{error}</p>}
    {!snapshot ? <p className="p-6 text-sm">{error ? 'Could not load the group.' : 'Loading task group…'}<Button variant="ghost" onClick={() => { if (groupId) void useTaskGroupStore.getState().load(groupId) }}>Retry</Button></p> : <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 lg:flex-row">
      <aside className="max-h-[40%] w-full shrink-0 overflow-y-auto rounded-lg border border-border p-3 lg:max-h-none lg:w-80" aria-label="Group members and review">
        <h3 className="text-base font-semibold">{active ? `${current.length} tasks in this group` : 'Former members'}</h3>
        <p className="mt-2 text-sm text-muted-foreground">Agent progress is evidence for review. A finished progress report does not approve a task.</p>
        <ul className="mt-3 space-y-3">{snapshot.members.map(task => {
          const member = group!.task_ids.includes(task.id), progress = group!.progress.find(item => item.task_id === task.id)
          return <li key={task.id} className="rounded-lg border border-border p-2" data-testid={`group-review-member-${task.id}`}>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label={`Select ${task.title} for review`} disabled={!active || !member || task.status !== TaskStatus.ReadyForReview || busy} checked={selected.includes(task.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} /><span className="break-words font-medium">{task.title}</span></label>
            <p className="mt-1 text-xs text-muted-foreground">{task.status === TaskStatus.Completed ? 'Approved' : !active || !member ? 'Removed from group · history retained' : progress?.state === 'done' ? 'Agent finished · awaiting review' : progress?.state === 'blocked' ? 'Blocked' : progress?.state === 'working' ? 'Working' : 'Pending'}</p>
            {progress?.message && <p className="mt-1 break-words text-sm">{progress.message}</p>}
            <div className="mt-2 flex flex-wrap gap-3 text-xs"><button className="underline" onClick={() => { onClose(); useUIStore.getState().openDashboardPreview(task.id) }}>Open task details</button>{active && member && <button disabled={owned || busy} className="underline disabled:opacity-50" onClick={() => { void useTaskGroupStore.getState().remove(group!.id, task.id).catch(() => {}) }} aria-label={`Remove ${task.title} from group`}>Remove from group</button>}</div>
          </li>
        })}</ul>
        {active && <><Button className="mt-3" size="sm" variant="outline" disabled={!reviewable.length || busy} onClick={() => setSelected(reviewable.map(task => task.id))}>Select tasks ready for review</Button>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={atSource} onChange={event => setAtSource(event.target.checked)} />Complete at task sources</label>
          <label className="mt-3 block text-sm">Review feedback<textarea aria-label="Group review feedback" value={message} onChange={event => setMessage(event.target.value)} className="mt-1 min-h-16 w-full rounded-md border border-input bg-background p-2" /></label>
          <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={!selected.length || owned || busy} onClick={() => { void review('approve') }}>Approve selected</Button><Button size="sm" variant="outline" disabled={!selected.length || owned || busy} onClick={() => { void review('send_back') }}>Send selected back</Button></div>
          {feedback && <p className="mt-2 text-sm">{feedback}</p>}{failures.map(failure => <p role="alert" className="mt-2 text-sm text-destructive" key={failure.task_id}>{snapshot.members.find(task => task.id === failure.task_id)?.title ?? 'Task'}: {failure.message}</p>)}
          <Button className="mt-4" size="sm" variant="outline" disabled={owned || busy} onClick={() => { void useTaskGroupStore.getState().dissolve(group!.id).catch(() => {}) }}>Dissolve group</Button>
          {owned && <p className="mt-2 text-sm text-muted-foreground">Stop the shared session before changing membership or reviewing tasks.</p>}</>}
      </aside>
      <section className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border" aria-label="Shared group conversation">
        <TaskWorkspace task={snapshot.task} agents={agents} panelLayout="both" groupExecution={active ? 'active' : 'history'} onEdit={() => {}} onDelete={() => {}} onUpdateAttachments={() => {}} onUpdateOutputFields={() => {}} onCompleteTask={() => {}} onAssignAgent={() => {}} />
      </section>
    </div>}
  </DialogContent></Dialog>
}
