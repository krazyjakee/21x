import { TaskStatus } from './constants'

interface SubtaskGraphNode {
  status: string
  next_subtask_ids?: string[] | null
}

/**
 * True when a parent's subtasks are sequenced by explicit successor edges
 * (`next_subtask_ids`) and the run has already begun.
 *
 * List order may still pick the first subtask. After that, a finished subtask
 * starts its selected successors (AgentManager.notifyParentOfSubtaskCompletion;
 * see {@link successorsFireOnReview} for when `ready_for_review` counts as
 * finished) and one with no successors hands the decision back to the parent
 * orchestrator — so nothing may start the next subtask by `sort_order`.
 */
export function isSuccessorGraphInProgress(subtasks: SubtaskGraphNode[]): boolean {
  return (
    subtasks.some((subtask) => (subtask.next_subtask_ids?.length ?? 0) > 0) &&
    subtasks.some((subtask) => subtask.status !== TaskStatus.NotStarted)
  )
}

/**
 * Statuses in which a subtask blocks the next sibling from starting: only a
 * genuinely running agent.
 *
 * `ready_for_review` does NOT block. The subtask's agent run is over, and a
 * subtask cannot set itself to `completed` (an agent never accepts its own
 * result), so blocking there would stall every unattended chain at its first
 * step. Acceptance still waits for a human; only ordering moves on.
 */
const SIBLING_BLOCKING_STATUSES: ReadonlySet<string> = new Set<string>([
  TaskStatus.AgentWorking,
  TaskStatus.Triaging,
  TaskStatus.AgentLearning
])

/**
 * "Is a sibling blocking?" — the single rule shared by the renderer auto-start
 * hook, TaskAutomationScheduler and AgentManager.startTask.
 */
export function isSiblingBlocking(subtask: { status: string }): boolean {
  return SIBLING_BLOCKING_STATUSES.has(subtask.status)
}

/** The first sibling that blocks the next subtask from starting, if any. */
export function findBlockingSibling<T extends { status: string }>(subtasks: readonly T[]): T | undefined {
  return subtasks.find(isSiblingBlocking)
}

interface SuccessorOptIn {
  auto_start_agent?: boolean | null
  auto_complete_without_review?: boolean | null
}

/**
 * Whether a subtask's successor edges (`next_subtask_ids`) fire as soon as it
 * reaches `ready_for_review`, instead of only once a human accepts it.
 *
 * Opt-in, reusing the existing unattended flags: the parent is set to run
 * unattended (`auto_start_agent` or `auto_complete_without_review`), or the
 * chain carries `auto_complete_without_review` (which `/create_subtask`
 * passes down to every child). The finished subtask stays in review — only
 * the chain advances; accepting the result is still a human's call.
 */
export function successorsFireOnReview(
  parent: SuccessorOptIn | null | undefined,
  subtask: SuccessorOptIn | null | undefined
): boolean {
  return !!(
    parent?.auto_start_agent ||
    parent?.auto_complete_without_review ||
    subtask?.auto_complete_without_review
  )
}
