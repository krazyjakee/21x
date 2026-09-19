import { useEffect, useState } from 'react'
import { Check, ShieldAlert, ShieldQuestion, X } from 'lucide-react'
import { ACTIVITY_REVALIDATE_MS, ACTIVITY_STALE_MS } from '@shared/activity'
import { activityNow } from '@/lib/activity/activity-clock'
import { escalationApi } from '@/lib/ipc-client'
import { useProjectStore } from '@/stores/project-store'
import type { HeldAction } from '@shared/project-limit-types'

/**
 * Captain tool calls held by a project's escalation policy (#66), as a
 * status-bar pill that opens a small list with Approve / Reject. Renders
 * nothing while nothing is held. The list comes from the main process and is
 * pushed on every change; while the window is visible it is also re-read every
 * 5 s (#95), and when reads keep failing for 15 s a static "unavailable" pill
 * replaces silence, because a failed read must not look like "nothing held".
 * This is a policy-held action (orthogonal to session approval requests).
 */
export function HeldActionsNotice() {
  const [held, setHeld] = useState<HeldAction[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const projects = useProjectStore((s) => s.projects)

  useEffect(() => {
    let cancelled = false
    let lastOkAt: number | null = null
    const startedAt = activityNow()
    let generation = 0
    const ok = (list: HeldAction[] | undefined): void => {
      lastOkAt = activityNow()
      setHeld(list ?? [])
      setUnavailable(false)
    }
    const read = (): void => {
      const mine = ++generation
      try {
        escalationApi.listHeld()
          .then((list) => { if (!cancelled && mine === generation) ok(list) })
          .catch(() => {
            if (cancelled) return
            const since = lastOkAt ?? startedAt
            if (activityNow() - since >= ACTIVITY_STALE_MS || lastOkAt === null) setUnavailable(true)
          })
      } catch {
        // No bridge (a test shell): nothing to show.
      }
    }
    read()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      read()
    }, ACTIVITY_REVALIDATE_MS)
    const off = escalationApi.onHeldChanged((event) => {
      generation += 1
      ok(event?.held)
    })
    return () => { cancelled = true; clearInterval(timer); off() }
  }, [])

  useEffect(() => { if (held.length === 0) setOpen(false) }, [held.length])

  if (unavailable) {
    return (
      <span
        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground"
        title="Held Captain actions could not be read"
        role="img"
        aria-label="Held Captain actions unavailable"
        data-testid="held-actions-unavailable"
      >
        <ShieldQuestion aria-hidden="true" className="h-3 w-3" />
        held actions unavailable
      </span>
    )
  }

  if (held.length === 0) return null

  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? 'Project'

  const answer = async (id: string, approve: boolean) => {
    setBusy(id)
    try {
      if (approve) await escalationApi.approve(id)
      else await escalationApi.reject(id)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-500/10 dark:text-amber-400 cursor-pointer"
        title="Captain actions waiting for your approval"
        aria-label={`${held.length} Captain action${held.length !== 1 ? 's' : ''} waiting for approval`}
        aria-expanded={open}
      >
        <ShieldAlert className="h-3 w-3" />
        {held.length} waiting for approval
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Held Captain actions"
          className="absolute bottom-full right-0 z-50 mb-2 w-96 rounded-lg border border-border bg-card p-2 text-xs text-foreground shadow-lg"
        >
          <p className="mb-2 px-1 text-[11px] text-muted-foreground">
            The project’s escalation policy asks you before these run. Approve runs the call; Reject drops it and tells the Captain.
          </p>
          <ul className="space-y-1.5">
            {held.map((action) => (
              <li key={action.id} className="flex items-start gap-2 rounded-md border border-border/60 bg-background px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium" title={action.summary}>{action.summary}</div>
                  <div className="text-[10px] text-muted-foreground">{projectName(action.projectId)} · {action.tool}</div>
                </div>
                <button
                  type="button"
                  disabled={busy === action.id}
                  onClick={() => void answer(action.id, true)}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-400 cursor-pointer"
                  title="Approve and run"
                  aria-label={`Approve: ${action.summary}`}
                >
                  <Check className="h-3.5 w-3.5" /> Approve
                </button>
                <button
                  type="button"
                  disabled={busy === action.id}
                  onClick={() => void answer(action.id, false)}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50 cursor-pointer"
                  title="Reject"
                  aria-label={`Reject: ${action.summary}`}
                >
                  <X className="h-3.5 w-3.5" /> Reject
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
