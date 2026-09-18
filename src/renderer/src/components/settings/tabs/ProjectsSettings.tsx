import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, ChevronDown, Edit3, FolderKanban, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { SettingsSection } from '../SettingsSection'
import { useProjectStore, activeProjects } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { moveItem } from '@/lib/project-editor'
import { DEFAULT_PROJECT_ID, type ProjectRecord } from '@shared/projects'

/** Settings → Projects: create, edit, reorder, archive and restore projects. */
export function ProjectsSettings() {
  const projects = useProjectStore((s) => s.projects)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const fetchProjects = useProjectStore((s) => s.fetchProjects)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const archiveProject = useProjectStore((s) => s.archiveProject)
  const reorderProjects = useProjectStore((s) => s.reorderProjects)
  const error = useProjectStore((s) => s.error)
  const openProjectEditor = useUIStore((s) => s.openProjectEditor)
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => { void fetchProjects() }, [fetchProjects])

  const active = useMemo(() => activeProjects(projects), [projects])
  const archived = useMemo(() => projects.filter((p) => p.archived), [projects])

  const move = (index: number, delta: -1 | 1) => {
    void reorderProjects(moveItem(active, index, delta).map((p) => p.id))
  }

  const row = (project: ProjectRecord, index: number | null) => {
    const isCurrent = project.id === currentProjectId
    const brief = project.description.trim().split('\n')[0]
    return (
      <div key={project.id} className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
        {index !== null ? (
          <div className="flex items-center">
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === 0} onClick={() => move(index, -1)} title="Move up" aria-label={`Move ${project.name} up`}>
              <ArrowUp className="size-icon-xs" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === active.length - 1} onClick={() => move(index, 1)} title="Move down" aria-label={`Move ${project.name} down`}>
              <ArrowDown className="size-icon-xs" />
            </Button>
          </div>
        ) : (
          <Archive className="ml-1 size-icon-sm text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{project.name}</span>
            {isCurrent && <Badge variant="blue">Current</Badge>}
            {project.id === DEFAULT_PROJECT_ID && <Badge>Default</Badge>}
          </div>
          {brief && <p className="mt-0.5 truncate text-xs text-muted-foreground">{brief}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!project.archived && !isCurrent && (
            <Button variant="ghost" size="sm" onClick={() => setCurrentProject(project.id)}>
              Switch to
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => openProjectEditor(project.id)} title="Edit" aria-label={`Edit ${project.name}`}>
            <Edit3 className="h-3.5 w-3.5" />
          </Button>
          {project.id !== DEFAULT_PROJECT_ID && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void archiveProject(project.id, !project.archived)}
              title={project.archived ? 'Restore' : 'Archive'}
              aria-label={project.archived ? `Restore ${project.name}` : `Archive ${project.name}`}
            >
              {project.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <SettingsSection
      title="Projects"
      description="A project groups tasks, task sources and the context agents get: a brief, repos and resources. Archived projects keep their tasks but leave the switcher."
    >
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {active.length} project{active.length !== 1 ? 's' : ''}
          {archived.length > 0 && ` · ${archived.length} archived`}
        </p>
        <Button size="sm" onClick={() => openProjectEditor('new')}>
          <Plus className="h-3.5 w-3.5" />
          New project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {active.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-8 text-center">
          <FolderKanban className="mb-2 h-6 w-6 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">Loading projects…</p>
        </div>
      ) : (
        <div className="space-y-2">{active.map((p, i) => row(p, i))}</div>
      )}

      {archived.length > 0 && (
        <div className="space-y-2 pt-2">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <ChevronDown className={`size-icon-xs transition-transform ${showArchived ? 'rotate-180' : ''}`} />
            Archived ({archived.length})
          </button>
          {showArchived && <div className="space-y-2">{archived.map((p) => row(p, null))}</div>}
        </div>
      )}
    </SettingsSection>
  )
}
