/**
 * Reading and driving the window. Each command validates its premise here and
 * then pushes one command. Nothing is invented: when no window has published
 * a screen, the call fails rather than reporting an action that reached nobody.
 */
import type { DatabaseManager } from '../database'
import {
  UI_CANVAS_MAX_ZOOM,
  UI_CANVAS_MIN_ZOOM,
  UI_COMMAND_CHANNEL,
  isUiCanvasViewMode,
  isUiOpenTaskTarget,
  isUiViewName,
  type UiCommand,
  type UiOpenTaskTarget
} from '../../shared/ui-commands'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'
import { listRegisteredTaskArtifacts } from '../artifacts'
import { notifyRenderer, uiState, taskApiUiOwner, assertTaskApiUiOwner } from './state'
import { isDatabaseId } from '../../shared/database-desktop-codecs'
import type { ProductionUiOwner } from '../production-ui-owner'
import type { TaskMcpScope } from '../mcp-servers/task-management-core'
import { ServiceProtocolError } from '../../shared/service-protocol'

/** The canvas panels the window last published, or none when it published none. */
function readCanvasPanels(state: Record<string, unknown>): Array<{ taskId: string | null }> {
  const canvas = state.canvas as { panels?: Array<{ taskId: string | null }> } | undefined
  return Array.isArray(canvas?.panels) ? canvas.panels : []
}

/**
 * Where "open this task" should send the user when the caller did not say.
 * It follows the screen: the canvas stays on the canvas, the dashboard gets
 * the dialog that keeps the user there, anything else the full task view.
 */
function resolveOpenTaskTarget(state: Record<string, unknown>): 'workspace' | 'canvas' | 'modal' {
  const view = typeof state.view === 'string' ? state.view : null
  if (view === 'canvas') return 'canvas'
  if (view === 'dashboard') return 'modal'
  return 'workspace'
}

/**
 * Refuses when that task has no panel, so a move cannot silently do nothing.
 *
 * The window publishes only the current project's canvas. A task from another
 * project cannot be checked here: the renderer switches to that project and
 * acts on its canvas, so the command is passed through.
 */
function requireCanvasPanel(db: DatabaseManager, taskId: string, state: Record<string, unknown>): { error: string } | null {
  if (readCanvasPanels(state).some((panel) => panel.taskId === taskId)) return null
  const task = readUiTask(db, taskId)
  const shownProject = typeof state.projectId === 'string' ? state.projectId : null
  if (task && shownProject && (task.project_id ?? DEFAULT_PROJECT_ID) !== shownProject) return null
  return { error: 'That task has no panel on the canvas. Open it there first.' }
}

/**
 * A command that reaches no window is a failure, not a success: an agent that
 * is told "done" would go on to describe a screen the user never saw.
 */
async function sendUiCommand(command: UiCommand, owner: ProductionUiOwner | null, leaseId?: string, beforeEffect?: (command: UiCommand) => void): Promise<{ success: true; command: string; accepted?: true } | { error: string }> {
  if (taskApiUiOwner !== owner) return { error: 'The window owner changed' }
  if (owner) {
    try { return await owner.send(command, { beforeEffect: () => { assertTaskApiUiOwner(owner); beforeEffect?.(command) }, signal: new AbortController().signal }, leaseId) }
    catch { return { error: 'The window command could not be acknowledged' } }
  }
  if (!uiState.available) return { error: 'No 21x window is open' }
  if (!notifyRenderer) return { error: 'The window cannot be reached' }
  notifyRenderer(UI_COMMAND_CHANNEL, command)
  return { success: true, command: command.kind }
}

/** The transport supplies this signed scope out of band. Never read a scope
 * from model-controlled route params; full internal scope retains its defaults. */
function assertUiApiScope(db: DatabaseManager, scope: TaskMcpScope | undefined, state?: Record<string, unknown>, command?: UiCommand): void {
  if (!scope || !scope.projectId && !scope.taskId && !scope.parentTaskId && !scope.artifactTaskId) return
  const read = (id: string) => {
    if (!isDatabaseId(id)) throw new ServiceProtocolError('INVALID_REQUEST')
    const size = db.db.prepare(`SELECT COALESCE(length(CAST(project_id AS BLOB)),0)+COALESCE(length(CAST(parent_task_id AS BLOB)),0)
      +COALESCE(length(CAST(agent_id AS BLOB)),0)+COALESCE(length(CAST(mcp_scope_nonce AS BLOB)),0) AS bytes FROM tasks WHERE id=?`).get(id) as { bytes: number } | undefined
    if (!size || size.bytes > 768) throw new ServiceProtocolError('INVALID_REQUEST')
    return db.db.prepare('SELECT project_id,parent_task_id,agent_id,mcp_scope_nonce FROM tasks WHERE id=?').get(id) as { project_id: string | null; parent_task_id: string | null; agent_id: string | null; mcp_scope_nonce: string | null }
  }
  const ownerId = scope.taskId ?? scope.artifactTaskId ?? scope.parentTaskId
  const owner = ownerId ? read(ownerId) : null
  const projectId = scope.projectId ?? owner?.project_id
  if (!isDatabaseId(projectId) || !db.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId) || owner && (owner.project_id ?? DEFAULT_PROJECT_ID) !== projectId || scope.agentId && owner?.agent_id !== scope.agentId || scope.sessionNonce && owner?.mcp_scope_nonce !== scope.sessionNonce) throw new ServiceProtocolError('INVALID_REQUEST')
  const checkTask = (id: string) => {
    const task = read(id)
    if ((task.project_id ?? DEFAULT_PROJECT_ID) !== projectId || scope.parentTaskId && scope.taskId && id !== scope.parentTaskId && task.parent_task_id !== scope.parentTaskId) throw new ServiceProtocolError('INVALID_REQUEST')
    if (!scope.parentTaskId && (scope.taskId || scope.artifactTaskId) && id !== (scope.taskId ?? scope.artifactTaskId)) throw new ServiceProtocolError('INVALID_REQUEST')
  }
  if (state?.available) {
    if (state.projectId !== projectId) throw new ServiceProtocolError('INVALID_REQUEST')
    const canvas = state.canvas as { panels: Array<{ taskId: string | null }> }
    const ids = new Set([...(state.visibleTaskIds as string[]), ...canvas.panels.flatMap(panel => panel.taskId ? [panel.taskId] : []), ...[state.selectedTaskId,state.dashboardPreviewTaskId].filter((id): id is string => typeof id === 'string')])
    for (const id of ids) checkTask(id)
  }
  if (command && 'taskId' in command) checkTask(command.taskId)
  if (command?.kind === 'open_artifact' && scope.artifactTaskId && command.taskId !== scope.artifactTaskId) throw new ServiceProtocolError('INVALID_REQUEST')
  if (command?.kind === 'switch_project' && command.projectId !== projectId) throw new ServiceProtocolError('INVALID_REQUEST')
}

function readUiTask(db: DatabaseManager, taskId: string): { id: string; title: string; project_id?: string | null } | undefined {
  if (!taskApiUiOwner) return db.getTask(taskId)
  if (!isDatabaseId(taskId)) return undefined
  const sizes = db.db.prepare('SELECT length(CAST(title AS BLOB)) AS title_bytes,COALESCE(length(CAST(project_id AS BLOB)),0) AS project_bytes FROM tasks WHERE id=?').get(taskId) as { title_bytes: number; project_bytes: number } | undefined
  if (!sizes || sizes.title_bytes > 16384 || sizes.project_bytes > 128) return undefined
  return db.db.prepare('SELECT id,title,project_id FROM tasks WHERE id=?').get(taskId) as { id: string; title: string; project_id: string | null } | undefined
}

export async function handleUiRoute(db: DatabaseManager, route: string, params: Record<string, unknown>, trustedScope?: TaskMcpScope): Promise<unknown> {
  if (!['/get_ui_state','/navigate','/open_task','/move_task_panel','/close_task_panel','/set_canvas_view','/open_artifact'].includes(route)) return undefined
  const owner = taskApiUiOwner
  let state: Record<string, unknown> = uiState
  const beforeEffect = (command?: UiCommand) => { if (owner) { assertTaskApiUiOwner(owner); assertUiApiScope(db, trustedScope, state, command) } }
  if (owner) {
    try { assertUiApiScope(db, trustedScope); state = await owner.snapshot({ beforeEffect: () => { assertTaskApiUiOwner(owner); assertUiApiScope(db,trustedScope) }, signal: new AbortController().signal }) as unknown as Record<string,unknown>; beforeEffect() }
    catch { return { error: 'The window state is unavailable' } }
  }
  const leaseId = owner?.observedLeaseId ?? undefined
  switch (route) {
    case '/get_ui_state':
      return state

    case '/navigate': {
      if (!isUiViewName(params.view)) {
        return { error: 'view must be one of dashboard, tasks, canvas, skills, settings' }
      }
      return sendUiCommand({
        kind: 'navigate',
        view: params.view,
        settingsTab: params.settings_tab ? String(params.settings_tab) : undefined
      }, owner, leaseId, beforeEffect)
    }

    case '/open_task': {
      if (!params.task_id) return { error: 'task_id is required' }
      const taskId = String(params.task_id)
      const task = readUiTask(db, taskId)
      if (!task) return { error: 'Task not found' }

      const requested: UiOpenTaskTarget = params.where === undefined ? 'auto' : String(params.where) as UiOpenTaskTarget
      if (!isUiOpenTaskTarget(requested)) {
        return { error: 'where must be one of auto, workspace, canvas, modal' }
      }
      const where = requested === 'auto' ? resolveOpenTaskTarget(state) : requested
      const result = await sendUiCommand({ kind: 'open_task', taskId, where }, owner, leaseId, beforeEffect)
      return 'error' in result ? result : { ...result, where, task_title: task.title }
    }

    case '/move_task_panel': {
      if (!params.task_id) return { error: 'task_id is required' }
      const x = Number(params.x)
      const y = Number(params.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'x and y must be numbers' }
      const taskId = String(params.task_id)
      if (!readUiTask(db, taskId)) return { error: 'Task not found' }
      return requireCanvasPanel(db, taskId, state) ?? sendUiCommand({ kind: 'move_task_panel', taskId, x, y }, owner, leaseId, beforeEffect)
    }

    case '/close_task_panel': {
      if (!params.task_id) return { error: 'task_id is required' }
      const taskId = String(params.task_id)
      return requireCanvasPanel(db, taskId, state) ?? sendUiCommand({ kind: 'close_task_panel', taskId }, owner, leaseId, beforeEffect)
    }

    case '/set_canvas_view': {
      if (!isUiCanvasViewMode(params.mode)) {
        return { error: 'mode must be one of fit_all, reset, zoom' }
      }
      let zoom: number | undefined
      if (params.mode === 'zoom') {
        zoom = Number(params.zoom)
        if (!Number.isFinite(zoom) || zoom < UI_CANVAS_MIN_ZOOM || zoom > UI_CANVAS_MAX_ZOOM) {
          return { error: `zoom must be a number between ${UI_CANVAS_MIN_ZOOM} and ${UI_CANVAS_MAX_ZOOM}` }
        }
      }
      if (params.mode === 'fit_all' && readCanvasPanels(state).length === 0) {
        return { error: 'The canvas is empty' }
      }
      return sendUiCommand({ kind: 'set_canvas_view', mode: params.mode, zoom }, owner, leaseId, beforeEffect)
    }

    case '/open_artifact': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!params.artifact_id) return { error: 'artifact_id is required' }
      const taskId = String(params.task_id)
      if (!readUiTask(db, taskId)) return { error: 'Task not found' }

      const artifactId = String(params.artifact_id)
      if (owner) {
        try { beforeEffect({ kind: 'open_artifact', taskId, artifactId }); owner.assertCommand({ kind: 'open_artifact', taskId, artifactId }) }
        catch { return { error: 'The task artifact cannot be opened' } }
      }
      // A tab that names nothing shows an empty panel, so the artifact has to
      // exist before the window is told to open it.
      const known = await listRegisteredTaskArtifacts(db.getWorkspaceDir(taskId), taskId)
      if (owner) {
        try { beforeEffect({ kind: 'open_artifact', taskId, artifactId }); owner.assertCommand({ kind: 'open_artifact', taskId, artifactId }) }
        catch { return { error: 'The task artifact cannot be opened' } }
      }
      if (!known.some((artifact) => artifact.artifactId === artifactId)) {
        return {
          error: 'Artifact not found for that task',
          artifacts: known.map((artifact) => ({ artifact_id: artifact.artifactId, title: artifact.title }))
        }
      }
      return sendUiCommand({ kind: 'open_artifact', taskId, artifactId }, owner, leaseId, beforeEffect)
    }

    default:
      return undefined
  }
}
