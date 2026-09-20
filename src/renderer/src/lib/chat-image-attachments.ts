import type { ChatImageInput } from '@shared/chat-images'
import type { ComposerAttachment, SaveImagesHandler } from '@/components/agents/transcript/TranscriptComposer'
import { chatImageApi } from '@/lib/ipc-client'

/**
 * Pasted images on an agent chat (task, canvas transcript, Captain) are
 * stored as attachments of the chat's task (#144): main writes the files,
 * appends them to the task and announces the update, and the agent finds them
 * in `<workspace>/attachments` like any attached file.
 */
export function taskImageSaver(taskId: string): SaveImagesHandler {
  return (images: ChatImageInput[]) => chatImageApi.saveToTask(taskId, images)
}

/**
 * A question or permission answer goes through `approve()`, which takes text
 * only. The attachments are already in the workspace, so the answer names them.
 */
export function withAttachmentNote(message: string, attachments?: ComposerAttachment[]): string {
  if (!attachments?.length) return message
  return `${message}\n\nAttached (in your workspace):\n${attachments.map((a) => `- attachments/${a.filename}`).join('\n')}`
}
