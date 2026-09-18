import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useUIStore, type SidebarView } from '@/stores/ui-store'
import { findComposerElement, insertIntoComposer, isGlobalShortcutBlocked, shouldAutoFocusComposer } from '@/lib/keyboard-shortcuts'
import type { CommandPaletteActions } from '../CommandPalette'
import { NAV_ITEMS } from '../nav-items'

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
  vm: 'toggleMastermindAudio'
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
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        if (key === 'k') {
          e.preventDefault()
          setCmdOpen((value) => !value)
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
      else if (e.key === 'Escape') { e.preventDefault(); if (showOrchestrator) setShowOrchestrator(false); else actions.clearSelection() }
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
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (chordRef.current) window.clearTimeout(chordRef.current.timer)
    }
  }, [actions, activeModal, closeModal, openCreateModal, setCmdOpen, setShowOrchestrator, setSidebarView, showOrchestrator, sidebarView])
}
