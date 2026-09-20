import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { CommanderSessionList } from './CommanderSessionList'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/** Focus-contained session picker. Closing it restores focus to the opener. */
export function CommanderSessionDrawer({
  open,
  onClose,
  returnFocus
}: {
  open: boolean
  onClose: () => void
  returnFocus: React.RefObject<HTMLButtonElement | null>
}) {
  const drawerRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return undefined
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        returnFocus.current?.focus()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...(drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, returnFocus])

  if (!open) return null

  const close = (): void => {
    onClose()
    window.setTimeout(() => returnFocus.current?.focus(), 0)
  }

  return (
    <div className="absolute inset-0 z-40 flex" data-testid="commander-sessions-drawer">
      <button
        type="button"
        aria-label="Close sessions"
        className="absolute inset-0 bg-black/35 backdrop-blur-[1px]"
        onClick={close}
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="commander-sessions-title"
        className="relative z-10 flex h-full w-[min(22rem,88vw)] flex-col border-r border-border bg-sidebar shadow-2xl"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
          <h2 id="commander-sessions-title" className="text-sm font-semibold">Sessions</h2>
          <Button ref={closeRef} size="icon" variant="ghost" aria-label="Close sessions drawer" onClick={close}>
            <X className="size-4" aria-hidden="true" />
          </Button>
        </header>
        <CommanderSessionList onSelected={close} />
      </div>
    </div>
  )
}
