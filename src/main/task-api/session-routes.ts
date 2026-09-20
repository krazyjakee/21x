/**
 * Reading and acting on live agent sessions. A task row cannot answer these:
 * `waiting_approval` is a session state and is never written to the task
 * record, so a task blocked on the user looks exactly like one that is running.
 */
import type { DatabaseManager } from '../database'
import type { TaskMcpScope } from '../mcp-servers/task-management-core'
import { authorizationRefusal, resolveTaskAuthorization } from '../authorization'
import { describeQueueReason } from '../project-limits'
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

/** The project a list route is narrowed to, when the caller is project-scoped. */
function projectOf(params: Record<string, unknown>): string | undefined {
  return typeof params.project_id === 'string' && params.project_id ? params.project_id : undefined
}

/** Message delivery may recover or create a stopped session, so task-scoped
 * callers must carry the same start capability as an explicit start call. */
function authorizeMessageRecovery(
  db: DatabaseManager,
  scope: TaskMcpScope | undefined,
  projectId: string
): Record<string, unknown> | null {
  const caller = scope?.taskId ?? scope?.artifactTaskId
  if (!caller) return null
  const decision = resolveTaskAuthorization(db, { taskId: caller, projectId, action: 'task.start' })
  return decision.allowed ? null : authorizationRefusal(decision)
}

export async function handleSessionRoute(db: DatabaseManager, route: string, params: Record<string, unknown>, trustedScope?: TaskMcpScope): Promise<unknown> {
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
      const recovery = agentController.getStartRecoveryState?.(taskId) ?? null
      return {
        task_id: taskId,
        title: task.title,
        // The stored status of the task, which survives a restart.
        task_status: task.status,
        // The live state of the agent session, which does not.
        session_status: live?.status ?? 'none',
        session_id: found?.sessionId ?? null,
        agent_id: task.agent_id,
        waiting_for_you: live?.status === 'waiting_approval',
        recovery
      }
    }

    case '/list_pending_approvals': {
      const agents = agentController
      if (!agents) return { error: 'Agent controller not available' }
      // A project-scoped session passes project_id (task-management-core.ts).
      const pending = db.getTasks({ projectId: projectOf(params) }).flatMap((task) => {
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
        .getTasks({ projectId: projectOf(params) })
        .filter((task) => Date.parse(task.updated_at) > since)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, limit)
        .map((task) => {
          const found = agentController?.findSessionByTaskId(task.id)
          const live = found ? agentController?.getSessionStatus(found.sessionId) : null
          const recovery = agentController?.getStartRecoveryState?.(task.id) ?? null
          return {
            task_id: task.id,
            title: task.title,
            status: task.status,
            session_status: live?.status ?? 'none',
            recovery_state: recovery?.state ?? null,
            recovery_cause: recovery?.recoveryCause ?? null,
            recovery_action: recovery?.recoveryAction ?? null,
            recovery_result: recovery?.recoveryResult ?? null,
            retry_count: recovery?.retryCount ?? 0,
            next_retry_at: recovery?.nextRetryAt ?? null,
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
      const startRefused = authorizeMessageRecovery(db, trustedScope, target.project_id)
      if (startRefused) return startRefused

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
      if (
        agentController.getActiveSessionsForTask(taskId).length === 0 &&
        !agentController.hasTaskStartOwnership(taskId)
      ) {
        return { success: false, task_id: taskId, reason: 'nothing_running' }
      }
      const result = await agentController.stopByTaskId(taskId)
      return {
        success: true,
        task_id: taskId,
        session_id: result.sessionId,
        ...(result.sessionId === null ? { cancelled_queued_start: true } : {})
      }
    }

    case '/start_task': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const taskId = String(params.task_id)
      const target = db.getTask(taskId)
      if (!target) return { error: 'Task not found' }
      if (trustedScope) {
        const projectId = target.project_id
        const caller = trustedScope.taskId ?? trustedScope.artifactTaskId ??
          db.getCoordinatorTask(projectId)?.id ?? null
        if (!caller) {
          return {
            error: 'The signed caller scope has no task authorization lineage.',
            code: 'capability_refused',
            requested_capability: 'task.start',
            missing_capability: 'task.start',
            origin_node_id: null,
            origin_message_id: null,
            effective_capabilities: [],
            failure_dimension: 'task',
            safe_remediation: 'Start this work from an authenticated human project instruction; machine recovery text cannot grant authority.'
          }
        }
        const decision = resolveTaskAuthorization(db, { taskId: caller, projectId, action: 'task.start' })
        if (!decision.allowed) return authorizationRefusal(decision)
      }
      const result = await agentController.startTask(taskId, {
        preferSubtasks: params.prefer_subtasks !== false,
        allowTriage: params.allow_triage !== false,
        resumeManualStop: true
      })
      const startedTask = result.startedTaskId ? db.getTask(result.startedTaskId) : null
      if (result.action === 'queued') {
        return {
          success: true,
          ...result,
          queue_position: result.queuePosition,
          // #65: project limits and pauses queue too; the reason says which.
          message: `Queued at position ${result.queuePosition}: ${describeQueueReason(result.queueReason ?? 'agent_limit')}`,
          task: startedTask
        }
      }
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
