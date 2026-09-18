/** A durable transcript part as persisted by main (`transcript_parts`). */
export interface TranscriptPartRecord {
  taskId: string
  partId: string
  seq: number
  role: string
  content: string
  partType?: string
  tool?: unknown
  payload?: unknown
  createdAt: number
  updatedAt: number
  /** Global monotonic change cursor for this row (delta subscriptions). */
  rev: number
}

export interface StepMeta {
  durationMs?: number
  tokens?: { input: number; output: number; cache: number }
}

interface TaskProgressData {
  taskId: string
  status: 'started' | 'running' | 'completed' | 'failed' | 'stopped'
  description: string
  lastToolName?: string
  summary?: string
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  partType?: string
  stepMeta?: StepMeta
  tool?: {
    name: string
    status: string
    title?: string
    description?: string
    input?: string
    output?: string
    error?: string
    requestId?: string
    questions?: Array<{
      header: string
      question: string
      options: Array<{ label: string; description: string }>
    }>
    todos?: Array<{
      id: string
      content: string
      status: 'pending' | 'in_progress' | 'completed'
      priority?: string
    }>
  }
  taskProgress?: TaskProgressData
}

export type AgentTodo = NonNullable<NonNullable<AgentMessage['tool']>['todos']>[number]
