import { writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { validateChatImageInputs } from '../../shared/chat-images'
import type { FileAttachmentRecord } from '../database'

/**
 * Pasted images on a task chat (#144) become ordinary task attachments. The
 * agent adapters take text prompts, and every coding agent can open an image
 * file from its workspace (Claude Code's Read tool, Codex's image viewer), so
 * the existing attachment path (copied into `<workspace>/attachments` and
 * listed in the prompt) carries them without adapter changes.
 */

export interface TaskImageStore {
  getTask(taskId: string): { attachments?: FileAttachmentRecord[] } | undefined | null
  getAttachmentsDir(taskId: string): string
  updateTask(taskId: string, data: { attachments: FileAttachmentRecord[] }): unknown
}

/** `name.png`, or `name-2.png` … when the task already has an attachment called that. */
export function uniqueAttachmentName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

export async function saveImagesAsTaskAttachments(
  db: TaskImageStore,
  taskId: string,
  rawImages: unknown
): Promise<{ saved: FileAttachmentRecord[]; attachments: FileAttachmentRecord[] }> {
  if (typeof taskId !== 'string' || !taskId) throw new Error('taskId is required')
  const task = db.getTask(taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  const images = validateChatImageInputs(rawImages)
  const existing = task.attachments ?? []
  const taken = new Set(existing.map((attachment) => attachment.filename))
  const dir = db.getAttachmentsDir(taskId)
  const saved: FileAttachmentRecord[] = []
  for (const image of images) {
    const id = randomUUID()
    const filename = uniqueAttachmentName(image.name, taken)
    taken.add(filename)
    await writeFile(join(dir, `${id}-${filename}`), Buffer.from(image.data, 'base64'))
    saved.push({ id, filename, size: image.size, mime_type: image.mimeType, added_at: new Date().toISOString() })
  }
  // Re-read: another attachment may have landed while the files were written.
  const current = db.getTask(taskId)?.attachments ?? existing
  const attachments = [...current, ...saved]
  if (saved.length > 0) db.updateTask(taskId, { attachments })
  return { saved, attachments }
}
