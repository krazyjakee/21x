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
  /** What the key that came just before this `change` was. The list's own keys never reach here. */
  const stepping = useRef(false)

  // A move from elsewhere replaces whatever was being stepped to.
  useEffect(() => { setStepped(null) }, [currentId])

  const commit = (): void => {
    stepping.current = false
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
    } else {
      // Space and Alt open the list, as the arrow keys do on macOS. Decided on
      // every key: nothing here is told when a list is dismissed, so the next
      // key after that must still count as a step.
      stepping.current = stepsClosedSelect(event) && !event.altKey && platform !== 'darwin'
    }
  }

  return (
    <select
      value={stepped ?? currentId}
      onChange={(event) => {
        if (stepping.current) {
          setStepped(event.target.value)
          return
        }
        // A choice from the list ends any stepping, even a choice of the current project.
        setStepped(null)
        onChoose(event.target.value)
      }}
      onKeyDown={onKeyDown}
      onMouseDown={() => { stepping.current = false }}
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
