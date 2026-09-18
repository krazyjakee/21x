/**
 * Reading and writing the CLI config files the global MCP manager touches.
 *
 * Every write goes through `writeFileAtomic` so a crash mid-write cannot leave
 * `~/.claude.json` or `config.toml` half-written, and every read returns a
 * fingerprint so a caller can tell whether the file changed since the UI
 * loaded it.
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'fs'
import { dirname, join } from 'path'

export interface FileSnapshot {
  path: string
  exists: boolean
  content: string
  /** sha256 of the content, or "missing" when the file does not exist. */
  hash: string
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function readFileSnapshot(path: string): FileSnapshot {
  if (!existsSync(path)) return { path, exists: false, content: '', hash: 'missing' }
  const content = readFileSync(path, 'utf-8')
  return { path, exists: true, content, hash: hashContent(content) }
}

/** One fingerprint for a set of files, stable across the order they are given in. */
export function combineFingerprints(snapshots: FileSnapshot[]): string {
  const parts = [...snapshots]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((snapshot) => `${snapshot.path}\0${snapshot.hash}`)
  return hashContent(parts.join('\n'))
}

/**
 * Writes via a sibling temp file and rename. The original file's mode is kept
 * (Claude Code and Codex config files are commonly 0600 because they hold
 * tokens next to MCP servers).
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  let mode: number | undefined
  try {
    mode = statSync(path).mode & 0o777
  } catch {
    mode = undefined
  }
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.20x-tmp`)
  writeFileSync(tmp, content, 'utf-8')
  if (mode !== undefined) {
    try { chmodSync(tmp, mode) } catch {}
  }
  renameSync(tmp, path)
}

/** Detects the indentation used by a JSON document (default two spaces). */
export function detectJsonIndent(content: string): string | number {
  const match = /\n([ \t]+)"/.exec(content)
  if (!match) return 2
  return match[1].includes('\t') ? '\t' : match[1].length
}

/**
 * Strips `//` and `/* *\/` comments and trailing commas so a JSONC file
 * (OpenCode accepts `opencode.jsonc`) can be handed to JSON.parse. Strings
 * are respected, so a URL containing `//` survives.
 */
export function stripJsonComments(input: string): { text: string; hadComments: boolean } {
  let out = ''
  let hadComments = false
  let i = 0
  let inString = false
  while (i < input.length) {
    const ch = input[i]
    const next = input[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < input.length) {
        out += next
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      hadComments = true
      while (i < input.length && input[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      hadComments = true
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  // Trailing commas before a closing bracket/brace.
  const text = out.replace(/,(\s*[}\]])/g, '$1')
  return { text, hadComments: hadComments || text !== out }
}

export interface JsonDocument {
  value: Record<string, unknown>
  indent: string | number
  trailingNewline: boolean
  hadComments: boolean
}

/** Parses a JSON/JSONC object document, keeping enough to write it back in the same style. */
export function parseJsonDocument(content: string): JsonDocument {
  if (!content.trim()) {
    return { value: {}, indent: 2, trailingNewline: true, hadComments: false }
  }
  const { text, hadComments } = stripJsonComments(content)
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object at the top level')
  }
  return {
    value: parsed as Record<string, unknown>,
    indent: detectJsonIndent(content),
    trailingNewline: content.endsWith('\n'),
    hadComments
  }
}

export function serializeJsonDocument(doc: JsonDocument): string {
  const text = JSON.stringify(doc.value, null, doc.indent)
  return doc.trailingNewline ? `${text}\n` : text
}
