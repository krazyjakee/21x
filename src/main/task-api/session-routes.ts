/**
 * Reading and acting on live agent sessions. A task row cannot answer these:
 * `waiting_approval` is a session state and is never written to the task
 * record, so a task blocked on the user looks exactly like one that is running.
 */
import type { DatabaseManager } from '../database'
import { agentController, notifyRenderer, transcriptProvider } from './state'

function getMessages(db: DatabaseManager, params: Record<string, unknown>): unknown {
  if (!params.task_id) return { error: 'task_id is required' }
  const taskId = String(params.task_id)
  const limit = Math.min(Number(params.limit) || 20, 200)
  const includeTools = params.include_tools === true
  const role = params.role ? String(params.role) : null
  const before = params.before_seq !== undefined ? Number(params.before_seq) : null

  // Tool output is enormous and rarely what a question is about, so it is left
  // out unless asked for. This keeps a reply readable.
  const parts = db.getTranscriptParts(taskId).filter((part) =>
    (includeTools || ((part.role === 'user' || part.role === 'assistant') && (!part.partType || part.partType === 'text'))) &&
    (!role || part.role === role)
  )
  // Newest first, paging backwards with the cursor of the oldest row returned.
  // A sequence number stays correct while the agent keeps writing.
  parts.sort((a, b) => b.seq - a.seq)
  const start = before === null ? 0 : parts.findIndex((part) => part.seq < before)
  const page = start < 0 ? [] : parts.slice(start, start + limit)

  return {
    task_id: taskId,
    messages: page.map((part) => ({
      seq: part.seq,
      role: part.role,
      type: part.partType ?? 'text',
      content: part.content,
      created_at: new Date(part.createdAt).toISOString()
    })),
    next_before_seq: page.length === limit ? page[page.length - 1].seq : null,
    total_available: parts.length
  }
}

export async function handleSessionRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  switch (route) {
    case '/get_messages':
      return getMessages(db, params)

    case '/get_session_status': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const taskId = String(params.task_id)
      const task = db.getTask(taskId)
      if (!task) return { error: 'Task not found' }

      const found = agentController.findSessionByTaskId(taskId)
      const live = found ? agentController.getSessionStatus(found.sessionId) : null
      return {
        task_id: taskId,
        title: task.title,
        // The stored status of the task, which survives a restart.
        task_status: task.status,
        // The live state of the agent session, which does not.
        session_status: live?.status ?? 'none',
        session_id: found?.sessionId ?? null,
        agent_id: task.agent_id,
        waiting_for_you: live?.status === 'waiting_approval'
      }
    }

    case '/list_pending_approvals': {
      const agents = agentController
      if (!agents) return { error: 'Agent controller not available' }
      const pending = db.getTasks().flatMap((task) => {
        const found = agents.findSessionByTaskId(task.id)
        if (!found || agents.getSessionStatus(found.sessionId)?.status !== 'waiting_approval') return []
        return [{ task_id: task.id, title: task.title, session_id: found.sessionId, agent_id: task.agent_id }]
      })
      return { pending, count: pending.length }
    }

    case '/get_recent_activity': {
      const limit = Math.min(Number(params.limit) || 20, 100)
      const since = params.since ? Date.parse(String(params.since)) : 0
      const activity = db
        .getTasks()
        .filter((task) => Date.parse(task.updated_at) > since)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, limit)
        .map((task) => {
          const found = agentController?.findSessionByTaskId(task.id)
          const live = found ? agentController?.getSessionStatus(found.sessionId) : null
          return {
            task_id: task.id,
            title: task.title,
            status: task.status,
            session_status: live?.status ?? 'none',
            updated_at: task.updated_at
          }
        })
      return { activity, count: activity.length }
    }

    case '/send_message': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!params.text || !String(params.text).trim()) return { error: 'text is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const taskId = String(params.task_id)
      const target = db.getTask(taskId)
      if (!target) return { error: 'Task not found' }

      // Waking a stopped agent needs an agent to wake. Without one the send
      // fails deep inside with "Session not found:", which names neither the
      // cause nor the cure.
      if (!target.agent_id && !agentController.findSessionByTaskId(taskId)) {
        return {
          error: 'That task has no agent assigned, so there is nobody to send to. Assign one with update_task, or use start_task to triage it.',
          reason: 'no_agent'
        }
      }

      // Attributed to the user, because that is who spoke it.
      const result = await agentController.sendByTaskId(taskId, String(params.text))
      return { success: true, task_id: taskId, session_id: result.sessionId ?? result.newSessionId ?? null }
    }

    case '/respond_to_checkpoint': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (params.approved === undefined) return { error: 'approved is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const taskId = String(params.task_id)

      // Answer only a checkpoint that is really waiting, on the task named.
      // Without this a mis-heard word could answer an unrelated session, or a
      // session that has already moved on.
      const found = agentController.findSessionByTaskId(taskId)
      if (!found) return { error: 'No agent session for that task' }
      if (agentController.getSessionStatus(found.sessionId)?.status !== 'waiting_approval') {
        return { error: 'That task is not waiting for an answer' }
      }

      const approved = params.approved === true
      await agentController.respondToPermission(found.sessionId, approved, params.message ? String(params.message) : undefined)
      notifyRenderer?.('task:checkpointAnswered', { taskId, approved })
      return { success: true, task_id: taskId, approved }
    }

    case '/stop_task': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const taskId = String(params.task_id)
      if (agentController.getActiveSessionsForTask(taskId).length === 0) {
        return { success: false, task_id: taskId, reason: 'nothing_running' }
      }
      const result = await agentController.stopByTaskId(taskId)
      return { success: true, task_id: taskId, session_id: result.sessionId }
    }

    case '/start_task': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const result = await agentController.startTask(String(params.task_id), {
        preferSubtasks: params.prefer_subtasks !== false,
        allowTriage: params.allow_triage !== false
      })
      const startedTask = result.startedTaskId ? db.getTask(result.startedTaskId) : null
      return { success: result.action !== 'no_action', ...result, task: startedTask }
    }

    case '/get_session_transcript': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!transcriptProvider) return { error: 'Transcript provider not available' }
      try {
        return { task_id: params.task_id, messages: await transcriptProvider(params.task_id as string) }
      } catch (err) {
        return { error: `Failed to retrieve transcript: ${(err as Error).message}` }
      }
    }

    default:
      return undefined
  }
}
