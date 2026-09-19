/**
 * Chip text for a Commander tool call.
 *
 * Delegation calls read "Asked <project>…". Project administration calls use
 * their action name so a rename or archive is not presented as delegation.
 */

/**
 * Tools that hand a message to a project. Compatibility aliases for stored
 * Commander transcript rows: `ask_project` is the pre-#61 name and
 * `ask_mastermind` the pre-#71 name of `ask_captain`.
 */
const DELEGATION_TOOLS = new Set(['ask_captain', 'ask_mastermind', 'ask_project'])
const PROJECT_KEYS = ['project_name', 'projectName', 'project', 'project_id', 'projectId'] as const
const TEXT_KEYS = ['message', 'question', 'request', 'task', 'prompt', 'text'] as const
const SNIPPET_CHARS = 60

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export function humanizeToolName(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Tool'
}

export function toolCallProject(input: Record<string, unknown> | undefined): string | null {
  return input ? firstString(input, PROJECT_KEYS) : null
}

export function toolCallLabel(name: string, input: Record<string, unknown> | undefined): string {
  const project = toolCallProject(input)
  if (!project) return humanizeToolName(name)
  if (!DELEGATION_TOOLS.has(name)) return `${humanizeToolName(name)} · ${project}`
  const text = input ? firstString(input, TEXT_KEYS) : null
  if (!text) return `Asked ${project}…`
  const snippet = text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS).trimEnd()}…` : text
  return `Asked ${project}: ${snippet}`
}

/**
 * A tool result as shown when its chip is expanded: JSON is pretty-printed,
 * anything else is trimmed. Empty results return an empty string (nothing to expand).
 */
export function formatToolResult(result: string | undefined): string {
  const text = result?.trim() ?? ''
  if (!text || (text[0] !== '{' && text[0] !== '[')) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
