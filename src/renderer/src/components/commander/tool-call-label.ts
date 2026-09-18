/**
 * Chip text for a Commander tool call.
 *
 * The delegation tools arrive with #61; whatever their exact names, a call
 * that names a project reads "Asked <project>…", and anything else falls back
 * to the humanized tool name.
 */

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
  const text = input ? firstString(input, TEXT_KEYS) : null
  if (!text) return `Asked ${project}…`
  const snippet = text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS).trimEnd()}…` : text
  return `Asked ${project}: ${snippet}`
}
