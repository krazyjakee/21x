import type { AgentMessage } from './types'

type Tool = AgentMessage['tool']

/** Truncates large content (like base64 data) for display. */
export function sanitizeToolContent(content: unknown): string {
  if (content == null) return ''

  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>
    if (obj.type === 'image' && obj.source) {
      const source = obj.source as Record<string, unknown>
      const dataLength = typeof source.data === 'string' ? source.data.length : 0
      return `[Image content: ${dataLength} characters of base64 data]`
    }
    const stringified = JSON.stringify(content, null, 2)
    return stringified.length > 1000 ? `[Object: ${stringified.substring(0, 1000)}...]` : stringified
  }

  const str = String(content)
  const maxDisplayLength = 5000
  if (str.length <= maxDisplayLength) return str

  const base64Chars = (str.match(/[A-Za-z0-9+/=]/g) || []).length
  if (base64Chars / str.length > 0.9) return `[Binary content: ${str.length} characters]`

  return str.substring(0, maxDisplayLength) + `\n\n... (${str.length - maxDisplayLength} more characters)`
}

function parseToolInput(input: unknown): Record<string, unknown> | null {
  if (!input) return null
  if (typeof input === 'object') return input as Record<string, unknown>
  if (typeof input !== 'string') return null

  try {
    const parsed = JSON.parse(input)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function basenameFromPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || value
}

function isFilePathTool(toolName: string): boolean {
  return ['read', 'edit', 'multiedit', 'write', 'notebookedit'].includes(toolName.toLowerCase())
}

function deriveToolDescription(tool: NonNullable<Tool>): string {
  if (tool.description) return tool.description
  const description = parseToolInput(tool.input)?.description
  return typeof description === 'string' ? description : ''
}

export function deriveToolCommand(tool: Tool): string {
  if (!tool) return ''

  const command = parseToolInput(tool.input)?.command
  if (Array.isArray(command)) return command.map(String).join(' ')
  if (typeof command === 'string') return command

  if (tool.name.toLowerCase() === 'command' && typeof tool.input === 'string') return tool.input
  return ''
}

export function deriveToolSubtitle(tool: Tool): string {
  if (!tool) return ''

  const description = deriveToolDescription(tool)
  if (description) return description

  if (tool.title) {
    if (tool.title === tool.name) return ''
    return isFilePathTool(tool.name) ? basenameFromPath(tool.title) : tool.title
  }

  if (tool.name === 'command' && typeof tool.input === 'string') {
    const firstLine = tool.input.split('\n').map((line) => line.trim()).find(Boolean)
    return firstLine ? firstLine.slice(0, 120) : ''
  }

  const input = parseToolInput(tool.input)
  const filePath = input?.file_path || input?.path || input?.filename
  if (isFilePathTool(tool.name) && typeof filePath === 'string') return basenameFromPath(filePath)

  return ''
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * Tool calls and reasoning render as compact rows grouped together. A tool
 * part without a name is excluded: the tool row and its derivations assume one.
 */
export function isCompactActivityMessage(message: AgentMessage): boolean {
  return (message.partType === 'tool' && !!message.tool?.name) || message.partType === 'reasoning'
}
