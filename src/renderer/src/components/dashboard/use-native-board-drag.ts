import { useEffect, useRef, useState } from 'react'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { taskGroupsApi } from '@/lib/ipc-client'
import { useTaskEditReceipt } from '@/hooks/use-task-edit-receipt'
import { useProjectStore } from '@/stores/project-store'
import { useTaskStore } from '@/stores/task-store'
import { useTaskGroupStore } from '@/stores/task-group-store'
import { TaskStatus, type Task } from '@/types'
import type { TaskGroupRecord } from '@shared/task-groups'
import type { TaskBoardTransitionContext, TaskBoardTransitionResult } from './task-board-transition'

const destinations = new Set([TaskStatus.NotStarted, TaskStatus.Triaging, TaskStatus.AgentWorking, TaskStatus.ReadyForReview, TaskStatus.Completed])
const taskAuthority = (task: Task) => [task.id, task.project_id, task.role ?? 'task', task.agent_id, task.parent_task_id, task.group_id, task.source_id, task.external_id, task.source, task.output_fields]
interface Gesture {
  id: string
  task?: Task
  group?: TaskGroupRecord
  before: string
  authority: string
  effectStarted: boolean
  submitted: boolean
  invalid: boolean
}
interface Options {
  projectId: string
  tasks: Task[]
  groups: TaskGroupRecord[]
  onStatusChange?: (task: Task, status: TaskStatus, context?: TaskBoardTransitionContext) => void | TaskBoardTransitionResult | Promise<void | TaskBoardTransitionResult>
  setDragged: (id: string | null) => void
  setPhase: (id: string, phase?: 'starting' | 'queued' | 'failed') => void
}
function binding(gesture: Gesture, projectId: string, full = false): string {
  if (gesture.task) {
    const task = useTaskStore.getState().tasks.find(row => row.id === gesture.task!.id)
    return task ? JSON.stringify(full ? task : taskAuthority(task)) : ''
  }
  const group = useTaskGroupStore.getState().projects[projectId]?.find(row => row.id === gesture.group!.id)
  if (!group) return ''
  const members = group.task_ids.map(id => useTaskStore.getState().tasks.find(row => row.id === id))
  if (members.some(row => !row || row.project_id !== projectId)) return ''
  return JSON.stringify(full ? [group, members] : [group.id, group.project_id, group.agent_id, group.execution_task_id, group.state, group.task_ids, group.former_task_ids, members.map(row => taskAuthority(row!))])
}


/** One physical board gesture owns one existing Source operation. */
export function useNativeBoardDrag(options: Options) {
  const native = getDesktopHost().kind === 'tauri'
  const receipt = useTaskEditReceipt(`board:${options.projectId}`)
  const owner = useRef<Gesture | null>(null)
  const [rendered, setRendered] = useState<Gesture | null>(null)
  useEffect(() => {
    if (!native) return undefined
    const scope = captureDesktopRead(), host = getDesktopHost()
    let live = true, offTask = () => {}, offGroup = () => {}, offProject = () => {}, offConnection = () => {}
    const retire = () => {
      if (!live) return
      live = false
      if (owner.current) owner.current.invalid = true
      offTask(); offGroup(); offProject(); offConnection(); window.removeEventListener('pagehide', retire)
    }
    const observe = () => {
      const gesture = owner.current
      if (gesture && binding(gesture, options.projectId, !gesture.effectStarted) !== (gesture.effectStarted ? gesture.authority : gesture.before)) gesture.invalid = true
    }
    offTask = useTaskStore.subscribe(observe); offGroup = useTaskGroupStore.subscribe(observe)
    offProject = useProjectStore.subscribe((state, previous) => { if (state.currentProjectId !== previous.currentProjectId) retire() })
    offConnection = host.subscribeConnection(() => { if (!scope.isCurrent()) retire() })
    window.addEventListener('pagehide', retire)
    return retire
  }, [native, options.projectId])
  const start = (event: DragStartEvent) => {
    if (!receipt.admit()) return
    const id = String(event.active.id), groupId = event.active.data.current?.groupId
    const task = !groupId ? options.tasks.find(row => row.id === id && row.project_id === options.projectId && (!row.role || row.role === 'task')) : undefined
    const group = typeof groupId === 'string' && id === `group:${groupId}` ? options.groups.find(row => row.id === groupId && row.project_id === options.projectId && row.state === 'active') : undefined
    if (!task && !group) return
    const json = JSON.stringify(task ?? group)
    if (new TextEncoder().encode(json).byteLength > 262_144) return
    const gesture: Gesture = { id, ...(task ? { task: JSON.parse(json) as Task } : { group: JSON.parse(json) as TaskGroupRecord }), before: '', authority: '', effectStarted: false, submitted: false, invalid: false }
    gesture.before = binding(gesture, options.projectId, true); gesture.authority = binding(gesture, options.projectId)
    if (!gesture.before || !gesture.authority || (task && gesture.before !== json) || new TextEncoder().encode(gesture.before + gesture.authority).byteLength > 524_288) return
    owner.current = gesture; setRendered(gesture); options.setDragged(id)
  }
  const end = async (event: DragEndEvent) => {
    const gesture = rendered
    if (!gesture || owner.current !== gesture || gesture.submitted || !receipt.admit()) return
    gesture.submitted = true; setRendered(null); options.setDragged(null)
    const status = event.over?.data.current?.status as TaskStatus | undefined
    if (!event.over) { owner.current = null; return }
    const context: TaskBoardTransitionContext = { assertCurrent() {
      if (!receipt.current() || owner.current !== gesture || gesture.invalid || binding(gesture, options.projectId) !== gesture.authority) throw new Error('Review the current board before another action.')
    }, beforeEffect() {
      this.assertCurrent()
      if (!gesture.effectStarted && binding(gesture, options.projectId, true) !== gesture.before) throw new Error('The original board intent changed.')
      gesture.effectStarted = true
    } }
    try {
      await receipt.perform(async () => {
        context.assertCurrent()
        if (String(event.active.id) !== gesture.id || !status || !destinations.has(status) || binding(gesture, options.projectId, true) !== gesture.before) throw new Error('The original board gesture is unavailable.')
        if ((event.active.data.current?.groupId ?? undefined) !== gesture.group?.id) throw new Error('The original board group is unavailable.')
        if (status === (gesture.task ?? gesture.group)!.status) return
        if (gesture.group) {
          if (status === TaskStatus.Triaging) throw new Error('Group triage is unavailable.')
          context.beforeEffect?.()
          const accepted = await taskGroupsApi.move(gesture.group.id, status)
          context.assertCurrent()
          if (accepted.id !== gesture.group.id || accepted.project_id !== gesture.group.project_id || accepted.execution_task_id !== gesture.group.execution_task_id || accepted.agent_id !== gesture.group.agent_id || JSON.stringify(accepted.task_ids) !== JSON.stringify(gesture.group.task_ids)) throw new Error('The group transition was not confirmed.')
          // Canonical task/group events own the columns; only current views read back.
          await useTaskGroupStore.getState().fetch(options.projectId)
          return
        }
        if (!options.onStatusChange) throw new Error('Task transitions are unavailable in this view.')
        if (status === TaskStatus.AgentWorking || status === TaskStatus.Triaging) options.setPhase(gesture.task!.id, 'starting')
        const result = await options.onStatusChange(gesture.task!, status, context)
        context.assertCurrent()
        if (result && (result.phase === 'queued')) options.setPhase(gesture.task!.id, 'queued')
        else options.setPhase(gesture.task!.id)
      })
    } catch {
      if (receipt.retained() && gesture.task) options.setPhase(gesture.task.id, 'failed')
    }
  }
  const cancel = () => {
    if (rendered && owner.current === rendered && !rendered.submitted) { owner.current = null; setRendered(null); options.setDragged(null) }
  }
  return { start, end, cancel, review: native && receipt.review }
}
