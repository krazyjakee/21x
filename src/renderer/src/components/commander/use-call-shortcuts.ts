import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { parseCommanderAction } from '@shared/commander-action'
import { isKeyboardInput } from '@/lib/keyboard-shortcuts'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { useCommanderStore } from '@/stores/commander-store'
import { useUIStore } from '@/stores/ui-store'

export function undoLatestCommanderAction(): void {
  const state = useCommanderStore.getState()
  const sessionId = useCommanderCallStore.getState().sessionId ?? state.selectedSessionId
  if (!sessionId) return
  const history = state.messages[sessionId] ?? []
  const calls = new Map(history.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]))
  const candidates = [...history].reverse().flatMap(result => {
    const call = result.tool_call_id ? calls.get(result.tool_call_id) : undefined
    return call ? [{ call, result }] : []
  })
  if (state.recentAction?.result.session_id === sessionId) candidates.unshift(state.recentAction)
  for (const { call, result } of candidates) {
    const action = parseCommanderAction(call.name, result.content, result.is_error)
    if (!action?.undoId || state.undoneActions.includes(action.undoId)) continue
    void state.undoAction(sessionId, action.undoId).catch(error => useCommanderCallUiStore.getState().announce(error instanceof Error ? error.message : 'The action could not be undone.'))
    return
  }
}

/** App-owned shortcuts keep PTT and Stop available across navigation. */
export function useCommanderCallShortcuts(): void {
  useEffect(() => {
    let held = false
    const finish = () => { if (held) { held = false; useCommanderCallStore.getState().finishTalk() } }
    const down = (event: KeyboardEvent) => {
      const call = useCommanderCallStore.getState()
      const ui = useCommanderCallUiStore.getState()
      const view = useUIStore.getState().sidebarView
      if (event.defaultPrevented || event.altKey || event.repeat || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      const key = event.key.toLowerCase()
      const typing = isKeyboardInput(event.target)
      const hasCall = call.status !== 'off' || !!call.error
      if ((event.metaKey || event.ctrlKey) && (hasCall || view === 'commander')) {
        const toggleSurface = () => {
          if (!hasCall) return
          if (ui.pipRequested || view !== 'commander') ui.expand(); else ui.showPip()
        }
        let handled = true
        if (key === 'd' && !event.shiftKey && !typing && call.status === 'live') void call.toggleMicrophone()
        else if (key === 'c' && event.shiftKey) ui.toggleCaptions()
        else if (key === '\\' && !event.shiftKey) ui.togglePanel()
        else if (key === 'm' && event.shiftKey && hasCall) toggleSurface()
        else if (key === 'e' && event.shiftKey && hasCall) call.end()
        else if (key === 'z' && !event.shiftKey && !typing) undoLatestCommanderAction()
        else handled = false
        if (handled) { event.preventDefault(); event.stopImmediatePropagation(); return }
      }
      if (event.code !== 'Space' && event.key !== ' ') return
      if (call.status !== 'live' || call.micMode !== 'push-to-talk' || call.muted || event.metaKey || event.ctrlKey || event.shiftKey || typing
        || (event.target instanceof HTMLElement && event.target.closest('button, a, summary, [role="menu"]'))) return
      event.preventDefault(); event.stopImmediatePropagation(); held = true; void call.beginTalk()
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.key === ' ') {
        if (held) { event.preventDefault(); event.stopImmediatePropagation() }
        finish()
      }
    }
    const focused = (event: FocusEvent) => { if (held && (isKeyboardInput(event.target) || event.target instanceof HTMLElement && event.target.closest('button, a, summary, [role="dialog"]'))) finish() }
    const hidden = () => { if (document.hidden) finish() }
    document.addEventListener('focusin', focused); document.addEventListener('visibilitychange', hidden)
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', finish)
    return () => { finish(); document.removeEventListener('focusin', focused); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', finish) }
  }, [])
}

export function navigateCallToolbar(event: ReactKeyboardEvent<HTMLElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || (event.target as HTMLElement).tagName === 'SELECT') return
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
}
