import { vi } from 'vitest'
import type { CommanderEvent } from '../../src/shared/commander'
import type { DatabaseManager } from '../../src/main/database'
import { CommanderService, type CommanderAgentsPort, type CommanderToolContext } from '../../src/main/commander/commander-service'
import { CommanderStore } from '../../src/main/commander/commander-store'
import { createCommanderProjectTools, ProjectMutationConfirmations, type CommanderAgents } from '../../src/main/commander/project-tools'
import { createCommanderSkillTools } from '../../src/main/commander/skill-tools'
import type { ChatToolDefinition } from '../../src/main/commander/tools'
import { createTestDb } from './db-test-helper'

/**
 * A CommanderService on a real test database, with AgentManager faked: the
 * agent sessions are a map the test drives, and "the user said X" is a user
 * part written to the session's transcript, exactly where AgentManager puts it.
 */
export function createCommanderHarness(options: { maxReportAsks?: number; getTools?: (context: CommanderToolContext) => ChatToolDefinition[] } = {}) {
  const { db } = createTestDb() as { db: DatabaseManager }
  const agent = db.createAgent({ name: 'Claude' })!
  const store = new CommanderStore(db)
  const events: CommanderEvent[] = []
  const listeners: Array<(channel: string, data: unknown) => void> = []
  const live = new Map<string, { sessionId: string; session: { agentId: string; status: string } }>()
  /** Messages sent to Commander sessions (report relays). */
  const sendMessage = vi.fn(async (_sessionId: string, _message: string, _taskId?: string, _agentId?: string) => ({}))
  const stopByTaskId = vi.fn(async () => ({ sessionId: undefined }))
  /** Messages sent to Captains by ask_captain. */
  const captainSend = vi.fn(async () => ({}))
  const agents: CommanderAgentsPort = {
    findSessionByTaskId: (taskId) => live.get(taskId),
    sendMessage,
    stopByTaskId,
    addExternalListener: (fn) => {
      listeners.push(fn)
    }
  }
  const projectAgents = {
    getStartQueue: () => [],
    findSessionByTaskId: () => undefined,
    getSessionStatus: () => null,
    getProjectLimitState: () => undefined,
    sendMessage: captainSend,
    pauseAllProjects: vi.fn(),
    isAllProjectsPaused: () => false
  } as unknown as CommanderAgents
  const confirmations = new ProjectMutationConfirmations()
  const service = new CommanderService({
    store,
    db,
    agents,
    emit: (event) => events.push(event),
    maxReportAsks: options.maxReportAsks,
    getTools: options.getTools ?? ((context) => [
      ...createCommanderProjectTools({ db, context, confirmations, agents: projectAgents }),
      ...createCommanderSkillTools({ db, context, confirmations })
    ])
  })

  let partSeq = 0
  const emitAgentEvent = (channel: string, data: unknown): void => {
    for (const fn of listeners) fn(channel, data)
  }

  /** Writes a user message to the session's transcript, as AgentManager does before prompting. */
  const say = (sessionId: string, text: string): void => {
    const part = { id: `user-message-${++partSeq}`, role: 'user', content: text, partType: 'text' }
    db.upsertTranscriptParts(sessionId, [part])
    emitAgentEvent('transcript:changed', { taskId: sessionId, parts: db.getTranscriptParts(sessionId).filter((p) => p.partId === part.id) })
  }

  /** Puts the session's agent in a status and announces it, like AgentManager.emitStatus. */
  const setStatus = (taskId: string, status: 'idle' | 'working'): void => {
    live.set(taskId, { sessionId: `agent-${taskId}`, session: { agentId: agent.id, status } })
    emitAgentEvent('agent:status', { sessionId: `agent-${taskId}`, taskId, status })
  }

  const call = (sessionId: string, name: string, input: Record<string, unknown> = {}) =>
    service.callTool(sessionId, name, input, `call-${++partSeq}`, new AbortController().signal)

  return { db, agent, store, service, events, sendMessage, stopByTaskId, captainSend, live, say, setStatus, call, emitAgentEvent }
}
