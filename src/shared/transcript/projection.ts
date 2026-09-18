import type { AgentMessage, TranscriptPartRecord } from './types'

// Per-task cache of the durable transcript, keyed by stable part id, with the
// render order kept incrementally. Deltas are idempotent by id and ordering is
// by (createdAt, seq), so reordering, duplication and collapse are structurally
// impossible — no dedup sets, no accumulation, no clear/replay.
export interface TranscriptProjection {
  parts: Map<string, TranscriptPartRecord>
  /** `parts` values ordered by (createdAt, seq); maintained in place per delta. */
  sorted: TranscriptPartRecord[]
  rev: number
}

function comparePart(a: TranscriptPartRecord, b: TranscriptPartRecord): number {
  return (a.createdAt - b.createdAt) || (a.seq - b.seq)
}

// New parts almost always belong at the end, so scan backwards from the tail.
function insertSorted(sorted: TranscriptPartRecord[], part: TranscriptPartRecord): void {
  let index = sorted.length
  while (index > 0 && comparePart(sorted[index - 1], part) > 0) index -= 1
  sorted.splice(index, 0, part)
}

export function createProjection(parts: TranscriptPartRecord[] = [], rev = 0): TranscriptProjection {
  const map = new Map(parts.map((part) => [part.partId, part]))
  return { parts: map, sorted: [...map.values()].sort(comparePart), rev }
}

export function applyPartsToProjection(projection: TranscriptProjection, parts: TranscriptPartRecord[], maxRev?: number): void {
  for (const part of parts) {
    const previous = projection.parts.get(part.partId)
    // `rev` is a monotonic change cursor. A recovery read can return a row
    // older than one a live event already delivered; never let it win.
    if (previous && part.rev < previous.rev) continue
    projection.parts.set(part.partId, part)
    if (previous) {
      // Streaming updates hit recent parts, so search from the end.
      const index = projection.sorted.lastIndexOf(previous)
      if (index !== -1 && comparePart(previous, part) === 0) {
        projection.sorted[index] = part
        continue
      }
      if (index !== -1) projection.sorted.splice(index, 1)
    }
    insertSorted(projection.sorted, part)
  }
  if (typeof maxRev === 'number') projection.rev = Math.max(projection.rev, maxRev)
}

// Unchanged parts keep their exact record reference across deltas, so reusing
// the derived AgentMessage preserves object identity and lets memoized rows
// skip re-rendering the whole transcript on every streamed delta. Entries are
// GC'd with their part records.
const messageCache = new WeakMap<TranscriptPartRecord, AgentMessage>()

function toAgentMessage(part: TranscriptPartRecord): AgentMessage {
  const cached = messageCache.get(part)
  if (cached) return cached
  const payload = (part.payload || {}) as { taskProgress?: unknown }
  const message: AgentMessage = {
    id: part.partId,
    role: part.role === 'user' ? 'user' : part.role === 'assistant' ? 'assistant' : 'system',
    content: part.content,
    timestamp: new Date(part.createdAt),
    partType: part.partType,
    // `tool` already carries nested questions/todos as persisted by write-through.
    tool: part.tool as AgentMessage['tool'],
    taskProgress: payload.taskProgress as AgentMessage['taskProgress']
  }
  messageCache.set(part, message)
  return message
}

export function projectMessages(projection: TranscriptProjection | undefined): AgentMessage[] {
  return projection ? projection.sorted.map(toAgentMessage) : []
}
