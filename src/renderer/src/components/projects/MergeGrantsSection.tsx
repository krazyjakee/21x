import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import { mergeGrantsApi } from '@/lib/ipc-client'
import { formatRelativeDate } from '@shared/date-format'
import { describeMergeGrant, mergeGrantSettingsFrom, type MergeGrantAuditEntry } from '@shared/merge-grants'

/**
 * Merge grants (#137) in the project editor: the per-project switch (a key
 * of the settings JSON, saved with the draft) and, for a saved project, the
 * audit log: every grant, who gave it and in which words, its scope and
 * status, with each merge made under it (PR, SHA, checks). Active grants are
 * revoked in one click, at once (not with the draft).
 */
export function MergeGrantsSection({
  projectId,
  settings,
  onEnabledChange
}: {
  projectId: string | null
  settings: Record<string, unknown>
  onEnabledChange: (enabled: boolean) => void
}) {
  const enabled = mergeGrantSettingsFrom(settings).enabled
  const [audit, setAudit] = useState<MergeGrantAuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!projectId) return
    mergeGrantsApi.audit(projectId).then(setAudit).catch(() => setAudit([]))
  }, [projectId])

  useEffect(() => {
    load()
    return mergeGrantsApi.onChanged((event) => { if (event?.projectId === projectId) load() })
  }, [load, projectId])

  const revoke = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      const result = await mergeGrantsApi.revoke(id)
      if (!result.ok) throw new Error(result.error || 'Could not revoke the merge grant')
      load()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not revoke the merge grant')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-3" aria-label="Merge grants">
      <div>
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Merge grants</h3>
        <p className="text-xs text-muted-foreground">
          Let the Captain merge pull requests you told it to merge, without asking again for each one. Type a separate instruction such as “Merge PR #12 when checks pass”. Ambiguous or quoted instructions are refused.
          A grant covers this project only and lasts at most 7 days. Checks, required reviews and branch protection still apply; nothing is ever bypassed.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          aria-label="Allow merge grants for this project"
        />
        Allow merge grants for this project
      </label>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {projectId && audit.length > 0 && (
        <ul className="space-y-2" aria-label="Merge grant audit log">
          {audit.map(({ grant, status, uses }) => (
            <li key={grant.id} className="rounded-md border border-border/60 bg-background px-2.5 py-2 text-xs">
              <div className="flex items-start gap-2">
                <ShieldCheck className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium">{describeMergeGrant(grant)}</div>
                  <blockquote className="border-l-2 border-border pl-2 italic text-muted-foreground" title="The user’s words, verbatim">“{grant.user_text}”</blockquote>
                  <div className="text-[10px] text-muted-foreground">
                    Granted by you in the {grant.source === 'commander' ? 'Commander chat' : 'project chat'} · {formatRelativeDate(grant.created_at)} · message {grant.source_message_id}
                    {' · '}{status}{grant.revoked_at ? ` ${formatRelativeDate(grant.revoked_at)} by ${grant.revoked_by ?? 'user'}` : ''}
                    {' · '}{grant.uses}{grant.max_uses !== null ? `/${grant.max_uses}` : ''} merge{grant.uses === 1 ? '' : 's'}
                  </div>
                  {uses.length > 0 && (
                    <ul className="space-y-0.5 pt-1" aria-label="Merges under this grant">
                      {uses.map((use) => (
                        <li key={use.id} className="text-[10px] text-muted-foreground">
                          <a href={use.pr_url} target="_blank" rel="noreferrer" className="underline">{use.pr_url.replace('https://github.com/', '')}</a>
                          {use.pr_title ? ` “${use.pr_title}”` : ''} · {use.head_sha.slice(0, 7)} → {use.base_branch || '?'} · {use.method}
                          {' · '}{use.merge_state}{use.review_decision ? `, review ${use.review_decision.toLowerCase()}` : ''}
                          {' · checks: '}{use.checks.length === 0 ? 'none reported' : use.checks.map((c) => `${c.name} ${c.state}`).join(', ')}
                          {' · '}{formatRelativeDate(use.merged_at)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {status === 'active' && (
                  <button
                    type="button"
                    disabled={busy === grant.id}
                    onClick={() => void revoke(grant.id)}
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50 cursor-pointer"
                    aria-label={`Revoke merge grant: ${describeMergeGrant(grant)}`}
                  >
                    <X className="h-3.5 w-3.5" /> Revoke
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {projectId && audit.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No merge grants yet.</p>
      )}
    </section>
  )
}
