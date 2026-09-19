import type { DatabaseManager, TaskRecord } from '../database'
import type { SyncManager } from '../sync-manager'
import type { CodingAgentAdapter, SessionConfig } from '../adapters/coding-agent-adapter'
import type { MessageAttachmentRef } from './attachments'
import type { AdmissionReason } from './admission'
import type { SkillSyncResult } from './skills-sync'
import type { StartTaskResult } from './task-orchestration'

export type SessionStartOutcome =
  | { status: 'started'; sessionId: string }
  | { status: 'queued'; position: number; reason: AdmissionReason }

type AgentSessionStatus = 'idle' | 'working' | 'error' | 'waiting_approval'

interface TodoItem {
  content: string
  status: string
}

export interface AgentSession {
  id: string
  agentId: string
  taskId: string
  workspaceDir?: string
  status: AgentSessionStatus
  createdAt: Date
  seenMessageIds: Set<string>
  seenPartIds: Set<string>
  partContentLengths: Map<string, string>
  assistantTextKeys?: Set<string>
  isTriageSession?: boolean
  lastAssistantText?: string
  /** Latest todo list captured from todowrite tool calls during polling. */
  todos?: TodoItem[]
  adapter?: CodingAgentAdapter
  secretSessionToken?: string
  pollingStarted?: boolean
  /** True after an auto-abort notice has been shown for the current prompt.
   *  Reset when the user sends a new prompt or the adapter emits fresh output. */
  autoAbortNotified?: boolean
  /** Last observed activity; the inactivity reaper releases the runtime of a
   *  session idle for long enough. A released session stays resumable from the
   *  persisted session_id, so nothing is lost. */
  lastActivityAt?: number
  /** Ordered automatic handoff candidates still available for this task run. */
  fallbackAgentIds: string[]
  /** Prevents fallback cycles such as Claude -> Codex -> Claude. */
  attemptedAgentIds: Set<string>
  fallbackInProgress?: boolean
}

export interface AgentFallbackState {
  remainingAgentIds: string[]
  attemptedAgentIds: Set<string>
}

/** A session registered with the polling coordinator for the current prompt. */
export interface PollingEntry {
  sessionId: string
  adapter: CodingAgentAdapter
  config: SessionConfig
  seenMessageIds: Set<string>
  seenPartIds: Set<string>
  partContentLengths: Map<string, string>
  assistantTextKeys?: Set<string>
  /** Start of this polling cycle; drives the IDLE grace period. */
  createdAt: number
  /** True once a non-IDLE status was seen in this cycle. */
  hasSeenWork?: boolean
  /** Last time data arrived; drives the post-data grace period and the watchdog. */
  lastPartReceivedAt?: number
  /** The adapter buffered data after this entry's last pollMessages() call.
   *  That data is still behind the adapter's cursor, so the session must NOT
   *  be unregistered yet, and a nudged cycle polls exactly these entries. */
  dataArrivedSincePoll?: boolean
  /** tillDone nudges sent this cycle, capped to prevent infinite nudge loops. */
  tillDoneNudgeCount?: number
  /** Set once a watchdog fired this cycle, so the abort notice does not repeat
   *  every tick while the backend moves from BUSY to IDLE. */
  watchdogFired?: boolean
  /** Consecutive poll cycles with garbled model output (hallucinated
   *  tool-call markup as plain text); past a threshold the session is aborted. */
  garbledOutputCount?: number
}

/**
 * What AgentManager's helper modules call back into. Each module picks the
 * members it needs.
 */
export interface SessionHost {
  db: DatabaseManager
  sessions: Map<string, AgentSession>
  resolveSession(sessionId: string, caller?: string): { sessionId: string; session: AgentSession } | undefined
  findSessionByTaskId(taskId: string): { sessionId: string; session: AgentSession } | undefined
  hasActiveSessionForTask(taskId: string): boolean
  /** Moves a session to the real id its adapter reported. */
  rekeySession(oldId: string, newId: string, taskId: string): void
  sessionConfigFor(session: AgentSession): SessionConfig
  buildSessionConfig(agentId: string, taskId: string, workspaceDir?: string): Promise<SessionConfig>
  emitStatus(sessionId: string, owner: { agentId: string; taskId: string }, status: AgentSessionStatus): void
  emitSystemError(sessionId: string, taskId: string, id: string, content: string): void
  sendToRenderer(channel: string, data: unknown): void
  updateTaskFromLocalAgent(taskId: string, updates: Parameters<DatabaseManager['updateTask']>[1]): TaskRecord | undefined
  hasActiveSubtaskWork(taskId: string): boolean
  tryAutomaticFallback(sessionId: string, session: AgentSession, exhaustionMessage: string): Promise<boolean>
  transitionToIdle(sessionId: string, session: AgentSession): Promise<void>
  sendAdapterMessage(session: AgentSession, sessionId: string, message: string): Promise<void>
  sendInBackground(session: AgentSession, sessionId: string, message: string, attachments?: MessageAttachmentRef[]): void
  sendMessage(sessionId: string, message: string, taskId?: string, agentId?: string): Promise<{ newSessionId?: string }>
  sendByTaskId(taskId: string, message: string): Promise<{ sessionId: string | null; newSessionId?: string }>
  startSessionNow(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string>
  startSession(agentId: string, taskId: string): Promise<string>
  requestSession(agentId: string, taskId: string): Promise<SessionStartOutcome>
  startTask(taskId: string, opts?: { preferSubtasks?: boolean; allowTriage?: boolean }): Promise<StartTaskResult>
  stopSession(sessionId: string, resetTaskStatus?: boolean): Promise<void>
  /** Releases the backend session without touching task status or clients. */
  releaseAdapterSession(sessionId: string, reason: string): Promise<void>
  notifyParentOfSubtaskCompletion(parentTaskId: string, subtaskId: string): Promise<void>
  syncSkillsFromWorkspace(sessionId: string): SkillSyncResult
  getSyncManager(): SyncManager | undefined
  defaultAgentId(): string | undefined
  scheduleStartQueueDrain(): void
  schedulePowerSaveBlockerUpdate(): void
}
