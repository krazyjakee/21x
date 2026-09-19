export type CaptainRuntimePhase =
  | 'starting_server'
  | 'starting_session'
  | 'verifying'
  | 'healthy'
  | 'unhealthy'
  | 'failed'
  | 'timed_out'
  | 'retrying'
  | 'recovering'
  | 'rolled_back'

export interface CaptainRuntimeState {
  ownerId: string
  projectId: string
  generation: number
  agentId: string
  candidateAgentId: string | null
  lastGoodAgentId: string | null
  sessionId: string | null
  phase: CaptainRuntimePhase
  deadlineAt: number | null
  lastProbeAt: number | null
  probeOk: boolean | null
  attemptCount: number
  errorCode: string | null
  errorDetail: string | null
  createdAt: number
  updatedAt: number
}

