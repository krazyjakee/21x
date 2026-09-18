/**
 * Task-management MCP tool definitions and dispatch, with no transport and no
 * environment of its own.
 *
 * Two callers share this module:
 *   - the in-process HTTP endpoint on the Task API server, which calls
 *     handleRoute directly (no child process starts), and
 *   - the stdio entry point, kept for a direct `node task-management-mcp.js`
 *     run, which forwards over HTTP.
 *
 * The scope decides which tools exist and which tasks they reach:
 *   - subtask scope: the subtask set, reaching only its parent and siblings;
 *   - project scope: the full orchestration set, but every list is narrowed to
 *     one project and every call naming a task outside it is refused. Task
 *     agents and the Mastermind get this (see mcpOptionsForTask);
 *   - full access (no scope at all): every task in every project. Only
 *     internal and debug callers get it: a direct run of the stdio entry point
 *     without TASK_SCOPE_PROJECT_ID, or a session with no task row behind it.
 * Artifact calls are always pinned to one task, so an agent cannot change the
 * workpieces of another task.
 */
import {
  artifactToolNames,
  browserRecordingToolNames,
  browserTools,
  mastermindTools,
  sharedTools,
  subtaskTools
} from './task-management-tools'

/** Which task a session may act on. All fields null means full access. */
export type TaskMcpScope = {
  parentTaskId: string | null
  taskId: string | null
  /** Task that owns any artifact this session writes. */
  artifactTaskId: string | null
  /** The only project this session may see and act in (project scope). */
  projectId?: string | null
}

/** Calls one Task API route. In process this is handleRoute; over stdio it is fetch. */
export type TaskApiInvoke = (route: string, params: Record<string, unknown>) => Promise<unknown>

/** Result shape of an MCP tools/call. */
export type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** Internal and debug use only: see the module comment. */
export const FULL_ACCESS_SCOPE: TaskMcpScope = { parentTaskId: null, taskId: null, artifactTaskId: null, projectId: null }

/** A session is scoped only when it has both a parent and its own task. */
export function isScopedSession(scope: TaskMcpScope): boolean {
  return !!(scope.parentTaskId && scope.taskId)
}

/** A non-subtask session limited to one project. */
export function isProjectScopedSession(scope: TaskMcpScope): boolean {
  return !isScopedSession(scope) && !!scope.projectId
}

// ── Project-scoped dispatch ───────────────────────────────────

/** List and search tools: the project filter is forced onto their arguments. */
const PROJECT_FILTERED_TOOLS = new Set([
  'list_tasks',
  'find_similar_tasks',
  'get_task_statistics',
  'get_recent_activity',
  'list_pending_approvals',
  'list_repos',
  'create_task'
])

const PROJECT_ACCESS_DENIED = { error: 'Access denied: task is not in this project' }

/**
 * True when the task exists and belongs to the project. A task that does not
 * exist is refused the same way, so a session cannot probe other projects' ids.
 */
async function isTaskInProject(taskId: unknown, projectId: string, invoke: TaskApiInvoke): Promise<boolean> {
  if (typeof taskId !== 'string' || !taskId) return false
  const task = await invoke('/get_task', { task_id: taskId }) as Record<string, unknown> | null
  return !!task && !task.error && task.project_id === projectId
}

async function handleProjectCall(
  name: string,
  args: Record<string, unknown>,
  projectId: string,
  invoke: TaskApiInvoke
): Promise<unknown> {
  // Lists, searches and create_task: the scope's project wins over any argument.
  if (PROJECT_FILTERED_TOOLS.has(name)) args.project_id = projectId

  // Every task a call names, as its target or as a parent, must be in the
  // project. This covers each by-id tool (get_task, update_task, start_task,
  // send_message, stop_task, respond_to_checkpoint, get_messages, open_task,
  // the panel, artifact and browser tools) and the subtask tools, without a
  // list that a new tool could be forgotten from.
  for (const key of ['task_id', 'parent_task_id'] as const) {
    if (args[key] === undefined) continue
    if (!(await isTaskInProject(args[key], projectId, invoke))) return PROJECT_ACCESS_DENIED
  }
  if (Array.isArray(args.subtask_ids)) {
    for (const id of args.subtask_ids) {
      if (!(await isTaskInProject(id, projectId, invoke))) return PROJECT_ACCESS_DENIED
    }
  }
  if (Array.isArray(args.next_subtask_ids)) {
    for (const id of args.next_subtask_ids) {
      if (!(await isTaskInProject(id, projectId, invoke))) return PROJECT_ACCESS_DENIED
    }
  }
  return invoke(`/${name}`, args)
}

// ── Scoped dispatch (subtask mode) ────────────────────────────

const SIBLING_ACCESS_DENIED = { error: 'Access denied: task is not a sibling subtask' }

async function listSiblingIds(scope: TaskMcpScope, invoke: TaskApiInvoke): Promise<Set<unknown>> {
  const siblings = await invoke('/list_subtasks', { parent_task_id: scope.parentTaskId }) as Record<string, unknown>[]
  return new Set(Array.isArray(siblings) ? siblings.map((s) => s.id) : [])
}

/** Converts MCP-style attachments ({name, path, type}) to the FileAttachmentRecord shape. */
function normalizeAttachments(attachments: Record<string, unknown>[]): Record<string, unknown>[] {
  return attachments.map((a) => ({
    id: a.id || crypto.randomUUID(),
    filename: a.name || a.filename || 'unknown',
    size: typeof a.size === 'number' ? a.size : 0,
    mime_type: a.type || a.mime_type || 'application/octet-stream',
    added_at: a.added_at || new Date().toISOString()
  }))
}

async function handleScopedCall(
  name: string,
  args: Record<string, unknown>,
  scope: TaskMcpScope,
  invoke: TaskApiInvoke
): Promise<unknown> {
  switch (name) {
    case 'get_parent_task':
      return invoke('/get_task', { task_id: scope.parentTaskId })

    case 'get_own_task':
      return invoke('/get_task', { task_id: scope.taskId })

    case 'list_sibling_subtasks':
      return invoke('/list_subtasks', { parent_task_id: scope.parentTaskId })

    case 'get_sibling_task':
      if (!(await listSiblingIds(scope, invoke)).has(args.task_id)) return SIBLING_ACCESS_DENIED
      return invoke('/get_task', { task_id: args.task_id })

    case 'update_own_task': {
      // A scoped agent may finish its own task, but cannot cancel it.
      // Source-aware completion policy is enforced by the shared update route.
      if (args.status === 'cancelled') {
        return { error: 'Subtasks cannot set status to "cancelled".' }
      }
      if (args.status === 'in_progress') args.status = 'agent_working'
      if (Array.isArray(args.attachments)) {
        args.attachments = normalizeAttachments(args.attachments as Record<string, unknown>[])
      }
      return invoke('/update_task', { ...args, task_id: scope.taskId })
    }

    case 'update_sibling_task': {
      if (!(await listSiblingIds(scope, invoke)).has(args.task_id)) return SIBLING_ACCESS_DENIED
      // Siblings may only have their description and attachments changed.
      const allowed: Record<string, unknown> = { task_id: args.task_id }
      if (args.description !== undefined) allowed.description = args.description
      if (args.attachments !== undefined) {
        allowed.attachments = normalizeAttachments(args.attachments as Record<string, unknown>[])
      }
      return invoke('/update_task', allowed)
    }

    case 'create_sibling_subtask':
      return invoke('/create_subtask', { ...args, parent_task_id: scope.parentTaskId })

    case 'start_sibling_subtask':
      if (!(await listSiblingIds(scope, invoke)).has(args.task_id)) return SIBLING_ACCESS_DENIED
      return invoke('/start_task', { task_id: args.task_id, prefer_subtasks: false })

    case 'wait_for_sibling_subtasks': {
      if (Array.isArray(args.task_ids) && args.task_ids.length > 0) {
        const siblingIds = await listSiblingIds(scope, invoke)
        if ((args.task_ids as unknown[]).some((id) => !siblingIds.has(id))) {
          return { error: 'Access denied: one or more task_ids are not sibling subtasks' }
        }
      }
      return invoke('/wait_for_subtasks', {
        parent_task_id: scope.parentTaskId,
        subtask_ids: args.task_ids,
        timeout_ms: args.timeout_ms,
        return_when: args.return_when,
        terminal_statuses: args.terminal_statuses
      })
    }

    case 'get_sibling_transcript':
      if (!(await listSiblingIds(scope, invoke)).has(args.task_id)) return SIBLING_ACCESS_DENIED
      return invoke('/get_session_transcript', { task_id: args.task_id })

    default:
      return invoke(`/${name}`, args)
  }
}

/** The tools a session may see. This is the whole answer to "which tools to serve". */
export function listToolsForScope(scope: TaskMcpScope) {
  return isScopedSession(scope)
    ? [...subtaskTools, ...browserTools, ...sharedTools]
    : [...mastermindTools, ...browserTools, ...sharedTools]
}

/**
 * Runs one tool call for a scope.
 * Returns an MCP tools/call result, and never throws.
 */
export async function callToolForScope(
  name: string,
  args: Record<string, unknown> | undefined,
  scope: TaskMcpScope,
  invoke: TaskApiInvoke
): Promise<ToolCallResult> {
  try {
    // Serve only the tools this scope advertises.
    //
    // The scoped dispatch below ends in a pass-through for the shared tools. A
    // client that asked for a tool which is not in its list, for example
    // `update_task` instead of `update_own_task`, used to reach that
    // pass-through and act on any task at all. The tool list is the boundary, so
    // it must be enforced here and not only advertised.
    if (!listToolsForScope(scope).some((tool) => tool.name === name)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true
      }
    }

    const normalizedArgs: Record<string, unknown> = args ? { ...args } : {}
    if (normalizedArgs.status === 'in_progress') normalizedArgs.status = 'agent_working'
    if (artifactToolNames.has(name) && scope.artifactTaskId) normalizedArgs.task_id = scope.artifactTaskId
    if (browserRecordingToolNames.has(name) && (scope.taskId || scope.artifactTaskId)) {
      normalizedArgs.task_id = scope.taskId || scope.artifactTaskId
    }

    const result = isScopedSession(scope)
      ? await handleScopedCall(name, normalizedArgs, scope, invoke) as Record<string, unknown> | null
      : isProjectScopedSession(scope)
        ? await handleProjectCall(name, normalizedArgs, scope.projectId as string, invoke) as Record<string, unknown> | null
        : await invoke(`/${name}`, normalizedArgs) as Record<string, unknown> | null

    if (result?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (error: unknown) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
      isError: true
    }
  }
}
