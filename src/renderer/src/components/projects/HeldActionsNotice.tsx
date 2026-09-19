import { useEffect, useState, useRef, useId } from 'react'
import { Check, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { escalationApi, mergeGrantsApi } from '@/lib/ipc-client'
import { useProjectStore } from '@/stores/project-store'
import type { HeldAction } from '@shared/project-limit-types'
import { describeMergeGrant, type MergeGrant } from '@shared/merge-grants'

/**
 * Captain tool calls held by a project's escalation policy (#66), as a
 * status-bar pill that opens a small list with Approve / Reject. Renders
 * nothing while nothing is held. The list comes from the main process and is
 * pushed on every change, so this never has to poll.
 *
 * Active merge grants (#137) are listed here too, each revocable in one
 * click, so standing authority the user gave is always in sight.
 */
export function HeldActionsNotice() {
  const [held, setHeld] = useState<HeldAction[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const projects = useProjectStore((s) => s.projects)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const dialogId = useId()
  useEffect(() => { if (open) dialogRef.current?.focus() }, [open])
  const [grants, setGrants] = useState<MergeGrant[]>([])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      mergeGrantsApi.listActive()
        .then((list) => { if (!cancelled) setGrants(list ?? []) })
        .catch(() => { /* no bridge in a test shell */ })
    }
    try {
      load()
    } catch {
      // No bridge, nothing to show.
    }
    // Expiry is time-based: refresh now and then as well as on change.
    const timer = setInterval(load, 60_000)
    const off = mergeGrantsApi.onChanged(() => load())
    return () => { cancelled = true; clearInterval(timer); off() }
  }, [])

  useEffect(() => {
    let cancelled = false
    try {
      escalationApi.listHeld()
        .then((list) => { if (!cancelled) setHeld(list ?? []) })
        .catch(() => { /* the bridge may be absent in a test shell */ })
    } catch {
      // Same: no bridge, nothing to show.
    }
    const off = escalationApi.onHeldChanged((event) => setHeld(event?.held ?? []))
    return () => { cancelled = true; off() }
  }, [])

  useEffect(() => { if (held.length === 0 && grants.length === 0) setOpen(false) }, [held.length, grants.length])

  if (held.length === 0 && grants.length === 0) return null

  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? 'Project'

  const revokeGrant = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      const result = await mergeGrantsApi.revoke(id)
      if (!result.ok) throw new Error(result.error || 'Could not revoke the merge grant')
      setGrants((list) => list.filter((grant) => grant.id !== id))
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not revoke the merge grant')
    } finally {
      setBusy(null)
    }
  }

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
    <div className="relative" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); triggerRef.current?.focus() }
    }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
      <button
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium cursor-pointer ${held.length > 0 ? 'text-amber-700 hover:bg-amber-500/10 dark:text-amber-400' : 'text-muted-foreground hover:bg-muted'}`}
        title={held.length > 0 ? 'Captain actions waiting for your approval' : 'Active merge grants'}
        aria-label={[
          held.length > 0 ? `${held.length} Captain action${held.length !== 1 ? 's' : ''} waiting for approval` : '',
          grants.length > 0 ? `${grants.length} active merge grant${grants.length !== 1 ? 's' : ''}` : ''
        ].filter(Boolean).join(', ')}
        aria-expanded={open}
      >
        {held.length > 0 ? <ShieldAlert className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
        {held.length > 0 && `${held.length} waiting for approval`}
        {held.length > 0 && grants.length > 0 && ' · '}
        {grants.length > 0 && `${grants.length} merge grant${grants.length !== 1 ? 's' : ''}`}
      </button>
      {open && (
        <div
          ref={dialogRef}
          id={dialogId}
          tabIndex={-1}
          role="dialog"
          aria-label="Captain approvals and merge grants"
          className="absolute bottom-full right-0 z-50 mb-2 max-h-[70vh] overflow-y-auto w-96 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-card p-2 text-xs text-foreground shadow-lg"
        >
          {error && <p role="alert" className="mb-2 text-destructive">{error}</p>}
          {held.length > 0 && (
            <p className="mb-2 px-1 text-[11px] text-muted-foreground">
              The project’s escalation policy asks you before these run. Approve runs the call; Reject drops it and tells the Captain.
            </p>
          )}
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
          {grants.length > 0 && (
            <>
              <p className="mb-2 mt-2 px-1 text-[11px] text-muted-foreground">
                Merge grants you gave: the Captain merges covered PRs without asking, once checks and branch protection pass. Revoke stops it at once.
              </p>
              <ul className="space-y-1.5" aria-label="Active merge grants">
                {grants.map((grant) => (
                  <li key={grant.id} className="flex items-start gap-2 rounded-md border border-border/60 bg-background px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium" title={describeMergeGrant(grant)}>{describeMergeGrant(grant)}</div>
                      <div className="truncate text-[10px] italic text-muted-foreground" title={grant.user_text}>“{grant.user_text}”</div>
                      <div className="text-[10px] text-muted-foreground">{projectName(grant.project_id)} · {grant.uses}{grant.max_uses !== null ? `/${grant.max_uses}` : ''} used</div>
                    </div>
                    <button
                      type="button"
                      disabled={busy === grant.id}
                      onClick={() => void revokeGrant(grant.id)}
                      className="flex items-center gap-1 rounded px-1.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50 cursor-pointer"
                      title="Revoke this merge grant"
                      aria-label={`Revoke merge grant: ${describeMergeGrant(grant)}`}
                    >
                      <X className="h-3.5 w-3.5" /> Revoke
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
