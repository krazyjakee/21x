import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronUp, Pencil, Plus } from 'lucide-react'
import { Markdown } from './Markdown'

const LINE_HEIGHT_PX = 20 // approximate line height for sm markdown text
const STORAGE_KEY_PREFIX = '20x-desc-expanded-'

// Touch screens have no hover, so the mobile app shows the edit control all
// the time and gives buttons a pressed state and bigger hit areas.
const VARIANT_CLASSES = {
  desktop: {
    cancel: 'text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer px-2 py-1',
    save: 'text-xs bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1 cursor-pointer disabled:opacity-60',
    placeholder: 'flex items-center gap-1.5 text-xs text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer',
    wrapper: 'group relative',
    editableContent: 'cursor-text rounded-md hover:bg-accent/30 -mx-2 px-2 py-1',
    editTrigger: 'absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer'
  },
  touch: {
    cancel: 'text-xs text-muted-foreground active:opacity-60 px-3 py-1.5 rounded-md hover:bg-accent disabled:opacity-50',
    save: 'text-xs bg-primary text-primary-foreground hover:bg-primary/90 active:opacity-60 rounded-md px-3 py-1.5 disabled:opacity-60',
    placeholder: 'flex items-center gap-1.5 text-xs text-muted-foreground/70 hover:text-foreground active:opacity-60',
    wrapper: 'relative',
    editableContent: 'cursor-text rounded-md active:bg-accent/30',
    editTrigger: 'absolute top-0 right-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent active:opacity-60'
  }
}

interface CollapsibleDescriptionProps {
  taskId: string
  description: string
  size?: 'xs' | 'sm' | 'base'
  className?: string
  /**
   * When provided, the description becomes inline-editable. Clicking the
   * description (or the "Add description" placeholder when empty) enters
   * edit mode; Save commits the new value via this callback.
   */
  onSave?: (description: string) => void | Promise<void>
  /** Placeholder shown when description is empty and `onSave` is provided. */
  placeholder?: string
  /** Maximum preview lines before showing the expand control. */
  collapsedLines?: number
  variant?: keyof typeof VARIANT_CLASSES
}

export function CollapsibleDescription({
  taskId,
  description,
  size = 'sm',
  className,
  onSave,
  placeholder = 'Add description...',
  collapsedLines = 5,
  variant = 'desktop'
}: CollapsibleDescriptionProps) {
  const classes = VARIANT_CLASSES[variant]
  const contentRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [needsCollapse, setNeedsCollapse] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(description)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_PREFIX + taskId) === '1'
    } catch {
      return false
    }
  })

  const editable = typeof onSave === 'function'
  const collapsedMaxHeight = Math.max(1, collapsedLines) * LINE_HEIGHT_PX

  const measureContent = useCallback(() => {
    if (contentRef.current) {
      const scrollHeight = contentRef.current.scrollHeight
      setNeedsCollapse(scrollHeight > collapsedMaxHeight + 8) // 8px tolerance
    }
  }, [collapsedMaxHeight])

  useEffect(() => {
    measureContent()
  }, [description, measureContent])

  // Re-measure on window resize (fonts may reflow)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    window.addEventListener('resize', measureContent)
    return () => window.removeEventListener('resize', measureContent)
  }, [measureContent])

  // The artifact split can resize without a browser-window resize. Observe the
  // content itself so newly wrapped lines immediately gain a Show less/more
  // control as the Details pane narrows.
  useEffect(() => {
    if (isEditing || !contentRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureContent)
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [isEditing, measureContent])

  // Keep draft in sync with prop when not editing (e.g., external updates)
  useEffect(() => {
    if (!isEditing) setDraft(description)
  }, [description, isEditing])

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
    }
  }, [isEditing])

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev
      try {
        if (next) {
          localStorage.setItem(STORAGE_KEY_PREFIX + taskId, '1')
        } else {
          localStorage.removeItem(STORAGE_KEY_PREFIX + taskId)
        }
      } catch { /* ignore storage errors */ }
      return next
    })
  }, [taskId])

  const beginEdit = useCallback(() => {
    if (!editable) return
    setDraft(description)
    setIsEditing(true)
  }, [editable, description])

  const cancelEdit = useCallback(() => {
    setDraft(description)
    setIsEditing(false)
  }, [description])

  const commitEdit = useCallback(async () => {
    if (!onSave) return
    const next = draft.trim() === '' ? '' : draft
    if (next === description) {
      setIsEditing(false)
      return
    }
    setSaving(true)
    try {
      await onSave(next)
      setIsEditing(false)
    } catch (err) {
      console.error('[CollapsibleDescription] Failed to save description:', err)
      // Stay in edit mode so the user can retry or cancel
    } finally {
      setSaving(false)
    }
  }, [draft, description, onSave])

  const isCollapsed = needsCollapse && !expanded

  if (isEditing) {
    return (
      <div className={className} data-testid="description-edit-form">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              cancelEdit()
            } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void commitEdit()
            }
          }}
          rows={Math.min(12, Math.max(4, draft.split('\n').length + 1))}
          placeholder={placeholder}
          disabled={saving}
          className="w-full min-h-[96px] rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring/30 resize-y disabled:opacity-60"
          data-testid="description-edit-textarea"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancelEdit}
            disabled={saving}
            className={classes.cancel}
            data-testid="description-edit-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commitEdit}
            disabled={saving}
            className={classes.save}
            data-testid="description-edit-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    )
  }

  // Empty + editable: show "Add description" placeholder
  if (editable && !description) {
    return (
      <button
        type="button"
        onClick={beginEdit}
        className={`${className ?? ''} ${classes.placeholder}`}
        data-testid="description-add-placeholder"
      >
        <Plus className="h-3 w-3" />
        {placeholder}
      </button>
    )
  }

  return (
    <div className={className}>
      <div className={classes.wrapper}>
        <div
          ref={contentRef}
          className={`overflow-hidden transition-all duration-200 ${editable ? classes.editableContent : ''}`}
          style={isCollapsed ? { maxHeight: `${collapsedMaxHeight}px` } : undefined}
          onClick={editable ? beginEdit : undefined}
          role={editable ? 'button' : undefined}
          tabIndex={editable ? 0 : undefined}
          onKeyDown={editable ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              beginEdit()
            }
          } : undefined}
          data-testid={editable ? 'description-editable-content' : undefined}
        >
          <Markdown size={size}>{description}</Markdown>
        </div>
        {editable && (
          <button
            type="button"
            onClick={beginEdit}
            className={classes.editTrigger}
            aria-label="Edit description"
            title="Edit description"
            data-testid="description-edit-trigger"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {needsCollapse && (
        <button
          onClick={toggleExpanded}
          className="flex items-center gap-1 mt-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              Show more
            </>
          )}
        </button>
      )}
    </div>
  )
}
