import { writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { FileAttachmentRecord } from '../database'
import type { PluginContext } from './types'

type SourceAttachment = FileAttachmentRecord & Record<string, unknown>

/**
 * Writes a downloaded file into the task's attachments directory and appends
 * its record to the task. `extra` holds source-specific keys such as the
 * remote URL used for de-duplication on the next sync.
 */
export function saveTaskAttachment(
  ctx: PluginContext,
  taskId: string,
  file: {
    buffer: Buffer
    filename: string
    mimeType: string
    size?: number
    extra?: Record<string, unknown>
    /** Drops existing records this attachment supersedes. */
    replaces?: (existing: SourceAttachment) => boolean
  }
): SourceAttachment {
  const id = randomUUID()
  writeFileSync(join(ctx.db.getAttachmentsDir(taskId), `${id}-${file.filename}`), file.buffer)

  const attachment: SourceAttachment = {
    id,
    filename: file.filename,
    size: file.size || file.buffer.length,
    mime_type: file.mimeType,
    added_at: new Date().toISOString(),
    ...file.extra
  }

  // Re-read so records saved earlier in the same sync (or concurrently) are kept.
  let current = (ctx.db.getTask(taskId)?.attachments ?? []) as SourceAttachment[]
  if (file.replaces) current = current.filter((a) => !file.replaces!(a))
  ctx.db.updateTask(taskId, { attachments: [...current, attachment] })
  return attachment
}
