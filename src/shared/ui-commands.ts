/**
 * Commands that drive the desktop window from outside the renderer.
 *
 * An agent asks for these through MCP tools; the main process validates what it
 * can and pushes one command down `UI_COMMAND_CHANNEL`. The renderer applies it
 * to the stores. The channel carries **intent**, never a store mutation, so the
 * renderer stays the only place that knows how a view is assembled.
 *
 * Every command is addressed by task ID, never by element.
 */

/** The places a user can be sent. `settings` is a pane, not a sidebar view. */
export const UI_VIEW_NAMES = ['dashboard', 'tasks', 'skills', 'settings'] as const
export type UiViewName = (typeof UI_VIEW_NAMES)[number]

/** Where a task can be opened. `auto` is resolved in main from the open view. */
export const UI_OPEN_TASK_TARGETS = ['auto', 'workspace', 'modal'] as const
export type UiOpenTaskTarget = (typeof UI_OPEN_TASK_TARGETS)[number]

export const UI_COMMAND_CHANNEL = 'ui:command'

export type UiCommand =
  | { kind: 'navigate'; view: UiViewName; settingsTab?: string }
  /** Show a project (the Commander's `navigate_to_project`). Leaves a project-less view for the dashboard. */
  | { kind: 'switch_project'; projectId: string }
  | { kind: 'open_task'; taskId: string; where: Exclude<UiOpenTaskTarget, 'auto'> }
  | { kind: 'open_artifact'; taskId: string; artifactId: string }

/** What the renderer did with one command. Reported back for the tool result. */
export interface UiCommandResult {
  applied: boolean
  /** Short, user-facing reason when nothing happened. */
  detail?: string
}

/** The published screen. `get_ui_state` returns this plus `available`. */
export interface UiStateSnapshot {
  view: string
  /** The project on screen. */
  projectId: string
  modal: string | null
  selectedTaskId: string | null
  selectedTaskTitle: string | null
  dashboardPreviewTaskId: string | null
  captainOpen: boolean
  settingsTab: string | null
  waitingForYou: boolean
  visibleTaskIds: string[]
}

export function isUiViewName(value: unknown): value is UiViewName {
  return typeof value === 'string' && (UI_VIEW_NAMES as readonly string[]).includes(value)
}

export function isUiOpenTaskTarget(value: unknown): value is UiOpenTaskTarget {
  return typeof value === 'string' && (UI_OPEN_TASK_TARGETS as readonly string[]).includes(value)
}
