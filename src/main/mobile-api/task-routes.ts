import type { CreateTaskData, UpdateTaskData } from '../database'
import { HttpError } from '../http-utils'
import { listTaskArtifactEntries, readTaskArtifact } from '../artifacts'
import type { Artifact, ArtifactFileEntry } from '../../shared/artifacts'
import { PRIORITY_ORDER, STATUS_ORDER, TaskStatus } from '../../shared/constants'
import { completeTaskAtSource, updateTaskFromUser } from '../session-feedback'
import { afterTaskCreated, afterTaskUpdated } from '../task-updates'
import { resolveDefaultProjectId } from './project-routes'
import { broadcastToMobileClients, deps, publish, type MobileRoute } from './state'

// A phone creates local tasks only: the source link (source_id, external_id,
// source) and recurrence-instance fields are owned by sync and the scheduler.
const CREATE_TASK_FIELDS = [
  'title', 'description', 'type', 'priority', 'status', 'assignee', 'due_date', 'labels', 'attachments',
  'repos', 'output_fields', 'is_recurring', 'recurrence_pattern', 'cron', 'auto_start_agent',
  'auto_complete_without_review', 'parent_task_id', 'project_id'
] as const satisfies ReadonlyArray<keyof CreateTaskData>

function pickCreateTaskFields(params: Record<string, unknown>): CreateTaskData {
  const data: Record<string, unknown> = {}
  for (const key of CREATE_TASK_FIELDS) {
    if (params[key] !== undefined) data[key] = params[key]
  }
  return data as unknown as CreateTaskData
}

const priorityRank = PRIORITY_ORDER as Record<string, number>
const statusRank = STATUS_ORDER as Record<string, number>

function listTasks(url: URL): unknown {
  const { db } = deps
  const projectId = url.searchParams.get('project_id')
  if (projectId && !db.getProject(projectId)) throw new HttpError(404, 'Project not found')
  let tasks = db.getTasks(projectId ? { projectId } : undefined)

  const status = url.searchParams.get('status')
  if (status) tasks = tasks.filter(t => t.status === status)

  const priority = url.searchParams.get('priority')
  if (priority) tasks = tasks.filter(t => t.priority === priority)

  const source = url.searchParams.get('source')
  if (source) tasks = tasks.filter(t => t.source === source)

  const search = url.searchParams.get('search')
  if (search) {
    const q = search.toLowerCase()
    tasks = tasks.filter(t =>
      t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    )
  }

  const sort = url.searchParams.get('sort') || 'created_at'
  const dir = url.searchParams.get('order') === 'asc' ? 1 : -1

  tasks.sort((a, b) => {
    const va = (a as unknown as Record<string, unknown>)[sort]
    const vb = (b as unknown as Record<string, unknown>)[sort]
    if (va == null && vb == null) return 0
    if (va == null) return dir
    if (vb == null) return -dir
    // Semantic ordering for priority and status instead of alphabetical.
    if (sort === 'priority') return ((priorityRank[va as string] ?? 0) - (priorityRank[vb as string] ?? 0)) * dir
    if (sort === 'status') return ((statusRank[va as string] ?? 0) - (statusRank[vb as string] ?? 0)) * dir
    if (va < vb) return -dir
    if (va > vb) return dir
    return 0
  })

  return tasks
}

function artifactFromFileEntry(taskId: string, entry: ArtifactFileEntry): Artifact {
  return {
    id: entry.workpieceKey
      ? `${taskId}:workpiece:${encodeURIComponent(entry.workpieceKey)}`
      : `${taskId}:${entry.type}:${encodeURIComponent(entry.path)}`,
    taskId,
    type: entry.type,
    title: entry.title,
    path: entry.path,
    workpieceKey: entry.workpieceKey,
    files: entry.files,
    updatedAt: entry.updatedAt,
    reloadTrigger: Math.floor(entry.updatedAt)
  }
}

function existingTaskId(encodedId: string): string {
  const taskId = decodeURIComponent(encodedId)
  if (!deps.db.getTask(taskId)) throw new HttpError(404, 'Task not found')
  return taskId
}

async function completeTask(taskId: string, params: Record<string, unknown>): Promise<unknown> {
  const { db, agentManager, syncManager } = deps
  const task = db.getTask(taskId)
  if (!task) throw new HttpError(404, 'Task not found')
  const completeAtSource = (params as { completeAtSource?: boolean }).completeAtSource !== false
  // A second explicit completion while feedback learning is pending cancels
  // that learning cycle first. Without clearing its durable marker, the
  // database protects AgentLearning and silently preserves the old status.
  if (task.status === TaskStatus.AgentLearning) {
    updateTaskFromUser(db, taskId, { status: TaskStatus.ReadyForReview })
  }
  // Source-less tasks are local 20x records. Only sourced tasks delegate
  // completion to their external authority.
  if (!task.source_id || !completeAtSource) {
    const data: UpdateTaskData = { status: TaskStatus.Completed, ...(task.source_id ? { complete_at_source: false } : {}) }
    const fresh = db.updateTask(taskId, data)
    if (fresh) {
      publish('task:updated', { taskId, updates: fresh })
      afterTaskUpdated(db, agentManager, task, data, fresh)
    }
    return { completed: true, status: fresh?.status }
  }
  if (!syncManager) throw new HttpError(409, 'Task source is unavailable.')
  db.updateTask(taskId, { complete_at_source: true })
  try {
    await completeTaskAtSource(syncManager, task)
  } catch (err) {
    throw Object.assign(err as Error, { status: 409 })
  }
  const fresh = db.getTask(taskId)
  if (fresh) broadcastToMobileClients('task:updated', { taskId, updates: fresh })
  return { completed: true, status: fresh?.status }
}

export const taskRoutes: MobileRoute[] = [
  { method: 'GET', path: '/api/tasks', handle: ({ url }) => listTasks(url) },
  {
    // Mobile is a PURE READER of the transcript projection: read straight from
    // the DB, never via AgentManager.getTranscriptSnapshot (which can trigger
    // the one-time backfill/ingest). A mobile client connecting must not mutate
    // the projection or broadcast deltas to other clients. The desktop (session
    // owner) owns the one-time seed of pre-store sessions.
    method: 'GET',
    path: /^\/api\/tasks\/([^/]+)\/transcript$/,
    handle: ({ id }) => deps.db.getTranscriptParts(decodeURIComponent(id))
  },
  {
    // Parts changed since `sinceRev`. A pure DB read, as above.
    method: 'GET',
    path: /^\/api\/tasks\/([^/]+)\/transcript\/delta$/,
    handle: ({ id, url }) => {
      const sinceRev = Number(url.searchParams.get('sinceRev') || '0') || 0
      return deps.db.getTranscriptDelta(decodeURIComponent(id), sinceRev)
    }
  },
  {
    // readTaskArtifact confines the read to this task's workspace.
    method: 'GET',
    path: /^\/api\/tasks\/([^/]+)\/artifacts\/content$/,
    handle: async ({ id, url }) => {
      const taskId = existingTaskId(id)
      const artifactPath = url.searchParams.get('path')
      if (!artifactPath) throw new HttpError(400, 'path is required')
      const content = await readTaskArtifact(deps.db.getWorkspaceDir(taskId), artifactPath)
      if (!content) throw new HttpError(404, 'Artifact not found or cannot be previewed')
      return content
    }
  },
  {
    // The explicit workpiece registry plus the bounded legacy import/recovery scan.
    method: 'GET',
    path: /^\/api\/tasks\/([^/]+)\/artifacts$/,
    handle: async ({ id }) => {
      const taskId = existingTaskId(id)
      const entries = await listTaskArtifactEntries(deps.db.getWorkspaceDir(taskId), taskId)
      return entries.map((entry) => artifactFromFileEntry(taskId, entry))
    }
  },
  {
    method: 'GET',
    path: /^\/api\/tasks\/([^/]+)$/,
    handle: ({ id }) => {
      const task = deps.db.getTask(id)
      if (!task) throw new HttpError(404, 'Task not found')
      return task
    }
  },
  {
    method: 'POST',
    path: '/api/tasks/reorder-subtasks',
    handle: ({ params }) => {
      const { parentId, orderedIds } = params as { parentId?: string; orderedIds?: string[] }
      if (!parentId || !Array.isArray(orderedIds)) throw new HttpError(400, 'parentId and orderedIds are required')
      deps.db.reorderSubtasks(parentId, orderedIds)
      publish('task:subtasks-reordered', { parentId, orderedIds })
      return { success: true }
    }
  },
  {
    method: 'POST',
    path: '/api/tasks',
    handle: ({ params }) => {
      const { db } = deps
      if (!params.title) throw new HttpError(400, 'title is required')
      const data = pickCreateTaskFields(params)
      if (data.project_id !== undefined && data.project_id !== null) {
        const project = typeof data.project_id === 'string' ? db.getProject(data.project_id) : undefined
        if (!project || project.archived) throw new HttpError(400, 'project_id must name an active project')
      } else if (!data.parent_task_id) {
        // A subtask always joins its parent's project (DatabaseManager decides);
        // anything else lands in the desktop's current project.
        data.project_id = resolveDefaultProjectId(db)
      }
      const created = db.createTask(data)
      if (!created) throw new HttpError(500, 'Failed to create task')
      afterTaskCreated(created)
      const task = db.getTask(created.id) ?? created
      publish('task:created', { task })
      return task
    }
  },
  {
    method: 'POST',
    path: /^\/api\/tasks\/([^/]+)\/complete$/,
    handle: ({ id, params }) => completeTask(id, params)
  },
  {
    method: 'POST',
    path: /^\/api\/tasks\/([^/]+)$/,
    handle: ({ id: taskId, params }) => {
      const { db, agentManager } = deps
      const existing = db.getTask(taskId)
      if (!existing) throw new HttpError(404, 'Task not found')
      const data = params as UpdateTaskData
      const updated = updateTaskFromUser(db, taskId, data)
      if (updated) {
        publish('task:updated', { taskId, updates: updated })
        afterTaskUpdated(db, agentManager, existing, data, updated)
      }
      return updated
    }
  }
]
