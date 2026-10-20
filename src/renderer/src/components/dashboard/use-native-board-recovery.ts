import { useEffect, useState } from 'react'
import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { agentApi, onAgentStartQueueChanged } from '@/lib/ipc-client'
import { useProjectStore } from '@/stores/project-store'
import type { TaskBoardTransitionPhase } from './task-board-transition'

/** A bounded read owner; recovery notifications never replay board commands. */
export function useNativeBoardRecovery(projectId: string, visibleTaskIds: string, clearSettled: (ids: string[]) => void) {
  const native = getDesktopHost().kind === 'tauri'
  const [states, setStates] = useState<Record<string, TaskBoardTransitionPhase>>({})
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!native) return undefined
    const ids = visibleTaskIds ? visibleTaskIds.split(',') : [], allowed = new Set(ids)
    const host = getDesktopHost()
    let live = true, revision = 0, busy = false, requested = false
    let scope = captureDesktopRead()
    let offQueue = () => {}, offConnection = () => {}, offProject = () => {}
    const release = () => { offQueue(); offConnection(); offProject(); window.removeEventListener('pagehide', retire) }
    const retire = () => { live = false; revision++; release() }
    const current = () => live && scope.isCurrent() && useProjectStore.getState().currentProjectId === projectId
    const phase = (state: string): TaskBoardTransitionPhase | undefined => state === 'failed' ? 'failed' : state === 'claimed' || state === 'starting' ? 'starting' : state === 'queued' || state === 'retrying' ? 'queued' : undefined
    const hydrate = async () => {
      if (busy || !current()) return
      busy = true
      try {
        while (requested && current()) {
          requested = false
          const captured = revision, next: Record<string, TaskBoardTransitionPhase> = {}, settled: string[] = []
          try {
            if (ids.length > 512) throw new Error('Board recovery read budget exceeded.')
            // Four raw reads at a time; notifications coalesce behind this owner.
            for (let offset = 0; offset < ids.length; offset += 4) {
              if (!current() || revision !== captured) break
              const batch = ids.slice(offset, offset + 4)
              const rows = await Promise.all(batch.map(id => agentApi.getStartRecoveryState(id)))
              if (!current() || revision !== captured) break
              for (let i = 0; i < rows.length; i++) {
                const row = rows[i]
                if (!row) continue
                if (row.taskId !== batch[i] || row.projectId !== projectId) throw new Error('Recovery row does not match the original task.')
                const value = phase(row.state)
                if (value) next[row.taskId] = value
                if (['started', 'recovered', 'cancelled', 'failed'].includes(row.state)) settled.push(row.taskId)
              }
            }
            if (current() && revision === captured) { setStates(next); clearSettled(settled); setFailed(false) }
          } catch {
            if (current() && revision === captured) setFailed(true)
          }
        }
      } finally { busy = false }
    }
    const request = () => { requested = true; void hydrate() }
    setStates({}); setFailed(false)
    offQueue = onAgentStartQueueChanged(event => {
      if (!current()) return
      revision++
      setStates(previous => {
        const next = Object.fromEntries(Object.entries(previous).filter(([, value]) => value === 'failed')) as Record<string, TaskBoardTransitionPhase>
        for (const row of event.queue) if (allowed.has(row.taskId) && row.projectId === projectId) { const value = phase(row.state); if (value) next[row.taskId] = value }
        return next
      })
      request()
    }) ?? (() => {})
    offConnection = host.subscribeConnection(() => {
      if (!live) return
      revision++
      if (host.connection.status === 'ready') { scope = captureDesktopRead(); setStates({}); request() }
    })
    offProject = useProjectStore.subscribe((state, previous) => { if (state.currentProjectId !== previous.currentProjectId) retire() })
    window.addEventListener('pagehide', retire)
    request()
    return retire
  }, [native, projectId, visibleTaskIds, clearSettled])
  return { states, failed }
}
