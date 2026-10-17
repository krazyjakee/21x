/** A recent plain-text log, not a screen emulator. Escape parser state and the
 * unfinished line survive PTY callback boundaries; escape bodies are never held. */
export class TerminalTextBuffer {
  private lines: string[] = []
  private partial = ''
  private chars = 0
  private state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' | 'intermediate' = 'text'

  constructor(private readonly maxLines = 500, private readonly maxChars = 1_000_000) {}

  append(raw: string): void {
    let start = 0
    const flush = (end: number) => { if (end > start) this.text(raw.slice(start, end)) }
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i)
      if (this.state === 'text' && (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f) || code === 9 || code === 10)) continue
      flush(i); start = i + 1
      if (code === 0x18 || code === 0x1a) { this.state = 'text'; continue }
      if (this.state === 'string' || this.state === 'string-escape') {
        if (code === 7 || code === 0x9c || this.state === 'string-escape' && code === 0x5c) this.state = 'text'
        else this.state = code === 0x1b ? 'string-escape' : 'string'
      } else if (code === 0x1b) this.state = 'escape'
      else if (code === 0x9b) this.state = 'csi'
      else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) this.state = 'string'
      else if (this.state === 'escape') {
        if (code === 0x5b) this.state = 'csi'
        else if ([0x50, 0x58, 0x5d, 0x5e, 0x5f].includes(code)) this.state = 'string'
        else if (code >= 0x20 && code <= 0x2f) this.state = 'intermediate'
        else if (code >= 0x30 && code <= 0x7e) this.state = 'text'
      } else if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) this.state = 'text'
      } else if (this.state === 'intermediate' && code >= 0x30 && code <= 0x7e) this.state = 'text'
    }
    flush(raw.length)
  }

  snapshot(count: number, maxJsonBytes?: number): string[] {
    const all = this.partial.trim() ? [...this.lines, this.partial] : this.lines
    const selected = all.slice(-Math.min(count, this.maxLines))
    if (maxJsonBytes === undefined) return [...selected]
    // Exact JSON bytes, including array/object punctuation. Keep the newest
    // suffix of a long line so an oversized log never prevents reconnect.
    let remaining = maxJsonBytes - 12
    const result: string[] = []
    for (let i = selected.length - 1; i >= 0; i--) {
      const line = selected[i], cost = Buffer.byteLength(JSON.stringify(line)) + (result.length ? 1 : 0)
      if (cost <= remaining) { result.unshift(line); remaining -= cost; continue }
      let low = 0, high = line.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (Buffer.byteLength(JSON.stringify(line.slice(-mid))) + (result.length ? 1 : 0) <= remaining) low = mid
        else high = mid - 1
      }
      let start = line.length - low
      if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start] ?? '') && /[\uD800-\uDBFF]/.test(line[start - 1])) start++
      if (start < line.length) result.unshift(line.slice(start))
      break
    }
    return result
  }

  private text(value: string): void {
    let start = 0
    for (let i = 0; i <= value.length; i++) {
      if (i < value.length && value[i] !== '\n') continue
      this.partial += value.slice(start, i)
      this.chars += i - start
      if (this.partial.length > this.maxChars) {
        let offset = this.partial.length - this.maxChars
        if (/[\uDC00-\uDFFF]/.test(this.partial[offset]) && /[\uD800-\uDBFF]/.test(this.partial[offset - 1])) offset++
        this.partial = this.partial.slice(offset); this.chars -= offset
      }
      if (i < value.length) {
        if (this.partial.trim()) this.lines.push(this.partial)
        else this.chars -= this.partial.length
        this.partial = ''; start = i + 1
      }
      while (this.lines.length + Number(!!this.partial) > this.maxLines || this.chars > this.maxChars && this.lines.length) this.chars -= this.lines.shift()!.length
    }
  }
}
