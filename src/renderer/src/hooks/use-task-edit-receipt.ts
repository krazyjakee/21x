import { useEffect, useRef, useState } from 'react'
import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { useProjectStore } from '@/stores/project-store'

/** One mounted task editor owns each raw write, including an uncertain reply. */
export function useTaskEditReceipt(taskId: string) {
  const owner = useRef({ taskId, native: getDesktopHost().kind === 'tauri', scope: captureDesktopRead(), live: true, pending: false, review: false })
  const currentId = useRef(taskId); currentId.current = taskId
  const [busy, setBusy] = useState(false), [review, setReview] = useState(false), [failed, setFailed] = useState(false)
  useEffect(() => {
    const captured = owner.current
    captured.live = true
    let off = () => {}, offProject = () => {}
    const release = () => { off(); offProject(); window.removeEventListener('pagehide', withdraw) }
    const withdraw = () => {
      if (!captured.native || !captured.live || captured.review) return
      captured.review = true; release(); setReview(true)
    }
    const host = getDesktopHost()
    off = captured.native ? host.subscribeConnection(() => { if (!captured.scope.isCurrent()) withdraw() }) : () => {}
    offProject = useProjectStore.subscribe((state, previous) => { if (state.currentProjectId !== previous.currentProjectId) withdraw() })
    window.addEventListener('pagehide', withdraw)
    return () => { captured.live = false; release() }
  }, [])
  const current = () => {
    const captured = owner.current
    return captured.live && captured.taskId === currentId.current && !captured.review && (!captured.native || captured.scope.isCurrent())
  }
  const run = async (write: () => void | Promise<void>, accepted?: () => void) => {
    const captured = owner.current
    if (!current() || captured.pending) return
    captured.pending = true; setBusy(true); setFailed(false)
    try {
      await write()
      if (!current()) throw new Error('Task editor was replaced.')
      accepted?.()
    } catch {
      if (captured.live && captured.taskId === currentId.current) {
        captured.review = captured.native; setReview(captured.review); setFailed(true)
      }
    } finally { captured.pending = false; if (captured.live && captured.taskId === currentId.current) setBusy(false) }
  }
  return { run, current, admit: () => current() && !owner.current.pending, busy, review, blocked: busy || review, failed }
}
