import { captureDesktopRead, getDesktopHost } from './desktop-api'
import { attachmentApi, type TaskUpdatePrecondition } from './ipc-client'
import type { FileAttachment } from '@/types'

export const ATTACHMENT_IMPORT_FAILURE = 'Some files could not be attached. Check the current attachments before choosing files again.'
export const NATIVE_FILE_DROP_MESSAGE = 'Use Add files to choose files in this preview.'

/** Paths identify private picker selections; they do not grant native file access. */
export async function importTaskAttachments(taskId: string, paths: string[], isCurrent: () => boolean = () => true): Promise<{ saved: FileAttachment[]; incomplete: boolean }> {
  if (getDesktopHost().kind !== 'tauri') {
    return { saved: await Promise.all(paths.map(path => attachmentApi.save(taskId, path))), incomplete: false }
  }
  const scope = captureDesktopRead()
  const saved: FileAttachment[] = []
  // Source admits one mutation at a time. Preserve accepted receipts if a later
  // selection fails, and never replay a consumed or uncertain selection.
  for (const path of paths) {
    try {
      scope.assertCurrent()
      if (!isCurrent()) return { saved, incomplete: true }
      saved.push(await attachmentApi.save(taskId, path))
    } catch { return { saved, incomplete: true } }
  }
  return { saved, incomplete: false }
}

export function mergeTaskAttachments(current: FileAttachment[], saved: FileAttachment[]): FileAttachment[] {
  const seen = new Set(current.map(item => item.id))
  const merged = [...current]
  for (const item of saved) {
    if (seen.has(item.id)) continue
    seen.add(item.id); merged.push(item)
  }
  return merged
}


/** The baseline is the exact observed array used to construct a replacement. */
export function copyAttachmentBaseline(records: readonly FileAttachment[]): FileAttachment[] {
  return records.map(({ id, filename, size, mime_type, added_at }) => ({ id, filename, size, mime_type, added_at }))
}
export function attachmentPrecondition(baseline?: readonly FileAttachment[]): TaskUpdatePrecondition {
  if (getDesktopHost().kind !== 'tauri') return undefined
  if (!baseline) throw new Error(ATTACHMENT_IMPORT_FAILURE)
  return { attachmentsBaseline: copyAttachmentBaseline(baseline) }
}
