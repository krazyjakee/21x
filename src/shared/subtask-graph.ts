import { TaskStatus } from './constants'

interface SubtaskGraphNode {
  status: string
  next_subtask_ids?: string[] | null
}

/**
 * True when a parent's subtasks are sequenced by explicit successor edges
 * (`next_subtask_ids`) and the run has already begun.
 *
 * List order may still pick the first subtask. After that, a completed subtask
 * starts its selected successors (AgentManager.notifyParentOfSubtaskCompletion)
 * and one with no successors hands the decision back to the parent
 * orchestrator — so nothing may start the next subtask by `sort_order`.
 */
export function isSuccessorGraphInProgress(subtasks: SubtaskGraphNode[]): boolean {
  return (
    subtasks.some((subtask) => (subtask.next_subtask_ids?.length ?? 0) > 0) &&
    subtasks.some((subtask) => subtask.status !== TaskStatus.NotStarted)
  )
}
