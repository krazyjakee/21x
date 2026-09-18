/**
 * Shared import write path for task-source plugins.
 *
 * Every plugin writes imported items through `upsertSourcedTask` so that all
 * sources follow the same status rule and write with the 'task-source' origin
 * (which DatabaseManager.updateTask requires before a sourced task may close).
 */

import type { CreateTaskData, TaskRecord, UpdateTaskData } from '../database'
import { TaskStatus } from '../../shared/constants'
import type { PluginContext } from './types'

/**
 * Status rule for refreshing an existing imported task.
 *
 * The source decides whether a task is open or closed; 20x owns the workflow
 * state (triaging, agent working, review, ...) while the task is open.
 *
 * - Closed at the source → the local task is completed.
 * - Open at the source and completed locally → the task is reopened as
 *   Not Started. DatabaseManager.updateTask still keeps a task the user closed
 *   only in 20x (`complete_at_source: false`) completed.
 * - Open at the source and open locally → the local status is left alone.
 *
 * Returns the status to write, or undefined to leave the status unchanged.
 */
export function resolveSourcedStatus(
  currentStatus: string | undefined,
  sourceStatus: string | undefined
): string | undefined {
  if (!sourceStatus) return undefined
  if (sourceStatus === TaskStatus.Completed) {
    return currentStatus === TaskStatus.Completed ? undefined : TaskStatus.Completed
  }
  return currentStatus === TaskStatus.Completed ? TaskStatus.NotStarted : undefined
}

export interface UpsertSourcedTaskResult {
  task: TaskRecord
  created: boolean
}

/**
 * Create or refresh the local task for one source item.
 *
 * `fields` holds the values mapped from the source (including its status);
 * `createDefaults` supplies values used only when the task is first created
 * (title fallback, source label, repos, ...). Returns null if creation failed.
 */
export function upsertSourcedTask(
  ctx: PluginContext,
  sourceId: string,
  externalId: string,
  fields: UpdateTaskData,
  createDefaults: Omit<CreateTaskData, 'external_id' | 'source_id'>
): UpsertSourcedTaskResult | null {
  const existing = ctx.db.getTaskByExternalId(sourceId, externalId)

  if (existing) {
    const { status: sourceStatus, ...rest } = fields
    const data: UpdateTaskData = { ...rest }
    const status = resolveSourcedStatus(existing.status, sourceStatus)
    if (status) data.status = status
    const updated = ctx.db.updateTask(existing.id, data, 'task-source')
    return { task: updated ?? existing, created: false }
  }

  const definedFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as UpdateTaskData
  const created = ctx.db.createTask({
    ...createDefaults,
    ...definedFields,
    title: fields.title || createDefaults.title,
    status: fields.status || createDefaults.status || TaskStatus.NotStarted,
    external_id: externalId,
    source_id: sourceId
  } as CreateTaskData)
  return created ? { task: created, created: true } : null
}
