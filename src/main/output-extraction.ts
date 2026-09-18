import type { OutputFieldRecord } from './database'
import type { SessionMessage } from './adapters/coding-agent-adapter'

/** Extracts complete key-value pairs from JSON that was cut off mid-value. */
export function extractPartialJson(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const stringPairs = raw.matchAll(/"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)
  for (const m of stringPairs) {
    result[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  const literalPairs = raw.matchAll(/"([^"]+)"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?)\s*[,}\n]/g)
  for (const m of literalPairs) {
    result[m[1]] = JSON.parse(m[2])
  }
  return result
}

/** File paths from completed write/edit tool calls. */
export function collectWrittenFiles(messages: SessionMessage[]): string[] {
  const files: string[] = []
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.type !== 'tool' || part.state?.status !== 'completed') continue
      const toolName = (typeof part.tool === 'string' ? part.tool : part.tool?.name || '').toLowerCase()
      if (toolName === 'write' || toolName === 'edit' || toolName === 'create_file') {
        const input = (part.state?.input || {}) as Record<string, string | undefined>
        const filePath = input.file_path || input.path || input.filename
        if (filePath) files.push(filePath)
      }
    }
  }
  return files
}

/**
 * Fills output field values from the agent's JSON block: the first ```json
 * (else plain ```) block of the latest assistant message that has one. Keys
 * match field names case-insensitively, then field ids. Unfilled file fields
 * fall back to files the agent wrote.
 */
export function extractOutputFromMessages(messages: SessionMessage[], fields: OutputFieldRecord[]): OutputFieldRecord[] {
  const assistantMessages = messages.filter((m) => m.role === 'assistant')
  const writtenFiles = collectWrittenFiles(assistantMessages)

  let parsedValues: Record<string, unknown> = {}
  for (let i = assistantMessages.length - 1; i >= 0; i--) {
    const fullText = (assistantMessages[i].parts ?? [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('\n')
    if (!fullText) continue

    const match = fullText.match(/```json\s*\n?([\s\S]*?)\n?\s*```/) || fullText.match(/```\s*\n?([\s\S]*?)\n?\s*```/)
    if (!match) continue
    const raw = match[1].trim()
    try {
      parsedValues = JSON.parse(raw)
      break
    } catch {
      parsedValues = extractPartialJson(raw)
      if (Object.keys(parsedValues).length > 0) break
    }
  }

  const byName = new Map<string, unknown>()
  const byId = new Map<string, unknown>()
  for (const [key, value] of Object.entries(parsedValues)) {
    byId.set(key, value)
    byName.set(key.toLowerCase(), value)
  }

  return fields.map((field) => {
    const updated = { ...field }
    const valueByName = byName.get(field.name.toLowerCase())
    const valueById = byId.get(field.id)
    if (valueByName !== undefined) {
      updated.value = valueByName
    } else if (valueById !== undefined) {
      updated.value = valueById
    }
    if (field.type === 'file' && !updated.value && writtenFiles.length > 0) {
      updated.value = field.multiple ? writtenFiles : writtenFiles[0]
    }
    return updated
  })
}
