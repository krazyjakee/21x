import { CALL_EVENT_MS, callEventIdentity } from '@shared/commander-call'
import { isCommanderActionUndoable } from '@shared/commander-tools'
import { activityNow } from '@/lib/activity/activity-clock'
import { commanderApi } from '@/lib/ipc-client'
import { dispatchShortcutFeedback } from '@/lib/keyboard-shortcuts'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useProjectStore } from '@/stores/project-store'
import { useSkillStore } from '@/stores/skill-store'
import { useUIStore } from '@/stores/ui-store'

const undoInFlight = new Set<string>()

function focusAfterViewChange(selector: string): void {
  window.setTimeout(() => document.querySelector<HTMLElement>(selector)?.focus(), 0)
}

/** Collapse the full call into the app-level PiP and move focus to its counterpart control. */
export function enterCommanderPictureInPicture(focus = true): boolean {
  const call = useCommanderCallStore.getState()
  if (call.status === 'off' && !call.error) return false
  const ui = useUIStore.getState()
  if (ui.activeModal === 'settings') ui.closeModal()
  ui.setSidebarView(ui.lastNonCommanderView)
  if (focus) focusAfterViewChange('[data-commander-pip-expand]')
  return true
}

/** Restore the full call and focus the PiP button that replaced Expand. */
export function expandCommanderCall(): boolean {
  const call = useCommanderCallStore.getState()
  if (call.status === 'off' && !call.error) return false
  const ui = useUIStore.getState()
  if (ui.activeModal === 'settings') ui.closeModal()
  ui.setSidebarView('commander')
  focusAfterViewChange('[data-commander-pip-toggle]')
  return true
}

export function toggleCommanderPictureInPicture(): boolean {
  const ui = useUIStore.getState()
  return ui.sidebarView === 'commander' && ui.activeModal !== 'settings'
    ? enterCommanderPictureInPicture()
    : expandCommanderCall()
}

export function canUndoLatestCommanderAction(): boolean {
  const event = useCommanderCallStore.getState().lastEvent
  const age = event ? activityNow() - event.at : -1
  return Boolean(
    event &&
    event.kind === 'action' &&
    age >= 0 &&
    age < CALL_EVENT_MS &&
    !undoInFlight.has(callEventIdentity(event)) &&
    isCommanderActionUndoable(event.toolName)
  )
}

/** Exact-reversal Undo for the still-visible latest action. */
export async function undoLatestCommanderAction(): Promise<boolean> {
  const call = useCommanderCallStore.getState()
  const event = call.lastEvent
  if (!canUndoLatestCommanderAction() || !event || event.kind !== 'action') return false

  const identity = callEventIdentity(event)
  undoInFlight.add(identity)
  try {
    await commanderApi.undoAction(event.sessionId, event.toolCallId)
    useCommanderCallStore.getState().clearEvent(event)
    void useProjectStore.getState().fetchProjects()
    void useSkillStore.getState().fetchSkills()
    return true
  } finally {
    undoInFlight.delete(identity)
  }
}

export async function undoLatestCommanderActionWithFeedback(): Promise<void> {
  try {
    const undone = await undoLatestCommanderAction()
    dispatchShortcutFeedback(undone ? 'Latest Commander action undone' : 'No reversible Commander action to undo', !undone)
  } catch (error) {
    dispatchShortcutFeedback(error instanceof Error ? error.message : String(error), true)
  }
}
