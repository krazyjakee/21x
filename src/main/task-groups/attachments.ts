import { basename, join } from 'node:path'
import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { DatabaseManager } from '../database'

/** Member IDs and attachment IDs namespace equal filenames. Source ownership
 * remains with each member; shared workspace copies are disposable. */
export function groupAttachmentReferences(db: DatabaseManager, taskId: string): string[] {
  const group = db.getTaskGroupByTask(taskId)
  if (!group || group.execution_task_id !== taskId) return []
  return db.getTaskGroupMembers(group.id).flatMap(member => member.attachments.map(attachment =>
    `- Task ${member.id}: attachments/task-${member.id}/${attachment.id}-${basename(attachment.filename)}`))
}

export function syncGroupAttachments(db: DatabaseManager, taskId: string, workspaceDir: string): string[] {
  const group = db.getTaskGroupByTask(taskId)
  if (!group || group.execution_task_id !== taskId) return []
  const references: string[] = []
  const directory = (path: string): void => {
    if (existsSync(path)) {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The shared attachment directory must be an ordinary directory.')
    } else mkdirSync(path)
  }
  for (const member of db.getTaskGroupMembers(group.id)) {
    for (const attachment of member.attachments) {
      if (!/^[a-zA-Z0-9_-]+$/.test(member.id) || !/^[a-zA-Z0-9_-]+$/.test(attachment.id)
        || basename(attachment.filename) !== attachment.filename || /[\\/]/.test(attachment.filename))
        throw new Error('A group member attachment has an invalid saved path.')
      const source = join(db.getAttachmentsDir(member.id), `${attachment.id}-${attachment.filename}`)
      const relative = `attachments/task-${member.id}/${attachment.id}-${attachment.filename}`
      if (!existsSync(source) || lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile())
        throw new Error(`Attachment ${attachment.filename} for task ${member.id} is unavailable. Restore or remove it before starting the group.`)
      directory(join(workspaceDir, 'attachments'))
      const destinationDir = join(workspaceDir, 'attachments', `task-${member.id}`)
      directory(destinationDir)
      const temporary = join(destinationDir, `.21x-copy-${randomUUID()}`)
      try {
        copyFileSync(source, temporary)
        renameSync(temporary, join(destinationDir, `${attachment.id}-${attachment.filename}`))
      } finally { rmSync(temporary, { force: true }) }
      references.push(`- Task ${member.id}: ${relative}`)
    }
  }
  return references
}
