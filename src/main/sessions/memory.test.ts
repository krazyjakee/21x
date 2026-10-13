import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { COMMANDER_MEMORY_KEY, memoryMarkers, readCommanderMemory, updateMemoryBlock, writeCommanderMemory, writeWorkspaceMemory, type MemoryEntry } from './memory'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})

const paths: string[] = []
const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fsyncSync).mockReset().mockImplementation(actual.fsyncSync)
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
  for (const db of databases.splice(0)) db.close()
})
const entry: MemoryEntry = { handoffId: 'handoff-one', ownerId: 'captain', generationKey: 'old', nextGenerationKey: 'next', createdAt: 10, summary: { text: 'Retain completed work' } }
describe('21x-owned long-term memory', () => {
  it('preserves all text outside the exact owned block including CRLF and other owners', () => {
    const marks = memoryMarkers('captain')
    const other = updateMemoryBlock('', 'other', 'Other owner memory')
    const prefix = '# My notes\r\nKeep every byte.\r\n' + other
    const suffix = '\r\nPersonal notes after memory.\r\n'
    const original = prefix + marks.start + '\nold\n' + marks.end + suffix
    const updated = updateMemoryBlock(original, 'captain', 'new')
    expect(updated).toBe(prefix + marks.start + '\nnew\n' + marks.end + suffix)
    expect(updateMemoryBlock(updated, 'captain', 'new')).toBe(updated)
  })
  it('refuses malformed/duplicated markers and quotes marker-shaped model content', () => {
    const marks = memoryMarkers('captain')
    expect(() => updateMemoryBlock('User notes\n' + marks.start, 'captain', 'replacement')).toThrow('preserved')
    expect(() => updateMemoryBlock(marks.start + marks.start + marks.end, 'captain', 'replacement')).toThrow('preserved')
    const updated = updateMemoryBlock('User notes', 'captain', marks.end + '\nUntrusted summary')
    expect(updated.split(marks.end)).toHaveLength(2)
    expect(updated).toContain('&lt;!-- 21x:memory:end:')
  })
  it('retries file memory and journal without duplicate entries or touching user notes', () => {
    const path = mkdtempSync(join(tmpdir(), '21x-memory-')); paths.push(path)
    writeFileSync(join(path, 'MEMORY.md'), '# User notes\r\nPreserve this.\r\n')
    writeWorkspaceMemory(path, entry)
    const first = readFileSync(join(path, 'MEMORY.md'), 'utf8')
    writeWorkspaceMemory(path, entry)
    expect(readFileSync(join(path, 'MEMORY.md'), 'utf8')).toBe(first)
    expect(first.startsWith('# User notes\r\nPreserve this.\r\n')).toBe(true)
    expect(readFileSync(join(path, '.21x', 'session-journal.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(() => writeWorkspaceMemory(path, { ...entry, summary: 'different' })).toThrow('different content')
  })
  it('uses one global Commander record across conversations with idempotent journal identities', () => {
    const db = createPortableTestDb(); databases.push(db)
    writeCommanderMemory(db.db, { ...entry, ownerId: 'conversation-one' })
    writeCommanderMemory(db.db, { ...entry, ownerId: 'conversation-one' })
    writeCommanderMemory(db.db, { ...entry, handoffId: 'handoff-two', ownerId: 'conversation-two' })
    expect(readCommanderMemory(db.db)).toHaveLength(2)
    expect(db.db.prepare('SELECT key FROM settings WHERE key = ?').all(COMMANDER_MEMORY_KEY)).toEqual([{ key: COMMANDER_MEMORY_KEY }])
    expect(() => writeCommanderMemory(db.db, { ...entry, summary: 'different' })).toThrow('identity changed')
  })

  it('preserves a concurrent user edit detected after flushing the temporary memory file', async () => {
    const path = mkdtempSync(join(tmpdir(), '21x-memory-edit-')); paths.push(path)
    const memory = join(path, 'MEMORY.md')
    writeFileSync(memory, '# Original user notes\n')
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fsyncSync).mockImplementationOnce(handle => {
      actual.fsyncSync(handle)
      writeFileSync(memory, '# User edited these notes during the write\r\nKeep the edit.\r\n')
    })
    expect(() => writeWorkspaceMemory(path, entry)).toThrow('changed during the write')
    expect(readFileSync(memory, 'utf8')).toBe('# User edited these notes during the write\r\nKeep the edit.\r\n')
    expect(existsSync(join(path, '.21x', 'session-journal.jsonl'))).toBe(false)
    expect(readdirSync(path).filter(name => name.endsWith('.tmp'))).toEqual([])
    writeWorkspaceMemory(path, entry)
    expect(readFileSync(memory, 'utf8')).toContain('Keep the edit.\r\n')
  })

  it('detects another process creating an initially missing destination', async () => {
    const path = mkdtempSync(join(tmpdir(), '21x-memory-created-')); paths.push(path)
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fsyncSync).mockImplementationOnce(handle => { actual.fsyncSync(handle); writeFileSync(join(path, 'MEMORY.md'), '') })
    expect(() => writeWorkspaceMemory(path, entry)).toThrow('changed during the write')
    expect(readFileSync(join(path, 'MEMORY.md'), 'utf8')).toBe('')
    expect(readdirSync(path).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('preserves a concurrent journal entry instead of replacing the stale journal snapshot', async () => {
    const path = mkdtempSync(join(tmpdir(), '21x-journal-edit-')); paths.push(path)
    writeWorkspaceMemory(path, entry)
    const journal = join(path, '.21x', 'session-journal.jsonl')
    const original = readFileSync(journal, 'utf8')
    const concurrent = { ...entry, handoffId: 'other-process', ownerId: 'other' }
    let injected = false
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fsyncSync).mockImplementation(handle => {
      actual.fsyncSync(handle)
      if (!injected && readdirSync(join(path, '.21x')).some(name => name.endsWith('.tmp'))) {
        injected = true
        writeFileSync(journal, original + JSON.stringify(concurrent) + '\n')
      }
    })
    const next = { ...entry, handoffId: 'second-handoff' }
    expect(() => writeWorkspaceMemory(path, next)).toThrow('changed during the write')
    expect(readFileSync(journal, 'utf8')).toBe(original + JSON.stringify(concurrent) + '\n')
    expect(readdirSync(join(path, '.21x')).filter(name => name.endsWith('.tmp'))).toEqual([])
    writeWorkspaceMemory(path, next)
    expect(readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line).handoffId)).toEqual([entry.handoffId, concurrent.handoffId, next.handoffId])
  })

  it('rejects a linked .21x journal parent before writing any workspace or external content', () => {
    const path = mkdtempSync(join(tmpdir(), '21x-journal-link-')); paths.push(path)
    const external = mkdtempSync(join(tmpdir(), '21x-journal-external-')); paths.push(external)
    writeFileSync(join(path, 'MEMORY.md'), 'User memory stays unchanged\n')
    writeFileSync(join(external, 'session-journal.jsonl'), 'External journal stays unchanged\n')
    symlinkSync(external, join(path, '.21x'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => writeWorkspaceMemory(path, entry)).toThrow('must be a real directory')
    expect(readFileSync(join(path, 'MEMORY.md'), 'utf8')).toBe('User memory stays unchanged\n')
    expect(readFileSync(join(external, 'session-journal.jsonl'), 'utf8')).toBe('External journal stays unchanged\n')
    expect(readdirSync(external)).toEqual(['session-journal.jsonl'])
  })

  it('rejects a non-directory .21x parent and a destination changed into a directory', async () => {
    const path = mkdtempSync(join(tmpdir(), '21x-journal-file-')); paths.push(path)
    writeFileSync(join(path, '.21x'), 'User file')
    expect(() => writeWorkspaceMemory(path, entry)).toThrow('must be a real directory')
    expect(readFileSync(join(path, '.21x'), 'utf8')).toBe('User file')
    rmSync(join(path, '.21x'))
    writeFileSync(join(path, 'MEMORY.md'), 'Original notes')
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fsyncSync).mockImplementationOnce(handle => {
      actual.fsyncSync(handle)
      rmSync(join(path, 'MEMORY.md'))
      mkdirSync(join(path, 'MEMORY.md'))
      writeFileSync(join(path, 'MEMORY.md', 'keep.txt'), 'Created by another process')
    })
    expect(() => writeWorkspaceMemory(path, entry)).toThrow('must be a regular file')
    expect(readFileSync(join(path, 'MEMORY.md', 'keep.txt'), 'utf8')).toBe('Created by another process')
  })
})
