import { useEffect, useState } from 'react'
import { Archive, ArchiveRestore, Pencil, Plus, Search } from 'lucide-react'
import type { CommanderSession } from '@shared/commander'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn, formatRelativeDate } from '@/lib/utils'
import { useCommanderStore } from '@/stores/commander-store'

export const UNTITLED_SESSION = 'New session'

function SessionRow({ session, selected }: { session: CommanderSession; selected: boolean }) {
  const selectSession = useCommanderStore((s) => s.selectSession)
  const renameSession = useCommanderStore((s) => s.renameSession)
  const archiveSession = useCommanderStore((s) => s.archiveSession)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)

  const commit = () => {
    setEditing(false)
    const title = draft.trim()
    if (title && title !== session.title) void renameSession(session.id, title)
  }

  return (
    <li
      className={cn(
        'group relative flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition-colors',
        selected ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
      onClick={() => !editing && void selectSession(session.id)}
    >
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            aria-label="Session title"
            value={draft}
            className="h-7 px-2 text-sm"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setDraft(session.title)
                setEditing(false)
              }
            }}
          />
        ) : (
          <>
            <div className={cn('truncate text-sm', session.unread_count > 0 && 'font-semibold text-foreground')}>
              {session.title || UNTITLED_SESSION}
            </div>
            <div className="text-[11px] text-muted-foreground/70">
              {formatRelativeDate(new Date(session.updated_at).toISOString())}
              {session.archived && ' · archived'}
            </div>
          </>
        )}
      </div>
      {!editing && session.unread_count > 0 && (
        <span
          aria-label={`${session.unread_count} unread`}
          className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground group-hover:hidden"
        >
          {session.unread_count}
        </span>
      )}
      {!editing && (
        <div className="hidden items-center gap-0.5 group-hover:flex">
          <button
            type="button"
            aria-label="Rename session"
            className="grid size-6 place-items-center rounded-md hover:bg-background"
            onClick={(e) => {
              e.stopPropagation()
              setDraft(session.title)
              setEditing(true)
            }}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={session.archived ? 'Unarchive session' : 'Archive session'}
            className="grid size-6 place-items-center rounded-md hover:bg-background"
            onClick={(e) => {
              e.stopPropagation()
              void archiveSession(session.id, !session.archived)
            }}
          >
            {session.archived ? <ArchiveRestore className="size-3.5" aria-hidden="true" /> : <Archive className="size-3.5" aria-hidden="true" />}
          </button>
        </div>
      )}
    </li>
  )
}

/** Session list: new, search, rename, archive, unread badges. */
export function CommanderSessionList() {
  const sessions = useCommanderStore((s) => s.sessions)
  const selectedSessionId = useCommanderStore((s) => s.selectedSessionId)
  const search = useCommanderStore((s) => s.search)
  const setSearch = useCommanderStore((s) => s.setSearch)
  const showArchived = useCommanderStore((s) => s.showArchived)
  const setShowArchived = useCommanderStore((s) => s.setShowArchived)
  const createSession = useCommanderStore((s) => s.createSession)
  const [query, setQuery] = useState(search)

  // Debounced: search runs in main over titles and message text.
  useEffect(() => {
    if (query === search) return
    const timer = setTimeout(() => void setSearch(query), 200)
    return () => clearTimeout(timer)
  }, [query, search, setSearch])

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground">Commander</h2>
        <Button size="sm" variant="ghost" aria-label="New session" onClick={() => void createSession()}>
          <Plus className="size-4" aria-hidden="true" />
          New
        </Button>
      </div>
      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute left-5 top-[calc(50%-4px)] size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          aria-label="Search sessions"
          placeholder="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 pl-7 text-sm"
        />
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2" aria-label="Commander sessions">
        {sessions.map((session) => (
          <SessionRow key={session.id} session={session} selected={session.id === selectedSessionId} />
        ))}
        {sessions.length === 0 && (
          <li className="px-2.5 py-6 text-center text-xs text-muted-foreground/70">
            {search ? 'No sessions match.' : 'No sessions yet.'}
          </li>
        )}
      </ul>
      <label className="flex cursor-pointer items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={showArchived} onChange={(e) => void setShowArchived(e.target.checked)} />
        Show archived
      </label>
    </aside>
  )
}
