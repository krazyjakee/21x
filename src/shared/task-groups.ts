/** Small work batches share one counted execution task and retain each source task. */
export const MAX_TASK_GROUP_SIZE = 10
export type TaskGroupProgressState = 'pending' | 'working' | 'done' | 'blocked'
export interface TaskGroupProgress {
  task_id: string
  state: TaskGroupProgressState
  message: string
  updated_at: string
}
export interface TaskGroupRecord {
  id: string
  title: string
  project_id: string
  agent_id: string
  execution_task_id: string
  state: 'active' | 'dissolved'
  /** Current lifecycle of the single execution task. */
  status: string
  task_ids: string[]
  former_task_ids: string[]
  progress: TaskGroupProgress[]
  created_at: string
  updated_at: string
}
export interface CreateTaskGroupData {
  title: string
  task_ids: string[]
  agent_id?: string
}
export interface TaskGroupReviewData {
  group_id: string
  /** Omit to review every unfinished member. */
  task_ids?: string[]
  action: 'approve' | 'send_back'
  message?: string
  /** Explicitly choose false to complete only inside the app. */
  complete_at_source?: boolean
}
export interface TaskGroupReviewResult {
  group: TaskGroupRecord
  completed_task_ids: string[]
  failures: Array<{ task_id: string; message: string }>
}
export interface TaskGroupSnapshot<TTask> {
  group: TaskGroupRecord
  task: TTask
  /** Includes former members for retained transcript history. */
  members: TTask[]
}
