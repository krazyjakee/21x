/**
 * A minimal TOML reader/writer for the `[mcp_servers.*]` tables of Codex's
 * `config.toml`.
 *
 * There is no TOML dependency in the project, and a full parser is more than
 * this needs: the manager only reads and rewrites MCP server tables. Every
 * other line in the file — other tables, comments, blank lines — is carried
 * through byte-for-byte. Inside a server table, keys whose values this parser
 * does not understand (dates, nested arrays of tables) are kept as raw lines
 * and re-emitted unchanged, so an unknown Codex option is never lost.
 */

export type TomlScalar = string | number | boolean
export type TomlValue = TomlScalar | TomlValue[] | { [key: string]: TomlValue }

export interface TomlMcpServerTable {
  name: string
  /** Parsed `key = value` pairs, including subtables (`env`, `http_headers`). */
  values: Record<string, TomlValue>
  /**
   * Lines inside the server's tables that could not be parsed, with the
   * subtable they came from (`[]` = the server table itself); re-emitted verbatim.
   */
  rawLines: Array<{ path: string[]; line: string }>
}

export interface TomlMcpDocument {
  lines: string[]
  servers: Map<string, TomlMcpServerTable>
  /** Line spans [start, end) per server, in file order. */
  spans: Map<string, Array<[number, number]>>
}

// ── Value parsing ───────────────────────────────────────────────────────

class TomlValueParser {
  private pos = 0
  constructor(private readonly text: string) {}

  parseAll(): TomlValue {
    this.skipWs()
    const value = this.parseValue()
    this.skipWs()
    if (this.pos !== this.text.length) throw new Error(`Unexpected trailing input: ${this.text.slice(this.pos)}`)
    return value
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos++
      } else if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++
      } else {
        break
      }
    }
  }

  private parseValue(): TomlValue {
    const ch = this.text[this.pos]
    if (ch === '"') return this.parseBasicString()
    if (ch === "'") return this.parseLiteralString()
    if (ch === '[') return this.parseArray()
    if (ch === '{') return this.parseInlineTable()
    if (this.text.startsWith('true', this.pos)) { this.pos += 4; return true }
    if (this.text.startsWith('false', this.pos)) { this.pos += 5; return false }
    const numMatch = /^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|inf|nan)/.exec(this.text.slice(this.pos))
    if (numMatch) {
      const raw = numMatch[0]
      this.pos += raw.length
      const next = this.text[this.pos]
      // A date/time (1979-05-27T07:32:00Z) starts like a number; refuse it so it stays raw.
      if (next === '-' || next === ':' || next === 'T') throw new Error('Date/time values are not supported')
      const cleaned = raw.replace(/_/g, '')
      if (cleaned === 'inf' || cleaned === '+inf') return Infinity
      if (cleaned === '-inf') return -Infinity
      if (/nan$/.test(cleaned)) return NaN
      if (/^[+-]?0x/.test(cleaned)) return parseInt(cleaned.replace(/^([+-]?)0x/, '$1'), 16)
      if (/^[+-]?0o/.test(cleaned)) return parseInt(cleaned.replace(/^([+-]?)0o/, '$1'), 8)
      if (/^[+-]?0b/.test(cleaned)) return parseInt(cleaned.replace(/^([+-]?)0b/, '$1'), 2)
      return Number(cleaned)
    }
    throw new Error(`Unsupported TOML value at: ${this.text.slice(this.pos, this.pos + 20)}`)
  }

  private parseBasicString(): string {
    if (this.text.startsWith('"""', this.pos)) {
      const end = this.text.indexOf('"""', this.pos + 3)
      if (end === -1) throw new Error('Unterminated multi-line string')
      const body = this.text.slice(this.pos + 3, end).replace(/^\r?\n/, '')
      this.pos = end + 3
      return unescapeBasic(body)
    }
    let i = this.pos + 1
    let out = ''
    while (i < this.text.length) {
      const ch = this.text[i]
      if (ch === '\\') {
        const { value, length } = readEscape(this.text, i)
        out += value
        i += length
        continue
      }
      if (ch === '"') {
        this.pos = i + 1
        return out
      }
      if (ch === '\n') throw new Error('Unterminated string')
      out += ch
      i++
    }
    throw new Error('Unterminated string')
  }

  private parseLiteralString(): string {
    if (this.text.startsWith("'''", this.pos)) {
      const end = this.text.indexOf("'''", this.pos + 3)
      if (end === -1) throw new Error('Unterminated multi-line literal string')
      const body = this.text.slice(this.pos + 3, end).replace(/^\r?\n/, '')
      this.pos = end + 3
      return body
    }
    const end = this.text.indexOf("'", this.pos + 1)
    if (end === -1) throw new Error('Unterminated literal string')
    const value = this.text.slice(this.pos + 1, end)
    this.pos = end + 1
    return value
  }

  private parseArray(): TomlValue[] {
    this.pos++ // [
    const items: TomlValue[] = []
    for (;;) {
      this.skipWs()
      if (this.text[this.pos] === ']') { this.pos++; return items }
      items.push(this.parseValue())
      this.skipWs()
      if (this.text[this.pos] === ',') { this.pos++; continue }
      if (this.text[this.pos] === ']') { this.pos++; return items }
      throw new Error('Expected , or ] in array')
    }
  }

  private parseInlineTable(): { [key: string]: TomlValue } {
    this.pos++ // {
    const table: { [key: string]: TomlValue } = {}
    this.skipWs()
    if (this.text[this.pos] === '}') { this.pos++; return table }
    for (;;) {
      this.skipWs()
      const key = this.parseKey()
      this.skipWs()
      if (this.text[this.pos] !== '=') throw new Error('Expected = in inline table')
      this.pos++
      this.skipWs()
      setDotted(table, key, this.parseValue())
      this.skipWs()
      if (this.text[this.pos] === ',') { this.pos++; continue }
      if (this.text[this.pos] === '}') { this.pos++; return table }
      throw new Error('Expected , or } in inline table')
    }
  }

  private parseKey(): string[] {
    const parts: string[] = []
    for (;;) {
      this.skipWs()
      const ch = this.text[this.pos]
      if (ch === '"') parts.push(this.parseBasicString())
      else if (ch === "'") parts.push(this.parseLiteralString())
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.pos))
        if (!match) throw new Error('Expected key')
        parts.push(match[0])
        this.pos += match[0].length
      }
      this.skipWs()
      if (this.text[this.pos] === '.') { this.pos++; continue }
      return parts
    }
  }
}

function readEscape(text: string, i: number): { value: string; length: number } {
  const next = text[i + 1]
  switch (next) {
    case 'n': return { value: '\n', length: 2 }
    case 't': return { value: '\t', length: 2 }
    case 'r': return { value: '\r', length: 2 }
    case 'b': return { value: '\b', length: 2 }
    case 'f': return { value: '\f', length: 2 }
    case '"': return { value: '"', length: 2 }
    case '\\': return { value: '\\', length: 2 }
    case 'u': return { value: String.fromCodePoint(parseInt(text.slice(i + 2, i + 6), 16)), length: 6 }
    case 'U': return { value: String.fromCodePoint(parseInt(text.slice(i + 2, i + 10), 16)), length: 10 }
    default: throw new Error(`Invalid escape \\${next}`)
  }
}

function unescapeBasic(body: string): string {
  let out = ''
  for (let i = 0; i < body.length;) {
    if (body[i] === '\\') {
      // Line-ending backslash trims following whitespace in multi-line strings.
      if (/^\\\r?\n/.test(body.slice(i))) {
        i += 1
        while (i < body.length && /\s/.test(body[i])) i++
        continue
      }
      const { value, length } = readEscape(body, i)
      out += value
      i += length
      continue
    }
    out += body[i]
    i++
  }
  return out
}

function setDotted(target: { [key: string]: TomlValue }, path: string[], value: TomlValue): void {
  let cursor = target
  for (let i = 0; i < path.length - 1; i++) {
    const existing = cursor[path[i]]
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      cursor = existing as { [key: string]: TomlValue }
    } else {
      const created: { [key: string]: TomlValue } = {}
      cursor[path[i]] = created
      cursor = created
    }
  }
  cursor[path[path.length - 1]] = value
}

export function parseTomlValue(text: string): TomlValue {
  return new TomlValueParser(text).parseAll()
}

// ── Line-level structure ────────────────────────────────────────────────

/** `[mcp_servers.name]`, `[mcp_servers."my name".env]`, `[mcp_servers]` … */
function parseTableHeader(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return null
  const close = findClosingBracket(trimmed)
  if (close === -1) return null
  const inner = trimmed.slice(1, close)
  try {
    return parseKeyPath(inner)
  } catch {
    return null
  }
}

function findClosingBracket(text: string): number {
  let inBasic = false
  let inLiteral = false
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]
    if (inBasic) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inBasic = false
      continue
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false
      continue
    }
    if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === ']') return i
  }
  return -1
}

function parseKeyPath(text: string): string[] {
  // Reuse the key parser through a tiny inline table trick: `{ <key> = 0 }`.
  const table = new TomlValueParser(`{ ${text.trim()} = 0 }`).parseAll() as { [key: string]: TomlValue }
  const path: string[] = []
  let cursor: TomlValue = table
  while (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
    const keys = Object.keys(cursor)
    if (keys.length !== 1) break
    path.push(keys[0])
    cursor = (cursor as { [key: string]: TomlValue })[keys[0]]
  }
  return path
}

function isAnyTableHeader(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('[')
}

/**
 * Splits a `key = value` line. Returns null for blank lines, comments and
 * lines that are not assignments. The value text may need continuation lines
 * (multi-line arrays); the caller handles that.
 */
function splitAssignment(line: string): { key: string[]; valueText: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  // Find the first `=` outside quotes.
  let inBasic = false
  let inLiteral = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inBasic) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inBasic = false
      continue
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false
      continue
    }
    if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === '=') {
      try {
        return { key: parseKeyPath(trimmed.slice(0, i)), valueText: trimmed.slice(i + 1) }
      } catch {
        return null
      }
    }
  }
  return null
}

/** Whether brackets/braces are balanced outside of strings and comments. */
function isBalanced(text: string): boolean {
  let depth = 0
  let inBasic = false
  let inLiteral = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inBasic) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inBasic = false
      continue
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false
      continue
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
  }
  return depth <= 0
}

/**
 * Reads the `[mcp_servers.*]` tables from a config.toml. Servers declared as
 * inline tables under a plain `[mcp_servers]` header (`foo = { command = "x" }`)
 * are read too; on write they are moved into their own table.
 */
export function parseTomlMcpDocument(content: string): TomlMcpDocument {
  const lines = content.split('\n')
  const servers = new Map<string, TomlMcpServerTable>()
  const spans = new Map<string, Array<[number, number]>>()

  const ensureServer = (name: string): TomlMcpServerTable => {
    let server = servers.get(name)
    if (!server) {
      server = { name, values: {}, rawLines: [] }
      servers.set(name, server)
    }
    return server
  }

  const addSpan = (name: string, start: number, end: number): void => {
    const list = spans.get(name) ?? []
    list.push([start, end])
    spans.set(name, list)
  }

  let i = 0
  while (i < lines.length) {
    const header = parseTableHeader(lines[i])
    if (!header || header[0] !== 'mcp_servers') {
      i++
      continue
    }

    const start = i
    let end = i + 1
    while (end < lines.length && !isAnyTableHeader(lines[end])) end++
    // Trim trailing blank lines out of the span so a removal keeps spacing tidy
    // but a rewrite of the block still owns them.
    const body = lines.slice(start + 1, end)

    if (header.length === 1) {
      // Plain [mcp_servers]: entries are inline tables, one per server.
      for (let j = 0; j < body.length; j++) {
        const parsed = readAssignment(body, j)
        if (!parsed) continue
        const { key, value, consumed } = parsed
        if (key.length >= 1 && value && typeof value === 'object' && !Array.isArray(value)) {
          const [name, ...rest] = key
          const server = ensureServer(name)
          if (rest.length === 0) Object.assign(server.values, value)
          else setDotted(server.values, rest, value)
          addSpan(name, start + 1 + j, start + 1 + j + consumed)
        } else if (key.length >= 2) {
          const [name, ...rest] = key
          setDotted(ensureServer(name).values, rest, value as TomlValue)
          addSpan(name, start + 1 + j, start + 1 + j + consumed)
        }
        j += consumed - 1
      }
      i = end
      continue
    }

    const name = header[1]
    const subPath = header.slice(2)
    const server = ensureServer(name)
    addSpan(name, start, end)

    for (let j = 0; j < body.length; j++) {
      const line = body[j]
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const parsed = readAssignment(body, j)
      if (!parsed) {
        server.rawLines.push({ path: subPath, line })
        continue
      }
      setDotted(server.values, [...subPath, ...parsed.key], parsed.value)
      j += parsed.consumed - 1
    }
    i = end
  }

  return { lines, servers, spans }
}

/** Parses the assignment starting at `body[index]`, joining continuation lines for multi-line values. */
function readAssignment(body: string[], index: number): { key: string[]; value: TomlValue; consumed: number } | null {
  const split = splitAssignment(body[index])
  if (!split) return null
  let valueText = split.valueText
  let consumed = 1
  while (!isBalanced(valueText) && index + consumed < body.length) {
    valueText += '\n' + body[index + consumed]
    consumed++
  }
  try {
    return { key: split.key, value: parseTomlValue(stripTrailingComment(valueText)), consumed }
  } catch {
    return null
  }
}

function stripTrailingComment(text: string): string {
  // The value parser skips comments itself; this only trims whitespace.
  return text.trim()
}

// ── Writing ─────────────────────────────────────────────────────────────

export function formatTomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `"${escaped}"`
}

export function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : formatTomlString(key)
}

export function formatTomlValue(value: TomlValue): string {
  if (typeof value === 'string') return formatTomlString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan'
    if (value === Infinity) return 'inf'
    if (value === -Infinity) return '-inf'
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(', ')}]`
  const entries = Object.entries(value).map(([k, v]) => `${formatTomlKey(k)} = ${formatTomlValue(v)}`)
  return `{ ${entries.join(', ')} }`
}

/** Renders one server as `[mcp_servers.<name>]` plus one subtable per nested object. */
export function renderTomlMcpServer(server: TomlMcpServerTable): string[] {
  const out: string[] = [`[mcp_servers.${formatTomlKey(server.name)}]`]
  const subtables = new Map<string, { [key: string]: TomlValue }>()
  for (const [key, value] of Object.entries(server.values)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      subtables.set(key, value)
      continue
    }
    out.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`)
  }
  const rawByPath = new Map<string, string[]>()
  for (const raw of server.rawLines) {
    const id = raw.path.join('.')
    rawByPath.set(id, [...(rawByPath.get(id) ?? []), raw.line])
  }
  out.push(...(rawByPath.get('') ?? []))
  const subtableNames = new Set<string>([...subtables.keys(), ...[...rawByPath.keys()].filter(Boolean)])
  for (const key of subtableNames) {
    const table = subtables.get(key) ?? {}
    const raw = rawByPath.get(key) ?? []
    if (Object.keys(table).length === 0 && raw.length === 0) continue
    out.push('')
    out.push(`[mcp_servers.${formatTomlKey(server.name)}.${key.split('.').map(formatTomlKey).join('.')}]`)
    for (const [k, v] of Object.entries(table)) {
      out.push(`${formatTomlKey(k)} = ${formatTomlValue(v)}`)
    }
    out.push(...raw)
  }
  return out
}

/**
 * Returns the document text with `server` written in place of its existing
 * tables (or appended when new). Lines outside the server's spans are untouched.
 */
export function upsertTomlMcpServer(doc: TomlMcpDocument, server: TomlMcpServerTable): string {
  const existing = doc.spans.get(server.name) ?? []
  const block = renderTomlMcpServer(server)
  const lines = [...doc.lines]

  if (existing.length === 0) {
    // Append with one blank separator line; keep a trailing newline.
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length > 0) lines.push('')
    lines.push(...block, '')
    return lines.join('\n')
  }

  const firstStart = Math.min(...existing.map(([start]) => start))
  spliceSpans(lines, existing)
  lines.splice(firstStart, 0, ...block, '')
  return lines.join('\n')
}

export function removeTomlMcpServer(doc: TomlMcpDocument, name: string): string {
  const existing = doc.spans.get(name) ?? []
  if (existing.length === 0) return doc.lines.join('\n')
  const lines = [...doc.lines]
  spliceSpans(lines, existing)
  return lines.join('\n')
}

/**
 * Removes the spans (last first so indices stay valid). A span swallows the
 * blank lines up to the next header, so one blank line is put back whenever
 * the removal would glue two remaining blocks together.
 */
function spliceSpans(lines: string[], spans: Array<[number, number]>): void {
  const sorted = [...spans].sort((a, b) => b[0] - a[0])
  for (const [start, end] of sorted) {
    lines.splice(start, end - start)
    const before = lines[start - 1]
    const after = lines[start]
    if (before !== undefined && after !== undefined && before.trim() !== '' && after.trim() !== '') {
      lines.splice(start, 0, '')
    }
  }
}
