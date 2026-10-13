import type Database from 'better-sqlite3'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { compactionFingerprint } from './compaction'

export interface MemoryEntry {
  handoffId: string
  ownerId: string
  generationKey: string
  nextGenerationKey: string
  createdAt: number
  summary: unknown
}
export const COMMANDER_MEMORY_KEY = 'sessions.commander_memory'

interface FileSnapshot { content: string; mode: number; exists: boolean }
function readRegular(path: string): FileSnapshot {
  let stat: Stats
  try { stat = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', mode: 0o600, exists: false }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Memory target must be a regular file: ${path}`)
  return { content: readFileSync(path, 'utf8'), mode: stat.mode & 0o777, exists: true }
}
function verifyJournalParent(path: string): void {
  let stat: Stats
  try { stat = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The .21x session journal parent must be a real directory. Existing files were preserved.')
}
function atomicWrite(path: string, content: string, expected: FileSnapshot, verifyParent?: () => void): void {
  verifyParent?.()
  mkdirSync(dirname(path), { recursive: true })
  verifyParent?.()
  const temporary = `${path}.21x-${randomUUID()}.tmp`
  try {
    const handle = openSync(temporary, 'wx', expected.mode)
    try { writeFileSync(handle, content); fsyncSync(handle) } finally { closeSync(handle) }
    verifyParent?.()
    const current = readRegular(path)
    if (current.exists !== expected.exists || current.content !== expected.content || current.mode !== expected.mode) {
      throw new Error(`Memory changed during the write. Existing content was preserved: ${path}`)
    }
    renameSync(temporary, path)
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function memoryMarkers(ownerId: string): { start: string; end: string } {
  const identity = compactionFingerprint(ownerId)
  return { start: `<!-- 21x:memory:start:${identity} -->`, end: `<!-- 21x:memory:end:${identity} -->` }
}

/** Replace exactly the caller's owned block. Every byte before and after it
 * is retained, including CRLF and other owners' blocks. Malformed ownership
 * markers fail safely rather than swallowing user text. */
export function updateMemoryBlock(original: string, ownerId: string, content: string): string {
  const { start, end } = memoryMarkers(ownerId)
  const opening = original.indexOf(start)
  const closing = original.indexOf(end)
  const quoted = content.replaceAll(start, '&lt;' + start.slice(1)).replaceAll(end, '&lt;' + end.slice(1))
  const block = `${start}\n${quoted}\n${end}`
  if (opening < 0 && closing < 0) return original + (original && !original.endsWith('\n') ? '\n' : '') + block + '\n'
  if (opening < 0 || closing < opening || original.indexOf(start, opening + start.length) >= 0 || original.indexOf(end, closing + end.length) >= 0) {
    throw new Error('The 21x MEMORY.md block has ambiguous or incomplete markers. Existing memory was preserved.')
  }
  return original.slice(0, opening) + block + original.slice(closing + end.length)
}

/** Both writes are individually atomic and retryable. A crash between memory
 * and journal writes retries the same block and appends the journal only once. */
export function writeWorkspaceMemory(workspaceDir: string, entry: MemoryEntry): void {
  const memoryPath = join(workspaceDir, 'MEMORY.md')
  const journalPath = join(workspaceDir, '.21x', 'session-journal.jsonl')
  const verifyParent = (): void => verifyJournalParent(dirname(journalPath))
  verifyParent()
  const memory = readRegular(memoryPath)
  const journal = readRegular(journalPath)
  const records = journal.content.split('\n').filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line) as MemoryEntry } catch { throw new Error('The session journal is malformed. Existing journal was preserved.') }
  })
  const existing = records.find((record) => record.handoffId === entry.handoffId)
  if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error('A handoff journal entry already exists with different content.')
  const next = updateMemoryBlock(memory.content, entry.ownerId, `# Session handoff\n\n${JSON.stringify(entry, null, 2)}`)
  if (next !== memory.content) atomicWrite(memoryPath, next, memory)
  if (!existing) {
    atomicWrite(journalPath, journal.content + (journal.content && !journal.content.endsWith('\n') ? '\n' : '') + JSON.stringify(entry) + '\n', journal, verifyParent)
  }
}

export function readCommanderMemory(db: Database.Database): MemoryEntry[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(COMMANDER_MEMORY_KEY) as { value: string } | undefined
  if (!row) return []
  const document = JSON.parse(row.value) as { version: number; entries: MemoryEntry[] }
  if (document.version !== 1 || !Array.isArray(document.entries)) throw new Error('Commander memory is malformed; existing memory was preserved.')
  return document.entries
}

/** One global DB record shared by all Commander conversations. Entries and
 * their journal identities are retained; a retry never adds another copy. */
export function writeCommanderMemory(db: Database.Database, entry: MemoryEntry): void {
  db.transaction(() => {
    const entries = readCommanderMemory(db)
    const existing = entries.find((value) => value.handoffId === entry.handoffId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error('Commander handoff memory identity changed.')
      return
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(COMMANDER_MEMORY_KEY, JSON.stringify({ version: 1, entries: [...entries, entry] }))
  })()
}
