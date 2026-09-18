import { join } from 'path'
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'fs'
import type { DatabaseManager } from '../database'

export interface MessageAttachmentRef {
  id: string
  filename: string
  size: number
  mime_type: string
}

const MAX_LISTED_ATTACHMENTS = 10
const MAX_PREVIEWS = 3
const MAX_PREVIEW_FILE_SIZE = 24 * 1024
const MAX_PREVIEW_CHARS = 1200
const TEXT_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.csv', '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rb', '.rs', '.sql']

/**
 * Copies task attachments from DB storage into `<workspace>/attachments` and
 * returns prompt references ("- attachments/file.pdf"). Always overwrites, so
 * repeated calls are cheap and guarantee freshness.
 */
export function syncAttachmentsToWorkspace(db: DatabaseManager, taskId: string, workspaceDir: string): string[] {
  const task = db.getTask(taskId)
  const refs: string[] = []
  if (!task?.attachments?.length) return refs

  const attachDir = db.getAttachmentsDir(taskId)
  const destDir = join(workspaceDir, 'attachments')
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

  for (const att of task.attachments) {
    const srcPath = join(attachDir, `${att.id}-${att.filename}`)
    if (!existsSync(srcPath)) continue
    try {
      copyFileSync(srcPath, join(destDir, att.filename))
      refs.push(`- attachments/${att.filename}`)
    } catch {
      continue
    }
  }
  return refs
}

function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isTextAttachment(mimeType: string, filename: string): boolean {
  if (mimeType.startsWith('text/')) return true
  const lower = filename.toLowerCase()
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Appends attachment references, loading guidance and small text previews to the prompt. */
export function buildMessageWithAttachmentContext(
  workspaceDir: string | undefined,
  message: string,
  attachments?: MessageAttachmentRef[]
): string {
  if (!attachments || attachments.length === 0) return message

  const capped = attachments.slice(0, MAX_LISTED_ATTACHMENTS)
  const omittedCount = attachments.length - capped.length
  const refs = capped.map(
    (att) => `- attachments/${att.filename} (${att.mime_type || 'application/octet-stream'}, ${formatAttachmentSize(att.size)})`
  )

  const previewBlocks: string[] = []
  if (workspaceDir) {
    for (const att of capped) {
      if (previewBlocks.length >= MAX_PREVIEWS) break
      if (!isTextAttachment(att.mime_type || '', att.filename)) continue
      if (att.size > MAX_PREVIEW_FILE_SIZE) continue

      const absPath = join(workspaceDir, 'attachments', att.filename)
      if (!existsSync(absPath)) continue

      try {
        const text = readFileSync(absPath, 'utf-8')
        const truncated = text.slice(0, MAX_PREVIEW_CHARS)
        const suffix = text.length > MAX_PREVIEW_CHARS ? '\n...[truncated]' : ''
        previewBlocks.push(`### attachments/${att.filename}\n\`\`\`\n${truncated}${suffix}\n\`\`\``)
      } catch {
        continue
      }
    }
  }

  let attachmentContext = '\n\nMessage attachments (already available in your workspace):\n'
  attachmentContext += refs.join('\n')
  if (omittedCount > 0) {
    attachmentContext += `\n- ... and ${omittedCount} more attachment(s) omitted to keep context focused`
  }
  attachmentContext += '\n\nContext loading guidance:'
  attachmentContext += '\n- Start with only the listed files relevant to the user request.'
  attachmentContext += '\n- Do not load full file contents unless necessary.'
  attachmentContext += '\n- For large/binary files, inspect metadata or selective excerpts first.'

  if (previewBlocks.length > 0) {
    attachmentContext += '\n\nSmall text previews (use only if relevant):\n'
    attachmentContext += previewBlocks.join('\n\n')
  }

  return `${message}${attachmentContext}`
}

/** The user-facing version of a message: just the attachment file names. */
export function buildDisplayMessage(message: string, attachments?: MessageAttachmentRef[]): string {
  if (!attachments || attachments.length === 0) return message
  const capped = attachments.slice(0, MAX_LISTED_ATTACHMENTS)
  const omittedCount = attachments.length - capped.length
  const refs = capped.map((att) => `- ${att.filename}`)
  const omitted = omittedCount > 0 ? `\n- ... and ${omittedCount} more` : ''
  return `${message}\n\nAttached to this message:\n${refs.join('\n')}${omitted}`
}
