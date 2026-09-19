// Durable transcript projection: every transcript part delivered to any client
// is persisted here first. Parts are upserted by (task_id, part_id): streaming
// updates replace the content of an existing part while keeping its position (seq).
import type { DatabaseManager } from '../database'
import { toTranscriptPartRecord, type TranscriptPartRow } from './serializers'
import type { TranscriptPartInput, TranscriptPartRecord } from './types'

/**
 * Upsert a batch of transcript parts for a task inside one transaction.
 * New parts get the next per-task seq; existing parts keep their seq and
 * update content in place (streaming). Re-sending an unchanged part is a
 * no-op: it keeps its rev and is not reported in changedPartIds, so the
 * returned revs stay contiguous (maxRev - changedPartIds.length is the
 * cursor before this batch).
 */
export function upsertTranscriptParts(m: DatabaseManager, taskId: string, parts: TranscriptPartInput[]): { maxRev: number; changedPartIds: string[] } {
  if (!m.db?.open || parts.length === 0) return { maxRev: getTranscriptMaxRev(m, taskId), changedPartIds: [] }

  const nextSeqStmt = m.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM transcript_parts WHERE task_id = ?'
  )
  // created_at carries the part's ORIGINAL time (receivedAt) when known, not
  // the write time. Otherwise a bulk seed/replay (which writes the whole
  // history in one burst) would stamp every row with a near-identical
  // timestamp and destroy the transcript's chronology. On conflict, created_at
  // is preserved (never overwritten by a later reconcile pass).
  // Each inserted or changed row gets a fresh globally-monotonic `rev` so a
  // client can fetch everything changed since its last rev. RETURNING yields
  // no row for an unchanged part, and the stored seq for a changed one.
  const upsertStmt = m.prepare(`
    INSERT INTO transcript_parts (task_id, part_id, seq, role, content, part_type, tool, payload, created_at, updated_at, rev)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch('subsec') * 1000, ?)
    ON CONFLICT(task_id, part_id) DO UPDATE SET
      content = excluded.content,
      part_type = COALESCE(excluded.part_type, transcript_parts.part_type),
      tool = COALESCE(excluded.tool, transcript_parts.tool),
      payload = COALESCE(excluded.payload, transcript_parts.payload),
      updated_at = excluded.updated_at,
      rev = excluded.rev
    WHERE excluded.content IS NOT transcript_parts.content
       OR COALESCE(excluded.part_type, transcript_parts.part_type) IS NOT transcript_parts.part_type
       OR COALESCE(excluded.tool, transcript_parts.tool) IS NOT transcript_parts.tool
       OR COALESCE(excluded.payload, transcript_parts.payload) IS NOT transcript_parts.payload
    RETURNING seq
  `)
  // Served by idx_transcript_parts_rev; runs inside every write transaction.
  const maxRevStmt = m.prepare('SELECT COALESCE(MAX(rev), 0) AS m FROM transcript_parts')

  let maxRev = 0
  const changedPartIds: string[] = []
  const txn = m.db.transaction(() => {
    let nextSeq = (nextSeqStmt.get(taskId) as { next: number }).next
    let rev = (maxRevStmt.get() as { m: number }).m
    const writeNow = Date.now()
    for (const part of parts) {
      if (!part.id) continue
      const written = upsertStmt.get(
        taskId,
        part.id,
        nextSeq,
        part.role || 'system',
        part.content || '',
        part.partType ?? null,
        part.tool != null ? JSON.stringify(part.tool) : null,
        part.payload != null ? JSON.stringify(part.payload) : null,
        typeof part.receivedAt === 'number' ? part.receivedAt : writeNow,
        rev + 1
      ) as { seq: number } | undefined
      if (!written) continue
      // Existing rows keep an older seq, so only an insert consumes nextSeq.
      if (written.seq === nextSeq) nextSeq++
      rev += 1
      changedPartIds.push(part.id)
    }
    maxRev = rev
  })
  // Reserve the WAL writer slot before reading seq/rev. A deferred
  // transaction can take a read snapshot while another connection is
  // writing, then fail immediately with SQLITE_BUSY when it tries to upgrade
  // that stale snapshot. BEGIN IMMEDIATE lets busy_timeout wait for the
  // writer and only calculates the counters after the lock is acquired.
  txn.immediate()
  return { maxRev, changedPartIds }
}

/**
 * All parts for a task whose rev > sinceRev, ordered chronologically: new
 * parts and streaming updates alike. maxRev is the client's next cursor.
 */
export function getTranscriptDelta(m: DatabaseManager, taskId: string, sinceRev: number): { parts: TranscriptPartRecord[]; maxRev: number } {
  if (!m.db?.open) return { parts: [], maxRev: sinceRev }
  const rows = m.prepare(
    'SELECT * FROM transcript_parts WHERE task_id = ? AND rev > ? ORDER BY created_at ASC, seq ASC'
  ).all(taskId, sinceRev) as TranscriptPartRow[]
  const maxRow = m.prepare('SELECT COALESCE(MAX(rev), ?) AS m FROM transcript_parts WHERE task_id = ?').get(sinceRev, taskId) as { m: number }
  return { parts: rows.map(toTranscriptPartRecord), maxRev: maxRow.m }
}

export function getTranscriptMaxRev(m: DatabaseManager, taskId: string): number {
  if (!m.db?.open) return 0
  const row = m.prepare('SELECT COALESCE(MAX(rev), 0) AS m FROM transcript_parts WHERE task_id = ?').get(taskId) as { m: number }
  return row.m
}

/** Ordered transcript for a task, optionally only parts after seq. */
export function getTranscriptParts(m: DatabaseManager, taskId: string, sinceSeq?: number): TranscriptPartRecord[] {
  if (!m.db?.open) return []
  // Order by REAL event time (created_at), with seq as a stable tiebreaker.
  // Insertion order (seq) is not chronological when a partial projection is
  // later backfilled with older history.
  const rows = (sinceSeq != null
    ? m.prepare('SELECT * FROM transcript_parts WHERE task_id = ? AND seq > ? ORDER BY created_at ASC, seq ASC').all(taskId, sinceSeq)
    : m.prepare('SELECT * FROM transcript_parts WHERE task_id = ? ORDER BY created_at ASC, seq ASC').all(taskId)
  ) as TranscriptPartRow[]
  return rows.map(toTranscriptPartRecord)
}

export interface TranscriptPageQuery {
  /** Without it only user and assistant text parts are read. */
  includeTools: boolean
  role: string | null
  /** Only parts with a lower seq. */
  beforeSeq: number | null
  limit: number
}

/**
 * One page of a task's transcript, newest seq first, plus how many parts
 * match the filter overall (ignoring `beforeSeq`). Filtering, ordering and
 * the limit run in SQL so a long transcript is never loaded to serve a page.
 */
export function getTranscriptPage(m: DatabaseManager, taskId: string, query: TranscriptPageQuery): { parts: TranscriptPartRecord[]; total: number } {
  if (!m.db?.open) return { parts: [], total: 0 }
  const clauses = ['task_id = ?']
  const params: (string | number)[] = [taskId]
  if (!query.includeTools) {
    clauses.push("role IN ('user', 'assistant') AND (part_type IS NULL OR part_type IN ('', 'text'))")
  }
  if (query.role) {
    clauses.push('role = ?')
    params.push(query.role)
  }
  const where = clauses.join(' AND ')
  const { n } = m.prepare(`SELECT COUNT(*) AS n FROM transcript_parts WHERE ${where}`).get(...params) as { n: number }

  const take = Math.trunc(query.limit)
  if (take <= 0 || Number.isNaN(query.beforeSeq)) return { parts: [], total: n }
  const before = query.beforeSeq === null ? '' : ' AND seq < ?'
  const rows = m.prepare(
    `SELECT * FROM transcript_parts WHERE ${where}${before} ORDER BY seq DESC, created_at ASC LIMIT ?`
  ).all(...params, ...(query.beforeSeq === null ? [] : [query.beforeSeq]), take) as TranscriptPartRow[]
  return { parts: rows.map(toTranscriptPartRecord), total: n }
}

export function hasTranscriptParts(m: DatabaseManager, taskId: string): boolean {
  if (!m.db?.open) return false
  return !!m.prepare('SELECT 1 FROM transcript_parts WHERE task_id = ? LIMIT 1').get(taskId)
}

export function deleteTranscriptParts(m: DatabaseManager, taskId: string): void {
  if (!m.db?.open) return
  m.prepare('DELETE FROM transcript_parts WHERE task_id = ?').run(taskId)
}
