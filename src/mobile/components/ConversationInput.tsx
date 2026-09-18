import { useCallback, useEffect, useState } from 'react'
import { ChatInput, type ChatInputAttachment } from './ChatInput'
import { cn } from '../lib/utils'

interface ConversationInputProps {
  /** Resolves true once the message was delivered; selections are then cleared. */
  onSend: (message: string, options?: { attachments?: ChatInputAttachment[] }) => Promise<boolean>
  disabled: boolean
  placeholder: string
  /** The task's attachments, selectable for the next message. */
  taskAttachments: ChatInputAttachment[]
}

export function ConversationInput({ onSend, disabled, placeholder, taskAttachments }: ConversationInputProps) {
  const [showPicker, setShowPicker] = useState(false)
  const [selected, setSelected] = useState<ChatInputAttachment[]>([])

  useEffect(() => {
    const validIds = new Set(taskAttachments.map((att) => att.id))
    setSelected((prev) => prev.filter((att) => validIds.has(att.id)))
  }, [taskAttachments])

  const toggleAttachment = useCallback((attachment: ChatInputAttachment) => {
    setSelected((prev) => prev.some((att) => att.id === attachment.id)
      ? prev.filter((att) => att.id !== attachment.id)
      : [...prev, attachment])
  }, [])

  const removeAttachment = useCallback((attachmentId: string) => {
    setSelected((prev) => prev.filter((att) => att.id !== attachmentId))
  }, [])

  const handleSend = useCallback(async (message: string, options?: { attachments?: ChatInputAttachment[] }) => {
    if (!(await onSend(message, options))) return
    setSelected([])
    setShowPicker(false)
  }, [onSend])

  return (
    <div className="shrink-0 border-t border-border/50">
      {showPicker && taskAttachments.length > 0 && (
        <div className="border-b border-border/50 px-3 py-2 max-h-40 overflow-y-auto bg-muted/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">Attach files to this message</span>
            <button
              type="button"
              onClick={() => setShowPicker(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Done
            </button>
          </div>
          <div className="space-y-1">
            {taskAttachments.map((attachment) => {
              const checked = selected.some((att) => att.id === attachment.id)
              return (
                <button
                  key={attachment.id}
                  type="button"
                  onClick={() => toggleAttachment(attachment)}
                  className={cn(
                    'w-full text-left rounded-md px-2 py-1.5 border text-xs transition-colors',
                    checked
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border/50 text-muted-foreground hover:text-foreground hover:bg-white/5'
                  )}
                >
                  {attachment.filename}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <ChatInput
        onSend={(message, options) => void handleSend(message, options)}
        disabled={disabled}
        placeholder={placeholder}
        attachments={selected}
        onRemoveAttachment={removeAttachment}
        onOpenAttachmentPicker={taskAttachments.length > 0 ? () => setShowPicker((prev) => !prev) : undefined}
      />
    </div>
  )
}
