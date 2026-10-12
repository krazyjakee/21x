/** Reviewed payloads emitted by agent-manager.ts and workspace-cleanup-scheduler.ts. */
export interface AgentOutputMessage {
  id: string
  role: string
  content: string
  partType?: string
  tool?: unknown
  update?: boolean
  taskProgress?: unknown
  receivedAt?: number
  questions?: unknown
  todos?: unknown
}
export interface AgentOutputEvent {
  sessionId: string
  taskId: string
  type: 'message'
  data: AgentOutputMessage
}
export interface AgentOutputBatchEvent {
  sessionId: string
  taskId: string
  messages: AgentOutputMessage[]
}
export interface AgentRecoveryStateChangedEvent {
  taskId: string
  cause: string
  action: string
  result: string
  error: string | null
}
export interface WorkspaceCleanupCompleteEvent { cleaned: number; errors: string[] }
export interface TaskCheckpointAnsweredEvent { taskId: string; approved: boolean }
export interface TaskSubtasksReorderedEvent { parentId: string; orderedIds: string[] }
