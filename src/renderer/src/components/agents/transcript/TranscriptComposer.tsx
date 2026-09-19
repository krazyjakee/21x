import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { FileText, Paperclip, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { VoiceMicButton } from '@/components/voice/VoiceMicButton'
import { voiceApi } from '@/lib/ipc-client'
import { dispatchShortcutFeedback } from '@/lib/keyboard-shortcuts'
import { CAPTAIN_COMPOSER_KEY, registerComposer } from '@/lib/voice-dictation-target'
import { formatFileSize } from '@/lib/utils'
import { AttachmentTray } from '@/components/chat/AttachmentTray'
import { useChatAttachments } from '@/hooks/use-chat-attachments'
import type { ChatImageInput } from '@shared/chat-images'

export interface ComposerAttachment {
  id: string
  filename: string
  size: number
  mime_type: string
}

export type SendHandler = (message: string, options?: { attachments?: ComposerAttachment[] }) => void | Promise<void>

/** Stores pasted images (#144) and returns them as attachments for the message. */
export type SaveImagesHandler = (images: ChatImageInput[]) => Promise<ComposerAttachment[]>

/** An agent needs words; a message of images alone still says what it carries. */
export function imageOnlyMessage(count: number): string {
  return count === 1 ? 'See the attached image.' : 'See the attached images.'
}

export const IMAGES_UNSUPPORTED_HERE = 'Images can only be attached in a task’s chat.'

interface TranscriptComposerProps {
  onSend: SendHandler
  onPickAttachments?: () => Promise<ComposerAttachment[]>
  onAddAttachmentPaths?: (filePaths: string[]) => Promise<ComposerAttachment[]>
  /** Without it, pasted images are refused with a message and text pastes as usual. */
  onSaveImages?: SaveImagesHandler
  taskId?: string
  isStarting: boolean
}

function mergeAttachments(current: ComposerAttachment[], added: ComposerAttachment[]): ComposerAttachment[] {
  const seen = new Set(current.map((attachment) => attachment.id))
  const merged = [...current]
  for (const item of added) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
}

export function TranscriptComposer({ onSend, onPickAttachments, onAddAttachmentPaths, onSaveImages, taskId, isStarting }: TranscriptComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachment[]>([])
  const images = useChatAttachments({ unsupportedReason: onSaveImages ? null : IMAGES_UNSUPPORTED_HERE })
  const [isDragOver, setIsDragOver] = useState(false)

  /**
   * Announce this composer for as long as it is on screen.
   *
   * Starting an agent session rebuilds this panel, so a conversation must find
   * the new text field and the new send function. The key stays the same across
   * that rebuild, and the callbacks are read through a ref, so a conversation
   * carries on into the panel that replaced this one.
   */
  const composerKey = taskId ?? CAPTAIN_COMPOSER_KEY
  const sendRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    return registerComposer(composerKey, {
      getField: () => inputRef.current,
      submit: () => sendRef.current?.(),
      sendMessage: (message) => onSend(message),
    })
  }, [composerKey, onSend])

  const autoResize = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px` // max ~6 lines
  }, [])

  const handleSend = () => {
    const typed = inputRef.current?.value.trim() ?? ''
    const imagesAtSend = images.attachments
    if (images.isReading || (!typed && imagesAtSend.length === 0)) return
    const value = typed || imageOnlyMessage(imagesAtSend.length)
    // Whatever answer was expected by voice is not the answer that is now
    // coming, so it is dropped and this reply is not read aloud. A spoken
    // sentence goes through here too and arms a fresh expectation of its own
    // straight afterwards, so the conversation loop is unaffected.
    void voiceApi.answerNotExpected(taskId)
    const attachmentsAtSend = pendingAttachments
    const imageInputs = images.toInputs()
    // Images are stored first (as task attachments), then go with the message
    // like any other attachment.
    const sent = (async () => {
      const savedImages = imageInputs.length > 0 && onSaveImages ? await onSaveImages(imageInputs) : []
      const all = mergeAttachments(attachmentsAtSend, savedImages)
      return onSend(value, all.length > 0 ? { attachments: all } : undefined)
    })()
    inputRef.current!.value = ''
    inputRef.current!.style.height = 'auto'
    setPendingAttachments([])
    images.clear()
    // The composer clears the text before the send resolves, so a rejected
    // send used to leave no trace at all — no message, no session, no error.
    // The text goes back into the box and the failure is announced.
    void Promise.resolve(sent).catch((error: unknown) => {
      console.error('[AgentTranscriptPanel] Message send failed:', error)
      if (inputRef.current && !inputRef.current.value) inputRef.current.value = typed
      setPendingAttachments(attachmentsAtSend)
      images.restore(imagesAtSend)
      const detail = error instanceof Error && error.message ? error.message.trim() : String(error ?? '').trim()
      // Surface the real failure (e.g. provider "name must be at most 64
      // characters") instead of a generic "session did not start" — the text
      // is restored above so nothing is lost and the user can retry.
      const feedback = detail && detail !== 'No taskId'
        ? `Could not send the message — ${detail.slice(0, 280)}`
        : 'Could not send the message — the agent session did not start'
      dispatchShortcutFeedback(feedback, true)
    })
  }
  // The registration calls through this ref, so a conversation always uses the
  // send function of the current render, never one captured earlier.
  sendRef.current = handleSend

  const addAttachments = (added: ComposerAttachment[]) => {
    if (added.length) setPendingAttachments((prev) => mergeAttachments(prev, added))
  }

  const handlePickAttachments = async () => {
    if (onPickAttachments) addAttachments(await onPickAttachments())
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!onAddAttachmentPaths || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!onAddAttachmentPaths) return
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setIsDragOver(false)
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    if (!onAddAttachmentPaths) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const filePaths = Array.from(e.dataTransfer.files)
      .map((file) => window.electronAPI.webUtils.getPathForFile(file))
      .filter(Boolean)
    if (filePaths.length > 0) addAttachments(await onAddAttachmentPaths(filePaths))
  }

  return (
    <div
      data-testid="transcript-composer"
      data-voice-composer={composerKey}
      className={`relative px-4 py-3 space-y-2.5 transition-colors ${isDragOver ? 'bg-primary/5' : ''}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border border-dashed border-primary/40 bg-background/90">
          <span className="text-xs font-medium text-primary">Drop files to attach them to this message</span>
        </div>
      )}
      <AttachmentTray controller={images} composerRef={inputRef} />
      {pendingAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pendingAttachments.map((attachment) => (
            <span
              key={attachment.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-foreground"
              title={`${attachment.filename} (${formatFileSize(attachment.size)})`}
            >
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate max-w-[220px]">{attachment.filename}</span>
              <span className="text-muted-foreground">{formatFileSize(attachment.size)}</span>
              <button
                type="button"
                onClick={() => setPendingAttachments((prev) => prev.filter((att) => att.id !== attachment.id))}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${attachment.filename}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          aria-label="Message the agent"
          rows={1}
          disabled={isStarting}
          placeholder={isStarting ? 'Starting agent…' : 'Write a message...'}
          className="flex-1 bg-input border border-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/30 resize-none overflow-hidden max-h-32 min-h-[32px] disabled:opacity-60"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          onInput={autoResize}
          onPaste={images.handlePaste}
        />
        <VoiceMicButton mode="dictation" onSubmit={handleSend} />
        {onPickAttachments && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handlePickAttachments}
            className="h-[32px] w-[32px] shrink-0 rounded-lg"
            title="Attach files"
            aria-label="Attach files"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
        )}
        <Button variant="default" size="icon" onClick={handleSend} className="h-[32px] w-[32px] shrink-0 rounded-lg" aria-label="Send message">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
