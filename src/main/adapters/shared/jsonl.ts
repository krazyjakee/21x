import { StringDecoder } from 'string_decoder'

type ReadableLike = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'end', listener: () => void): unknown
}

/**
 * Calls `onLine` for every non-empty, trimmed line of a newline-delimited
 * stream (JSONL / JSON-RPC over stdio). Bytes are decoded with a StringDecoder
 * so multi-byte UTF-8 characters split across chunks stay intact, and a final
 * unterminated line is flushed when the stream ends.
 *
 * Only '\n' separates records: JSON.stringify leaves U+2028/U+2029 unescaped,
 * so splitting on other line terminators would break valid frames.
 */
export function onJsonLines(stream: ReadableLike | null | undefined, onLine: (line: string) => void): void {
  if (!stream) return
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const emit = (rawLine: string): void => {
    const line = rawLine.trim()
    if (line) onLine(line)
  }

  stream.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      emit(line)
    }
  })

  stream.on('end', () => {
    const rest = buffer + decoder.end()
    buffer = ''
    emit(rest)
  })
}
