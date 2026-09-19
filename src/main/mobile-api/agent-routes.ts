import type { DatabaseManager } from '../database'
import { HttpError } from '../http-utils'
import { MOBILE_VOICE_CAPABILITIES } from '../../shared/voice'
import { deps, type MobileRoute } from './state'

/** api_keys and secret_ids never leave the desktop. */
function stripSensitiveAgentFields(agent: ReturnType<DatabaseManager['getAgent']>) {
  if (!agent) return agent
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { api_keys: _keys, secret_ids: _secrets, ...safeConfig } = (agent.config || {}) as Record<string, unknown>
  return { ...agent, config: safeConfig }
}

function getActiveSessions(): Array<{ sessionId: string; agentId: string; taskId: string; status: string }> {
  const results: Array<{ sessionId: string; agentId: string; taskId: string; status: string }> = []
  for (const task of deps.db.getTasks()) {
    if (!task.session_id || !task.agent_id) continue
    const sessionStatus = deps.agentManager?.getSessionStatus(task.session_id)
    if (sessionStatus) {
      results.push({
        sessionId: task.session_id,
        agentId: sessionStatus.agentId,
        taskId: sessionStatus.taskId,
        status: sessionStatus.status
      })
    }
  }
  return results
}

export const agentRoutes: MobileRoute[] = [
  { method: 'GET', path: '/api/agents', handle: () => deps.db.getAgents().map(stripSensitiveAgentFields) },
  {
    method: 'GET',
    path: /^\/api\/agents\/([^/]+)$/,
    handle: ({ id }) => {
      const agent = deps.db.getAgent(id)
      if (!agent) throw new HttpError(404, 'Agent not found')
      return stripSensitiveAgentFields(agent)
    }
  },
  // Voice capture is desktop-only in phase 1, so mobile shows a clear note
  // instead of a button that cannot work (design §5.11).
  { method: 'GET', path: '/api/capabilities', handle: () => ({ voice: MOBILE_VOICE_CAPABILITIES }) },
  { method: 'GET', path: '/api/skills', handle: () => deps.db.getSkills() },
  { method: 'GET', path: '/api/sessions', handle: getActiveSessions },
  {
    method: 'POST',
    path: '/api/sessions/start',
    handle: async ({ params }) => {
      const agent = deps.agentManager
      const { agentId, taskId, skipInitialPrompt } = params as { agentId?: string; taskId: string; skipInitialPrompt?: boolean }
      if (!taskId) throw new HttpError(400, 'taskId is required')
      if (!agentId) {
        // No explicit agent: the same routing as the desktop's Start button and
        // the scheduler (next subtask, triage, the task's own agent), which is
        // admission-controlled too.
        if (!deps.db.getTask(taskId)) throw new HttpError(404, 'Task not found')
        const result = await agent.startTask(taskId)
        return {
          sessionId: result.sessionId ?? '',
          action: result.action,
          startedTaskId: result.startedTaskId,
          agentId: result.agentId,
          ...(result.action === 'queued'
            ? { queued: true, queuePosition: result.queuePosition, queueReason: result.queueReason }
            : {})
        }
      }
      // Admission-controlled: over a concurrency limit the start waits in the
      // main-process queue and starts on its own when a slot frees. This is the
      // path the desktop's agent:start IPC takes.
      const outcome = await agent.requestSession(agentId, taskId, undefined, skipInitialPrompt as boolean | undefined)
      if (outcome.status === 'queued') return { sessionId: '', queued: true, queuePosition: outcome.position, queueReason: outcome.reason }
      return { sessionId: outcome.sessionId }
    }
  },
  {
    method: 'POST',
    path: /^\/api\/sessions\/([^/]+)\/resume$/,
    handle: async ({ id: sessionId, params }) => {
      const { agentId, taskId } = params as { agentId: string; taskId: string }
      if (!agentId || !taskId) throw new HttpError(400, 'agentId and taskId are required')
      return { sessionId: await deps.agentManager.resumeSession(agentId, taskId, sessionId) }
    }
  },
  {
    method: 'POST',
    path: /^\/api\/sessions\/([^/]+)\/send$/,
    handle: async ({ id: sessionId, params }) => {
      const { message, taskId, agentId, attachments } = params as {
        message: string
        taskId?: string
        agentId?: string
        attachments?: Array<{ id: string; filename: string; size: number; mime_type: string }>
      }
      if (!message) throw new HttpError(400, 'message is required')
      const result = await deps.agentManager.sendMessage(sessionId, message, taskId, agentId, attachments)
      return { success: true, ...result }
    }
  },
  {
    method: 'POST',
    path: /^\/api\/sessions\/([^/]+)\/approve$/,
    handle: async ({ id: sessionId, params }) => {
      const { approved, message, responseType, requestId } = params as {
        approved: boolean
        message?: string
        responseType?: 'permission' | 'question'
        requestId?: string
      }
      if (typeof approved !== 'boolean') throw new HttpError(400, 'approved (boolean) is required')
      await deps.agentManager.respondToPermission(sessionId, approved, message, undefined, responseType, requestId)
      return { success: true }
    }
  },
  {
    // A status ping. The transcript is not replayed here; the client renders
    // the durable projection (GET /api/tasks/:taskId/transcript plus
    // `transcript:changed` deltas).
    method: 'POST',
    path: /^\/api\/sessions\/([^/]+)\/sync$/,
    handle: ({ id }) => {
      const status = deps.agentManager.getSessionStatus(id)
      if (!status) throw new HttpError(404, 'Session not found or not running')
      return { success: true, status: status.status }
    }
  },
  {
    method: 'POST',
    path: /^\/api\/sessions\/([^/]+)\/abort$/,
    handle: async ({ id }) => {
      await deps.agentManager.abortSession(id)
      return { success: true }
    }
  },
  {
    method: 'POST',
    path: /^\/api\/sessions\/([^/]+)\/stop$/,
    handle: async ({ id }) => {
      await deps.agentManager.stopSession(id)
      return { success: true }
    }
  }
]
