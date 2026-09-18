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
import { listRegisteredTaskArtifacts } from '../artifacts'
import { notifyRenderer, uiState } from './state'

/** The canvas panels the window last published, or none when it published none. */
function readCanvasPanels(): Array<{ taskId: string | null }> {
  const canvas = uiState.canvas as { panels?: Array<{ taskId: string | null }> } | undefined
  return Array.isArray(canvas?.panels) ? canvas.panels : []
}

/**
 * Where "open this task" should send the user when the caller did not say.
 * It follows the screen: the canvas stays on the canvas, the dashboard gets
 * the dialog that keeps the user there, anything else the full task view.
 */
function resolveOpenTaskTarget(): 'workspace' | 'canvas' | 'modal' {
  const view = typeof uiState.view === 'string' ? uiState.view : null
  if (view === 'canvas') return 'canvas'
  if (view === 'dashboard') return 'modal'
  return 'workspace'
}

/** Refuses when that task has no panel, so a move cannot silently do nothing. */
function requireCanvasPanel(taskId: string): { error: string } | null {
  if (readCanvasPanels().some((panel) => panel.taskId === taskId)) return null
  return { error: 'That task has no panel on the canvas. Open it there first.' }
}

/**
 * A command that reaches no window is a failure, not a success: an agent that
 * is told "done" would go on to describe a screen the user never saw.
 */
function sendUiCommand(command: UiCommand): { success: true; command: string } | { error: string } {
  if (!uiState.available) return { error: 'No 21x window is open' }
  if (!notifyRenderer) return { error: 'The window cannot be reached' }
  notifyRenderer(UI_COMMAND_CHANNEL, command)
  return { success: true, command: command.kind }
}

export async function handleUiRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  switch (route) {
    case '/get_ui_state':
      return uiState

    case '/navigate': {
      if (!isUiViewName(params.view)) {
        return { error: 'view must be one of dashboard, tasks, canvas, skills, settings' }
      }
      return sendUiCommand({
        kind: 'navigate',
        view: params.view,
        settingsTab: params.settings_tab ? String(params.settings_tab) : undefined
      })
    }

    case '/open_task': {
      if (!params.task_id) return { error: 'task_id is required' }
      const taskId = String(params.task_id)
      const task = db.getTask(taskId)
      if (!task) return { error: 'Task not found' }

      const requested: UiOpenTaskTarget = params.where === undefined ? 'auto' : String(params.where) as UiOpenTaskTarget
      if (!isUiOpenTaskTarget(requested)) {
        return { error: 'where must be one of auto, workspace, canvas, modal' }
      }
      const where = requested === 'auto' ? resolveOpenTaskTarget() : requested
      const result = sendUiCommand({ kind: 'open_task', taskId, where })
      return 'error' in result ? result : { ...result, where, task_title: task.title }
    }

    case '/move_task_panel': {
      if (!params.task_id) return { error: 'task_id is required' }
      const x = Number(params.x)
      const y = Number(params.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'x and y must be numbers' }
      const taskId = String(params.task_id)
      if (!db.getTask(taskId)) return { error: 'Task not found' }
      return requireCanvasPanel(taskId) ?? sendUiCommand({ kind: 'move_task_panel', taskId, x, y })
    }

    case '/close_task_panel': {
      if (!params.task_id) return { error: 'task_id is required' }
      const taskId = String(params.task_id)
      return requireCanvasPanel(taskId) ?? sendUiCommand({ kind: 'close_task_panel', taskId })
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
      if (params.mode === 'fit_all' && readCanvasPanels().length === 0) {
        return { error: 'The canvas is empty' }
      }
      return sendUiCommand({ kind: 'set_canvas_view', mode: params.mode, zoom })
    }

    case '/open_artifact': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!params.artifact_id) return { error: 'artifact_id is required' }
      const taskId = String(params.task_id)
      if (!db.getTask(taskId)) return { error: 'Task not found' }

      const artifactId = String(params.artifact_id)
      // A tab that names nothing shows an empty panel, so the artifact has to
      // exist before the window is told to open it.
      const known = await listRegisteredTaskArtifacts(db.getWorkspaceDir(taskId), taskId)
      if (!known.some((artifact) => artifact.artifactId === artifactId)) {
        return {
          error: 'Artifact not found for that task',
          artifacts: known.map((artifact) => ({ artifact_id: artifact.artifactId, title: artifact.title }))
        }
      }
      return sendUiCommand({ kind: 'open_artifact', taskId, artifactId })
    }

    default:
      return undefined
  }
}
