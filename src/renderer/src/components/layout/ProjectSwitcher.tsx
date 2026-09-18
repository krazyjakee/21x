import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, FolderKanban, Plus, Settings2, Search } from 'lucide-react'
import { useProjectStore, activeProjects } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { useCurrentProject } from '@/hooks/use-project-tasks'
import { SettingsTab } from '@/types'
import { cn } from '@/lib/utils'
import { modKey } from '@/lib/platform'

/**
 * The current-project picker in the top bar. Opens from a click, from
 * Mod+P, or from the command palette (both set `projectSwitcherOpen`).
 * Archived projects are never offered.
 */
export function ProjectSwitcher() {
  const projects = useProjectStore((s) => s.projects)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const current = useCurrentProject()
  const open = useUIStore((s) => s.projectSwitcherOpen)
  const setOpen = useUIStore((s) => s.setProjectSwitcherOpen)
  const openProjectEditor = useUIStore((s) => s.openProjectEditor)
  const openSettings = useUIStore((s) => s.openSettings)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const options = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = activeProjects(projects)
    return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list
  }, [projects, query])

  useEffect(() => {
    if (!open) return undefined
    setQuery('')
    setActive(Math.max(0, activeProjects(projects).findIndex((p) => p.id === currentProjectId)))
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
    // Only on open: re-running on every project change would reset the highlight.
  }, [open])

  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, options.length - 1))) }, [options.length])

  const choose = (id: string) => {
    setCurrentProject(id)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const pick = options[active]; if (pick) choose(pick.id) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
  }

  const manage = () => {
    setOpen(false)
    setSettingsTab(SettingsTab.PROJECTS)
    openSettings()
  }

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        onClick={() => setOpen(!open)}
        title={`Switch project (${modKey}P)`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-7 max-w-[200px] items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-foreground/90 transition-colors hover:bg-accent cursor-pointer"
      >
        <FolderKanban className="size-icon-sm shrink-0 text-muted-foreground" />
        <span className="truncate">{current?.name ?? 'Default'}</span>
        <ChevronDown className="size-icon-xs shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Switch project"
          onKeyDown={onKeyDown}
          className="absolute left-0 top-full z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-pop animate-in fade-in-0 zoom-in-95"
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-icon-sm shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Switch project…"
              aria-label="Filter projects"
              className="h-9 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
          <div role="listbox" aria-label="Projects" className="max-h-72 overflow-y-auto p-1">
            {options.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">No matching projects</div>
            )}
            {options.map((project, i) => (
              <button
                key={project.id}
                role="option"
                aria-selected={project.id === currentProjectId}
                data-active={i === active}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(project.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors cursor-pointer',
                  i === active ? 'bg-accent text-foreground' : 'text-foreground/85'
                )}
              >
                <span className="flex-1 truncate">{project.name}</span>
                {project.id === currentProjectId && <Check className="size-icon-sm shrink-0 text-primary" />}
              </button>
            ))}
          </div>
          <div className="border-t border-border p-1">
            <button
              onClick={() => openProjectEditor('new')}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <Plus className="size-icon-sm" /> New project…
            </button>
            <button
              onClick={manage}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <Settings2 className="size-icon-sm" /> Manage projects…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
