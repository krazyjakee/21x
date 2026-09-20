import { useRef, type RefObject } from 'react'
import { AlertCircle, X } from 'lucide-react'
import { formatImageBytes } from '@shared/chat-images'
import { cn } from '@/lib/utils'
import type { ChatAttachmentsController } from '@/hooks/use-chat-attachments'

interface AttachmentTrayProps {
  controller: Pick<ChatAttachmentsController, 'attachments' | 'errors' | 'announcement' | 'isReading' | 'remove' | 'dismissError'>
  /** Where focus goes when the last image is removed: the composer's text field. */
  composerRef?: RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  className?: string
}

/**
 * The image chips above a chat composer (#144): a thumbnail, the file name and
 * size, and a remove button per image; inline validation errors; and a polite
 * live region that announces "Image attached" / "Image removed". The live
 * region is always rendered so screen readers pick up its first message.
 */
export function AttachmentTray({ controller, composerRef, className }: AttachmentTrayProps) {
  const { attachments, errors, announcement, isReading, remove, dismissError } = controller
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  const dismissButtons = useRef(new Map<string, HTMLButtonElement>())

  const handleRemove = (id: string) => {
    const index = attachments.findIndex((a) => a.id === id)
    const neighbour = attachments[index + 1] ?? attachments[index - 1]
    remove(id)
    // Keep keyboard users in the tray while images remain, then return to the text.
    if (neighbour) removeButtons.current.get(neighbour.id)?.focus()
    else composerRef?.current?.focus()
  }

  const hasContent = attachments.length > 0 || errors.length > 0 || isReading

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="chat-attachment-announcer">
        {announcement && <span key={announcement.key}>{announcement.text}</span>}
      </div>
      {hasContent && (
        <div className={cn('space-y-1.5', className)} data-testid="chat-attachment-tray">
          {(attachments.length > 0 || isReading) && (
            <ul aria-label="Attached images" className="flex flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  data-testid="chat-attachment-chip"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 py-1 pl-1 pr-2 text-[11px] text-foreground"
                  title={`${attachment.name} (${formatImageBytes(attachment.size)})`}
                >
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="size-8 shrink-0 rounded object-cover"
                    draggable={false}
                  />
                  <span className="max-w-[160px] truncate">{attachment.name}</span>
                  <span className="text-muted-foreground">{formatImageBytes(attachment.size)}</span>
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) removeButtons.current.set(attachment.id, el)
                      else removeButtons.current.delete(attachment.id)
                    }}
                    onClick={() => handleRemove(attachment.id)}
                    className="rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Remove image ${attachment.name}`}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
              {isReading && (
                <li className="inline-flex items-center rounded-md border border-dashed border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
                  Reading image…
                </li>
              )}
            </ul>
          )}
          {errors.length > 0 && (
            <ul role="alert" className="space-y-1">
              {errors.map((error, index) => (
                <li key={error} className="flex items-start gap-1.5 text-[11px] text-destructive">
                  <AlertCircle className="mt-px size-3 shrink-0" aria-hidden="true" />
                  <span className="flex-1">{error}</span>
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) dismissButtons.current.set(error, el)
                      else dismissButtons.current.delete(error)
                    }}
                    onClick={() => {
                      const neighbour = errors[index + 1] ?? errors[index - 1]
                      dismissError(index)
                      if (neighbour) dismissButtons.current.get(neighbour)?.focus()
                      else composerRef?.current?.focus()
                    }}
                    className="rounded text-destructive/70 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Dismiss message"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  )
}
