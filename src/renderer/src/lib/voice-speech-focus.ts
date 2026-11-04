import { commanderSessionOfVoiceKey } from '@shared/commander-call'
import type { VoiceSpeechSource } from '@shared/voice-tts'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { useCommanderStore } from '@/stores/commander-store'
import { getCaptainTaskId } from '@/stores/coordinator-store'
import { useUIStore } from '@/stores/ui-store'

/**
 * Who may talk without being asked.
 *
 * A Captain or a Commander speaks only while the user is looking at it: this
 * window has focus and its conversation is on screen. An answer written at any
 * other time stays in the chat and is not read out later.
 *
 * This lives in the renderer because only the renderer knows what is on screen,
 * and every passage reaches it as `speechStart` before any audio does.
 */

/** How often a passage being read checks that it is still in focus. */
export const SPEECH_FOCUS_CHECK_MS = 300

/** Speech that started by itself. A button press is always honoured. */
export function isAutomaticSpeech(source: VoiceSpeechSource): boolean {
  return source === 'agent_answer' || source === 'conversation'
}

/** The floating call is on screen wherever the user goes, so it counts. */
function commanderOnScreen(sessionId: string): boolean {
  if (useCommanderCallStore.getState().sessionId !== sessionId) return false
  if (useCommanderCallUiStore.getState().pipRequested) return true
  if (useUIStore.getState().sidebarView !== 'commander') return true
  return useCommanderStore.getState().selectedSessionId === sessionId
}

/**
 * The drawer's panel names no task, and the dashboard box has no transcript at
 * all, but each is where the user is talking to this Captain.
 */
function captainOnScreen(taskId: string): boolean {
  if (getCaptainTaskId() !== taskId) return false
  const { showOrchestrator, sidebarView } = useUIStore.getState()
  return showOrchestrator || sidebarView === 'dashboard'
}

/** Measured, because a panel can stay mounted inside a hidden or zero-width parent. */
function transcriptOnScreen(taskId: string): boolean {
  return [...document.querySelectorAll<HTMLElement>('[data-transcript-task]')].some((panel) => {
    if (panel.dataset.transcriptTask !== taskId) return false
    const { width, height } = panel.getBoundingClientRect()
    return width > 0 && height > 0
  })
}

/** True when the owner of a passage (a task id or a Commander voice key) has the user's attention. */
export function speechInFocus(owner: string | undefined): boolean {
  if (!owner || !document.hasFocus()) return false
  const commanderSession = commanderSessionOfVoiceKey(owner)
  if (commanderSession) return commanderOnScreen(commanderSession)
  return captainOnScreen(owner) || transcriptOnScreen(owner)
}
