import { writeFile, rm } from 'fs/promises'
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
  const portable = (value: string): string => value.normalize('NFC').toLowerCase()
  const used = new Set([...taken].map(portable))
  if (!used.has(portable(name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!used.has(portable(candidate))) return candidate
  }
}

// Serialize this operation per task, so two simultaneous pastes reserve distinct names.
const pendingSaves = new WeakMap<TaskImageStore, Map<string, Promise<unknown>>>()

export async function saveImagesAsTaskAttachments(
  db: TaskImageStore,
  taskId: string,
  rawImages: unknown
): Promise<{ saved: FileAttachmentRecord[]; attachments: FileAttachmentRecord[] }> {
  const images = validateChatImageInputs(rawImages)
  const pending = pendingSaves.get(db) ?? new Map<string, Promise<unknown>>()
  pendingSaves.set(db, pending)
  const previous = pending.get(taskId) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(() => saveValidatedImages(db, taskId, images))
  pending.set(taskId, operation)
  try {
    return await operation
  } finally {
    if (pending.get(taskId) === operation) pending.delete(taskId)
  }
}

async function saveValidatedImages(
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
  const saved: FileAttachmentRecord[] = []
  const written: string[] = []
  try {
    const dir = db.getAttachmentsDir(taskId)
    for (const image of images) {
      const id = randomUUID()
      const filename = uniqueAttachmentName(image.name, taken)
      taken.add(filename)
      const path = join(dir, `${id}-${filename}`)
      // Include the in-progress file: a failed write can still have created it.
      written.push(path)
      await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600, flag: 'wx' })
      saved.push({ id, filename, size: image.size, mime_type: image.mimeType, added_at: new Date().toISOString() })
    }
    // Re-read: a regular attachment may have landed while the files were written.
    const current = db.getTask(taskId)
    if (!current) throw new Error('Task was removed')
    const attachments = [...(current.attachments ?? []), ...saved]
    if (saved.length > 0) db.updateTask(taskId, { attachments })
    return { saved, attachments }
  } catch {
    await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => {})))
    // Filesystem and database errors can expose local paths; keep them out of IPC.
    throw new Error("Couldn't save the images. Try again.")
  }
}
