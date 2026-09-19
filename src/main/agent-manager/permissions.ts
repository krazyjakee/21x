import { TaskStatus } from '../../shared/constants'
import type { CodingAgentAdapter } from '../adapters/coding-agent-adapter'
import type { SessionPoller } from './polling'
import type { AgentSession, SessionHost } from './types'

type PermissionHost = Pick<SessionHost,
  'db' | 'buildSessionConfig' | 'emitStatus' | 'sendToRenderer' | 'updateTaskFromLocalAgent' | 'sendInBackground'>

export interface PermissionResponse {
  approved: boolean
  message?: string
  optionId?: string
  responseType?: 'permission' | 'question'
  requestId?: string
}

const APPROVAL_OPTION_BY_ANSWER: Record<string, string> = {
  'Always': 'approved-for-session',
  'Yes': 'approved',
  'No, provide feedback': 'abort',
  'No': 'abort'
}

/** Routes the user's answer to a question card or a permission card to the session's adapter. */
export async function respondToPermission(
  host: PermissionHost,
  poller: SessionPoller,
  sessionId: string,
  session: AgentSession,
  adapter: CodingAgentAdapter | null,
  response: PermissionResponse
): Promise<void> {
  // OpenCode implements both methods, so the renderer must mark a question
  // response or it would go to the permission endpoint.
  if (adapter?.respondToQuestion && (response.responseType === 'question' || !adapter.respondToApproval)) {
    await answerQuestion(host, poller, sessionId, session, adapter, response)
  } else if (adapter?.respondToApproval) {
    await answerApproval(host, sessionId, session, adapter, response)
  } else {
    console.warn(`[AgentManager] No adapter handler for permission response in session ${sessionId}`)
  }
}

async function answerQuestion(
  host: PermissionHost,
  poller: SessionPoller,
  sessionId: string,
  session: AgentSession,
  adapter: CodingAgentAdapter,
  { approved, message, requestId }: PermissionResponse
): Promise<void> {
  if (!approved) {
    console.log(`[AgentManager] Question rejected for session ${sessionId}`)
    session.status = 'idle'
    host.emitStatus(sessionId, session, 'idle')
    return
  }

  // The renderer sends "Header1: Answer1\nHeader2: Answer2" or a single answer.
  const answers: Record<string, string> = {}
  for (const line of message ? message.split('\n') : []) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) answers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
    else answers['answer'] = line.trim()
  }

  console.log(`[AgentManager] Responding to question via adapter for session ${sessionId}`)
  const config = await host.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
  const result = requestId
    ? await adapter.respondToQuestion!(sessionId, answers, config, requestId)
    : await adapter.respondToQuestion!(sessionId, answers, config)
  const handled = typeof result === 'object' ? result.handled : result
  if (handled === false) {
    console.log(`[AgentManager] Ignored stale question response for session ${sessionId}`)
    const part = typeof result === 'object' ? result.resolutionPart : undefined
    if (part) {
      host.sendToRenderer('agent:output', {
        sessionId,
        taskId: session.taskId,
        type: 'message',
        data: {
          id: part.id,
          role: part.role || 'assistant',
          content: part.content || part.text || '',
          partType: part.type,
          tool: part.tool,
          update: part.update,
        },
      })
    }
    return
  }

  session.status = 'working'
  if (host.db.getTask(session.taskId)?.status !== TaskStatus.AgentLearning) {
    host.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.AgentWorking })
  }
  host.emitStatus(sessionId, session, 'working')

  if (message) {
    host.sendToRenderer('agent:output', {
      sessionId,
      taskId: session.taskId,
      type: 'message',
      data: { id: `user-answer-${Date.now()}`, role: 'user', content: message, partType: 'text' }
    })
  }

  // The session may have gone idle before the answer arrived.
  if (!session.pollingStarted && session.adapter) {
    console.log(`[AgentManager] Restarting polling after question answer for session ${sessionId}`)
    session.pollingStarted = true
    poller.start(sessionId, session.adapter, config)
  }
}

async function answerApproval(
  host: PermissionHost,
  sessionId: string,
  session: AgentSession,
  adapter: CodingAgentAdapter,
  { approved, message, optionId, requestId }: PermissionResponse
): Promise<void> {
  const selectedOption = optionId || (message ? APPROVAL_OPTION_BY_ANSWER[message] || (approved ? 'approved' : 'abort') : undefined)
  console.log(`[AgentManager] Responding to adapter approval with: ${selectedOption}`)
  // Some adapters return false when no matching request exists; others return void.
  const handled = await adapter.respondToApproval!(sessionId, approved, selectedOption, requestId)
  if (handled !== false) return

  // Provider callbacks do not survive a restored session. Resolve the old card
  // instead of approving a newer request or sending a continuation into a
  // session that is already idle.
  if (requestId) {
    console.log(`[AgentManager] Ignored stale approval response for session ${sessionId}`)
    host.sendToRenderer('agent:output', {
      sessionId,
      taskId: session.taskId,
      type: 'message',
      data: {
        id: `question-${requestId}`,
        role: 'assistant',
        content: '',
        partType: 'question',
        tool: {
          name: 'permission',
          status: 'cancelled',
          requestId,
          output: 'This request expired when the session ended. Restart the turn to continue.'
        },
        update: true
      }
    })
    return
  }

  // No pending permission (stale prompt after a watchdog abort or app
  // restart): a continuation message lets the session recover.
  if (approved) {
    console.log(`[AgentManager] No pending permission found for ${sessionId}, sending continuation message to recover session`)
    host.sendInBackground(session, sessionId, 'continue')
  }
}
