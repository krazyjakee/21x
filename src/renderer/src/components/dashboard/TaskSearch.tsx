import { useId, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useProjectTasks } from '@/hooks/use-project-tasks'
import { matchesTaskSearch } from '@/lib/task-search'
import { isSnoozed } from '@/lib/utils'
import { useSnoozeTick } from '@/hooks/use-snooze-tick'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { TASK_STATUSES } from '@/types'

export function TaskSearch() {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const tasks = useProjectTasks()
  const selectTask = useTaskStore((s) => s.selectTask)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  useSnoozeTick(tasks)
  const searching = query.trim().length > 0
  const results = useMemo(() => searching
    ? tasks.filter((task) => matchesTaskSearch(task, query))
    : [], [tasks, query, searching])

  return (
    <section aria-label="Task search" className="min-w-0 space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">Find a task</label>
      <div className="relative">
        <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 size-icon-sm text-muted-foreground pointer-events-none" />
        <input
          ref={input}
          id={id}
          type="search"
          data-keyboard-shortcut-search="dashboard"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { setQuery(''); event.stopPropagation() }
            if (event.key === 'ArrowDown' && results.length > 0) {
              event.preventDefault()
              document.getElementById(`${id}-results`)?.querySelector('button')?.focus()
            }
          }}
          placeholder="Search titles, descriptions and labels…"
          aria-controls={searching ? `${id}-results` : undefined}
          className="w-full rounded-lg border border-input bg-card pl-9 pr-10 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
        />
        {query && (
          <button type="button" aria-label="Clear task search" onClick={() => { setQuery(''); input.current?.focus() }}
            className="absolute right-1 top-1/2 -translate-y-1/2 grid size-hit place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <X aria-hidden="true" className="size-icon-sm" />
          </button>
        )}
      </div>
      {searching && (
        <div id={`${id}-results`} className="rounded-lg border border-border bg-card">
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            {results.length === 0 ? 'No matching tasks in this project. Try another title, description or label.' : `${results.length} matching task${results.length === 1 ? '' : 's'}`}
          </p>
          {results.length > 0 && (
            <ul className="max-h-72 overflow-y-auto border-t border-border">
              {results.map((task) => (
                <li key={task.id}>
                  <button type="button" onClick={() => { selectTask(task.id); setSidebarView('tasks') }}
                    className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="min-w-0 flex-1 break-words text-sm font-medium">{task.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {TASK_STATUSES.find((status) => status.value === task.status)?.label ?? task.status}
                      {isSnoozed(task.snoozed_until) && ' · Snoozed'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
