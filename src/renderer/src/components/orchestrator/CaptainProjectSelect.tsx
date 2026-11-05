import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { platform } from '@/lib/platform'
import type { ProjectRecord } from '@shared/projects'

interface CaptainProjectSelectProps {
  projects: ProjectRecord[]
  currentId: string
  onChoose: (projectId: string) => void
  /** Off while the drawer is closed but still mounted. */
  tabbable: boolean
}

/** Keys that step through a closed select. Enter, Escape, Tab and Space are not among them. */
function stepsClosedSelect(event: KeyboardEvent): boolean {
  return event.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key) ||
    (event.key.length === 1 && event.key !== ' ')
}

/**
 * The project control of the Captain column.
 *
 * A closed select fires `change` for every arrow press, and changing project
 * clears the selected task and can end AutoRun, so stepping past a project must
 * not visit it. Keyboard steps only move the highlight, and the choice applies on
 * Enter or on leaving the control. Escape puts it back. Choosing from the open
 * list is one decision and applies at once.
 */
export function CaptainProjectSelect({ projects, currentId, onChoose, tabbable }: CaptainProjectSelectProps) {
  const [stepped, setStepped] = useState<string | null>(null)
  const stepping = useRef(false)
  const listOpen = useRef(false)

  // A move from elsewhere replaces whatever was being stepped to.
  useEffect(() => { setStepped(null) }, [currentId])

  const commit = (): void => {
    stepping.current = false
    listOpen.current = false
    if (stepped && stepped !== currentId) onChoose(stepped)
    setStepped(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLSelectElement>): void => {
    if (event.key === 'Enter' && stepped) {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape' && stepped) {
      // Cancels the step, not whatever else Escape would close.
      event.stopPropagation()
      stepping.current = false
      setStepped(null)
    } else if (event.key === ' ' || event.altKey || platform === 'darwin') {
      // These open the list: on macOS the arrow keys do too.
      listOpen.current = true
      stepping.current = false
    } else if (!listOpen.current) {
      stepping.current = stepsClosedSelect(event)
    }
  }

  return (
    <select
      value={stepped ?? currentId}
      onChange={(event) => {
        listOpen.current = false
        if (stepping.current) setStepped(event.target.value)
        else onChoose(event.target.value)
      }}
      onKeyDown={onKeyDown}
      onMouseDown={() => { listOpen.current = true; stepping.current = false }}
      onBlur={commit}
      tabIndex={tabbable ? undefined : -1}
      aria-label="Captain project"
      data-testid="captain-project"
      className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/80 bg-background border border-border rounded px-2 py-1 cursor-pointer hover:border-primary/50 focus:border-ring focus:ring-2 focus:ring-ring/20 transition-colors"
    >
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  )
}
