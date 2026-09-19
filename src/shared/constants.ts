export enum SessionStatus {
  IDLE = 'idle',
  WORKING = 'working',
  ERROR = 'error',
  WAITING_APPROVAL = 'waiting_approval',
}

export enum TaskStatus {
  NotStarted = 'not_started',
  Triaging = 'triaging',
  AgentWorking = 'agent_working',
  ReadyForReview = 'ready_for_review',
  AgentLearning = 'agent_learning',
  Completed = 'completed'
}

export const TASK_STATUSES: { value: TaskStatus; label: string }[] = [
  { value: TaskStatus.NotStarted, label: 'Not Started' },
  { value: TaskStatus.Triaging, label: 'Triaging' },
  { value: TaskStatus.AgentWorking, label: 'Agent Working' },
  { value: TaskStatus.ReadyForReview, label: 'Ready for Review' },
  { value: TaskStatus.AgentLearning, label: 'Agent Learning' },
  { value: TaskStatus.Completed, label: 'Completed' }
]

/** Sort rank, higher = more urgent. */
export const PRIORITY_ORDER: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0
}

/** Sort rank, higher = more active. */
export const STATUS_ORDER: Record<TaskStatus, number> = {
  [TaskStatus.AgentWorking]: 5,
  [TaskStatus.AgentLearning]: 4,
  [TaskStatus.Triaging]: 3,
  [TaskStatus.ReadyForReview]: 2,
  [TaskStatus.NotStarted]: 1,
  [TaskStatus.Completed]: 0
}

// ── Plugin Action IDs ───────────────────────────────────────

/** Action IDs used across task source plugins */
export enum PluginActionId {
  // Common actions shared across multiple plugins
  Complete = 'complete',
  AddComment = 'add_comment',
  ChangeStatus = 'change_status',
  UpdatePriority = 'update_priority',
  // GitHub Issues
  CloseIssue = 'close_issue',
  ReopenIssue = 'reopen_issue',
  // YouTrack
  OpenInYouTrack = 'open_in_youtrack',
  ChangeState = 'change_state',
  // HubSpot
  AddNote = 'add_note'
}

// ── Heartbeat types ─────────────────────────────────────────

export enum HeartbeatStatus {
  Ok = 'ok',
  Info = 'info',
  AttentionNeeded = 'attention_needed',
  Error = 'error'
}

export const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK'
export const HEARTBEAT_INFO_TOKEN = 'HEARTBEAT_INFO'

export const HEARTBEAT_DEFAULTS = {
  intervalMinutes: 30,
  maxConsecutiveErrors: 3,
  checkIntervalMs: 60_000, // scheduler tick every 60s
} as const
