import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useUIStore, type SidebarView } from '@/stores/ui-store'
import { findComposerElement, insertIntoComposer, isGlobalShortcutBlocked, isKeyboardInput, shouldAutoFocusComposer } from '@/lib/keyboard-shortcuts'
import type { CommandPaletteActions } from '../CommandPalette'
import { NAV_ITEMS } from '../nav-items'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderStore } from '@/stores/commander-store'
import { useVoiceStore } from '@/stores/voice-store'
import {
  canUndoLatestCommanderAction,
  toggleCommanderPictureInPicture,
  undoLatestCommanderActionWithFeedback
} from '@/lib/commander-call/commander-call-ui'

type ChordPrefix = 'g' | 'o' | 'y' | 'v'

const CHORD_VIEWS: Record<string, SidebarView> = { gd: 'dashboard', gt: 'tasks', gs: 'skills' }
const CHORD_ACTIONS: Record<string, keyof CommandPaletteActions> = {
  od: 'openDetails',
  oc: 'openChanges',
  oo: 'openOutput',
  oa: 'openArtifact',
  op: 'openPullRequest',
  yp: 'copyPullRequestUrl',
  yb: 'copyPullRequestBranch',
  gc: 'openTaskOnCanvas',
  gp: 'openParentTask',
  os: 'openSubtasks',
  vt: 'toggleTaskAudio',
  vm: 'toggleCaptainAudio'
}

/** Command palette toggle, view switching, two-key chords, and single-key task shortcuts. */
export function useGlobalShortcuts(actions: CommandPaletteActions, setCmdOpen: Dispatch<SetStateAction<boolean>>) {
  const sidebarView = useUIStore((s) => s.sidebarView)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const openCreateModal = useUIStore((s) => s.openCreateModal)
  const showOrchestrator = useUIStore((s) => s.showOrchestrator)
  const setShowOrchestrator = useUIStore((s) => s.setShowOrchestrator)
  const chordRef = useRef<{ key: ChordPrefix; timer: number } | null>(null)

  useEffect(() => {
    const onCommanderKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const mod = e.metaKey || e.ctrlKey
      const call = useCommanderCallStore.getState()
      const ui = useUIStore.getState()
      const inCommanderContext = call.status !== 'off' || ui.sidebarView === 'commander'
      const commanderKey = (e.key === 'Escape' && call.status !== 'off') || (
        inCommanderContext && mod && (
          (!e.shiftKey && (key === 'd' || e.key === '\\' || key === 'z')) ||
          (e.shiftKey && ['c', 'm', 'e'].includes(key))
        )
      )
      if (!commanderKey) return
      if (e.defaultPrevented || e.isComposing || e.altKey || isKeyboardInput(e.target) ||
          document.querySelector('[role="dialog"], [role="alertdialog"]')) return

      const voiceState = useVoiceStore.getState()
      const voiceTurnId = voiceState.turnId
      const foreignVoiceTurn = Boolean(voiceTurnId && voiceTurnId !== call.turnId)
      const foreignConfirmation = Boolean(
        voiceState.confirmation && voiceState.confirmation.ownerSessionId !== call.sessionId
      )
      if (foreignVoiceTurn || foreignConfirmation) return
      if (e.repeat) {
        // A held Commander chord is consumed once. Do not let it fall through
        // to the older bubbling listeners and turn one press into many actions.
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      let handled = false

      if (e.key === 'Escape' && call.status !== 'off') {
        call.interrupt('stop')
        handled = true
      } else if (mod && !e.shiftKey && key === 'd' && inCommanderContext) {
        if (call.status === 'live') void call.toggleMicrophone()
        else {
          const sessionId = useCommanderStore.getState().selectedSessionId
          if (sessionId) void call.start(sessionId)
        }
        handled = true
      } else if (mod && e.shiftKey && key === 'c' && inCommanderContext) {
        ui.setCommanderCaptionsEnabled(!ui.commanderCaptionsEnabled)
        handled = true
      } else if (mod && !e.shiftKey && e.key === '\\' && inCommanderContext) {
        ui.setCommanderPanelOpen(!ui.commanderPanelOpen)
        handled = true
      } else if (mod && e.shiftKey && key === 'm' && call.status !== 'off') {
        toggleCommanderPictureInPicture()
        handled = true
      } else if (mod && e.shiftKey && key === 'e' && call.status !== 'off') {
        call.end()
        handled = true
      } else if (mod && !e.shiftKey && key === 'z' && canUndoLatestCommanderAction()) {
        void undoLatestCommanderActionWithFeedback()
        handled = true
      }

      if (!handled) return
      e.preventDefault()
      // VoiceOverlay and the ordinary task shortcuts must not also react to
      // the same Escape/chord after the call has claimed it.
      e.stopImmediatePropagation()
    }

    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        if (key === 'k') {
          e.preventDefault()
          setCmdOpen((value) => !value)
          return
        }
        // Mod+P: switch project (task views; Commander is cross-project).
        if (key === 'p' && !e.shiftKey) {
          e.preventDefault()
          if (useUIStore.getState().sidebarView === 'commander') setSidebarView('dashboard')
          setCmdOpen(false)
          const ui = useUIStore.getState()
          ui.setProjectSwitcherOpen(!ui.projectSwitcherOpen)
          return
        }
        const number = Number(e.key)
        if (Number.isInteger(number) && number >= 1 && number <= NAV_ITEMS.length) {
          e.preventDefault()
          if (activeModal === 'settings') closeModal()
          setSidebarView(NAV_ITEMS[number - 1].key)
        }
        return
      }
      // Radix dialogs prevent the Escape event after they close. Respect that
      // marker so this listener does not also close the task behind the popup.
      if (isGlobalShortcutBlocked(e)) return

      const pending = chordRef.current
      if (pending) {
        window.clearTimeout(pending.timer)
        chordRef.current = null
        const chord = `${pending.key}${key}`
        if (CHORD_VIEWS[chord]) {
          e.preventDefault()
          if (activeModal === 'settings') closeModal()
          setSidebarView(CHORD_VIEWS[chord])
        } else if (CHORD_ACTIONS[chord]) {
          e.preventDefault()
          actions[CHORD_ACTIONS[chord]]()
        }
        return
      }

      if (key === 'g' || (sidebarView !== 'canvas' && (key === 'o' || key === 'y' || key === 'v'))) {
        e.preventDefault()
        chordRef.current = {
          key: key as ChordPrefix,
          timer: window.setTimeout(() => { chordRef.current = null }, 1200)
        }
        return
      }
      if (sidebarView === 'canvas') return
      if (e.repeat && key !== 'j' && key !== 'k') return

      // Explicit composer focus (I) — before single-letter task shortcuts
      if (key === 'i' && !e.shiftKey) { e.preventDefault(); actions.focusComposer(); return }

      // Just start typing: any printable key that is not a defined shortcut focuses the
      // composer and inserts the character, so the first keystroke is not lost.
      if (shouldAutoFocusComposer(e)) {
        const composer = findComposerElement()
        if (composer) {
          e.preventDefault()
          composer.focus()
          insertIntoComposer(composer, e.key)
          return
        }
      }

      if (key === 'j') { e.preventDefault(); actions.nextTask() }
      else if (key === 'k') { e.preventDefault(); actions.previousTask() }
      else if (e.key === 'Enter' && !(e.target as HTMLElement | null)?.closest('button, a')) { e.preventDefault(); actions.openTask() }
      else if (e.key === 'Escape') {
        // A foreign Captain voice turn remains the authoritative Escape owner
        // even while a muted Commander call is open. Leave the event untouched
        // for VoiceOverlay instead of clearing the selected task first.
        const call = useCommanderCallStore.getState()
        const voiceTurnId = useVoiceStore.getState().turnId
        if (call.status !== 'off' && voiceTurnId && voiceTurnId !== call.turnId) return
        e.preventDefault()
        if (showOrchestrator) setShowOrchestrator(false)
        else actions.clearSelection()
      }
      else if (key === 'c') { e.preventDefault(); openCreateModal() }
      else if (key === 'e') { e.preventDefault(); actions.completeTask() }
      else if (key === 'h' && e.shiftKey) { e.preventDefault(); actions.runHeartbeat() }
      else if (key === 'h') { e.preventDefault(); actions.snoozeTask() }
      else if (key === 'r') { e.preventDefault(); actions.runTask() }
      else if (key === 'w') { e.preventDefault(); actions.nudgeTask() }
      else if (e.key === '#') { e.preventDefault(); actions.deleteTask() }
      else if (e.key === '?') { e.preventDefault(); actions.showShortcuts() }
      else if (e.key === '/') { e.preventDefault(); actions.focusSearch() }
    }
    window.addEventListener('keydown', onCommanderKey, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onCommanderKey, true)
      window.removeEventListener('keydown', onKey)
      if (chordRef.current) window.clearTimeout(chordRef.current.timer)
    }
  }, [actions, activeModal, closeModal, openCreateModal, setCmdOpen, setShowOrchestrator, setSidebarView, showOrchestrator, sidebarView])
}
