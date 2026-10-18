import { useEffect, useMemo, useReducer, useRef } from 'react'
import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { useProjectStore } from '@/stores/project-store'

/** One mounted task editor owns each raw write, including an uncertain reply. */
export function useTaskEditReceipt(taskId: string) {
  const identity = useMemo(() => ({ taskId, native: getDesktopHost().kind === 'tauri', scope: captureDesktopRead(), live: true, retired: false, pending: false, review: false, failed: false }), [taskId])
  const owner = useRef(identity); owner.current = identity
  const [, repaint] = useReducer(value => value + 1, 0)
  useEffect(() => {
    const captured = identity
    captured.live = true
    let off = () => {}, offProject = () => {}
    const release = () => { off(); offProject(); window.removeEventListener('pagehide', withdraw) }
    const withdraw = () => {
      if (!captured.native || !captured.live || captured.retired) return
      captured.retired = true; captured.review = true; release(); if (owner.current === captured) repaint()
    }
    const host = getDesktopHost()
    off = captured.native ? host.subscribeConnection(() => { if (!captured.scope.isCurrent()) withdraw() }) : () => {}
    offProject = captured.native ? useProjectStore.subscribe((state, previous) => { if (state.currentProjectId !== previous.currentProjectId) withdraw() }) : () => {}
    window.addEventListener('pagehide', withdraw)
    return () => { captured.live = false; release() }
  }, [identity])
  const retained = () => identity.live && owner.current === identity && !identity.retired && (!identity.native || identity.scope.isCurrent())
  const current = () => {
    const captured = identity
    return captured.live && owner.current === captured && !captured.review && (!captured.native || captured.scope.isCurrent())
  }
  const perform = async <T,>(write: () => T | Promise<T>, accepted?: () => void): Promise<T> => {
    const captured = identity
    if (!current() || captured.pending) throw new Error('Review the current task before submitting another action.')
    captured.pending = true; captured.failed = false; repaint()
    try {
      const result = await write()
      if (!current()) throw new Error('Task editor was replaced.')
      accepted?.()
      return result
    } catch (error) {
      if (captured.live && owner.current === captured) {
        captured.review = captured.native; captured.failed = true; repaint()
      }
      throw error
    } finally { captured.pending = false; if (captured.live && owner.current === captured) repaint() }
  }
  const run = async (write: () => void | Promise<void>, accepted?: () => void) => {
    if (!current() || identity.pending) return
    try { await perform(write, accepted) } catch { /* This owner publishes the fixed review state. */ }
  }
  return { run, perform, current, retained, admit: () => current() && !identity.pending, busy: identity.pending, review: identity.review, blocked: identity.pending || identity.review, failed: identity.failed }
}
