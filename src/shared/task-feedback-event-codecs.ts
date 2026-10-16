import type { DesktopEventMap } from './desktop-operations'
import { isDatabaseId } from './database-desktop-codecs'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const TASK_SOURCE_ACTION_ERROR = 'The task source action failed. Review the task and retry.'
export const MAX_TASK_FEEDBACK_EVENT_BYTES = 2048
export const MAX_TASK_FEEDBACK_TITLE_BYTES = 512
type Event = 'task:checkpointAnswered' | 'task:source-action-failed'
const bounded = (value: JsonValue): boolean => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_TASK_FEEDBACK_EVENT_BYTES
function title(value: unknown, project = false): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 65536 || value.includes('\0')) return undefined
  let result = '', bytes = 0, truncated = false
  for (const character of value) {
    // A lone surrogate is not a Unicode scalar; never let UTF8 replacement
    // create different source/native/page interpretations of the title.
    const point = character.codePointAt(0)!
    if (point >= 0xd800 && point <= 0xdfff) return undefined
    const size = new TextEncoder().encode(character).byteLength
    if (truncated || bytes + size > MAX_TASK_FEEDBACK_TITLE_BYTES) {
      if (!project) return undefined
      truncated = true
      continue
    }
    bytes += size; result += character
  }
  return result.trim() ? result : undefined
}
const checkpoint = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['taskId', 'approved']) && isDatabaseId(value.taskId) && typeof value.approved === 'boolean'
const sourceFailure = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['taskId', 'taskTitle', 'error']) && isDatabaseId(value.taskId) && title(value.taskTitle) !== undefined && value.error === TASK_SOURCE_ACTION_ERROR
function codec<K extends Event>(check: (value: unknown) => boolean, project?: (value: unknown) => unknown) {
  const validatePayload = (value: unknown): value is JsonValue => isJsonValue(value) && check(value) && bounded(value)
  return {
    validatePayload,
    encodePayload(value: unknown): JsonValue {
      const result = project ? project(value) : value
      if (!validatePayload(result)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      return result
    },
    decodePayload(value: JsonValue): DesktopEventMap[K] {
      if (!validatePayload(value)) throw new ServiceProtocolError('INVALID_RESULT')
      return value as unknown as DesktopEventMap[K]
    }
  }
}
export const TASK_FEEDBACK_EVENT_CODECS = {
  'task:checkpointAnswered': codec<'task:checkpointAnswered'>(checkpoint),
  'task:source-action-failed': codec<'task:source-action-failed'>(sourceFailure, value => {
    if (!isRecord(value) || !hasExactKeys(value, ['taskId', 'taskTitle', 'error']) || !isDatabaseId(value.taskId) || typeof value.error !== 'string') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    let projected = title(value.taskTitle, true)
    if (projected === undefined) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const result = { taskId: value.taskId, taskTitle: projected, error: TASK_SOURCE_ACTION_ERROR }
    // JSON escapes control scalars. Raw UTF8 length alone does not bound the
    // actual wire frame; shorten only complete scalars until BOTH caps hold.
    while (!bounded(result)) {
      projected = Array.from(projected).slice(0, -1).join('')
      if (!projected.trim()) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      result.taskTitle = projected
    }
    return result
  })
}
