/**
 * Mapping between YouTrack issues and tasks: YQL from source config, custom
 * field extraction, status/priority tables, and the markdown description.
 */

import { TaskStatus } from '../../shared/constants'
import type {
  YouTrackIssue,
  YouTrackCustomField,
  YouTrackCustomFieldValue,
  YouTrackIssueLink
} from './youtrack-client'

export const STATUS_TO_LOCAL: Record<string, TaskStatus> = {
  'open': TaskStatus.NotStarted,
  'submitted': TaskStatus.NotStarted,
  'to do': TaskStatus.NotStarted,
  'todo': TaskStatus.NotStarted,
  'backlog': TaskStatus.NotStarted,
  'new': TaskStatus.NotStarted,
  'registered': TaskStatus.NotStarted,
  'in progress': TaskStatus.AgentWorking,
  'active': TaskStatus.AgentWorking,
  'started': TaskStatus.AgentWorking,
  'in development': TaskStatus.AgentWorking,
  'developing': TaskStatus.AgentWorking,
  'in review': TaskStatus.ReadyForReview,
  'review': TaskStatus.ReadyForReview,
  'to verify': TaskStatus.ReadyForReview,
  'to be discussed': TaskStatus.ReadyForReview,
  'fixed': TaskStatus.Completed,
  'done': TaskStatus.Completed,
  'complete': TaskStatus.Completed,
  'completed': TaskStatus.Completed,
  'resolved': TaskStatus.Completed,
  'verified': TaskStatus.Completed,
  'closed': TaskStatus.Completed,
  "won't fix": TaskStatus.Completed,
  'duplicate': TaskStatus.Completed,
  'obsolete': TaskStatus.Completed,
  "can't reproduce": TaskStatus.Completed
}

const PRIORITY_TO_LOCAL: Record<string, string> = {
  'show-stopper': 'critical',
  'critical': 'critical',
  'major': 'high',
  'normal': 'medium',
  'minor': 'low'
}

// fieldType.id values; they identify a field when its name differs per project.

export const STATE_FIELD_TYPE = 'state[1]'
export const PRIORITY_FIELD_TYPE = 'ownedField[1]' // Priority bundle
export const ENUM_FIELD_TYPE = 'enum[1]' // Type, etc.

/** YouTrack stores most fields (State, Priority, Assignee, Type) in customFields. */
function getCustomField(
  issue: YouTrackIssue,
  fieldName: string
): YouTrackCustomField | undefined {
  return issue.customFields.find(
    (f) => f.name.toLowerCase() === fieldName.toLowerCase()
  )
}

function getCustomFieldValueName(field: YouTrackCustomField | undefined): string | null {
  if (!field || field.value === null || field.value === undefined) return null

  if (typeof field.value === 'object' && !Array.isArray(field.value)) {
    const val = field.value as YouTrackCustomFieldValue
    return val.name || val.presentation || null
  }

  if (typeof field.value === 'string') return field.value
  if (typeof field.value === 'number') return String(field.value)

  return null
}

/** Assignee fields may be single-user or multi-user; the first user wins. */
function getAssigneeName(field: YouTrackCustomField | undefined): string | null {
  if (!field || field.value === null || field.value === undefined || typeof field.value !== 'object') return null
  const user = (Array.isArray(field.value) ? field.value[0] : field.value) as YouTrackCustomFieldValue | undefined
  return user?.fullName || user?.login || user?.name || null
}

function getCustomFieldByType(
  issue: YouTrackIssue,
  fieldTypeId: string
): YouTrackCustomField | undefined {
  return issue.customFields.find(
    (f) => f.projectCustomField?.field?.fieldType?.id === fieldTypeId
  )
}

/** YQL for the source config's filters; the custom query is appended as-is. */
export function buildYqlQuery(
  config: Record<string, unknown>
): string {
  const parts: string[] = []

  const project = config.project as string
  if (project) {
    parts.push(`project: {${project}}`)
  }

  // Values are wrapped in braces so names with spaces work; `Field: {a}, {b}` is an OR.
  const filters: Array<[string, string]> = [['assignee', 'for'], ['state', 'State'], ['priority', 'Priority'], ['issue_type', 'Type']]
  for (const [key, yqlField] of filters) {
    const value = config[key] as string[] | string | undefined
    if (!value) continue
    const values = Array.isArray(value) ? value : [value]
    if (values.length > 0) parts.push(`${yqlField}: ${values.map((v) => `{${v}}`).join(', ')}`)
  }

  const customQuery = config.custom_query as string | undefined
  if (customQuery && customQuery.trim()) {
    parts.push(customQuery.trim())
  }

  return parts.join(' ')
}

export function mapIssue(issue: YouTrackIssue): {
  title: string
  status?: string
  priority?: string
  assignee?: string
  labels?: string[]
  type?: string
} {
  const title = issue.summary || ''

  let status: string | undefined
  const stateField =
    getCustomField(issue, 'State') ||
    getCustomFieldByType(issue, STATE_FIELD_TYPE)
  const rawState = getCustomFieldValueName(stateField)
  if (rawState) {
    status = STATUS_TO_LOCAL[rawState.toLowerCase()] || TaskStatus.NotStarted
  }

  let priority: string | undefined
  const priorityField =
    getCustomField(issue, 'Priority') ||
    getCustomFieldByType(issue, PRIORITY_FIELD_TYPE)
  const rawPriority = getCustomFieldValueName(priorityField)
  if (rawPriority) {
    priority = PRIORITY_TO_LOCAL[rawPriority.toLowerCase()] || 'medium'
  }

  const assigneeField = getCustomField(issue, 'Assignee')
  const assignee: string | undefined = getAssigneeName(assigneeField) || undefined

  let labels: string[] | undefined
  if (issue.tags && issue.tags.length > 0) {
    labels = issue.tags.map((t) => t.name)
  }

  let type: string | undefined
  const typeField = getCustomField(issue, 'Type')
  const rawType = getCustomFieldValueName(typeField)
  if (rawType) {
    const TYPE_TO_LOCAL: Record<string, string> = {
      'bug': 'coding',
      'feature': 'coding',
      'task': 'general',
      'cosmetics': 'coding',
      'exception': 'coding',
      'usability problem': 'review',
      'performance problem': 'coding',
      'epic': 'general',
      'story': 'general'
    }
    type = TYPE_TO_LOCAL[rawType.toLowerCase()] || 'general'
  }

  return { title, status, priority, assignee, labels, type }
}

/** Markdown description: the issue text, a properties table, linked issues, and a link back. */
export function buildDescription(
  issue: YouTrackIssue,
  baseUrl: string
): string {
  const parts: string[] = []

  if (issue.description) {
    parts.push(issue.description)
  }

  const fieldsSection = formatCustomFields(issue)
  if (fieldsSection) {
    parts.push(fieldsSection)
  }

  const linksSection = formatLinkedIssues(issue, baseUrl)
  if (linksSection) {
    parts.push(linksSection)
  }

  const issueUrl = `${baseUrl}/issue/${issue.idReadable}`
  parts.push('')
  parts.push(`[View in YouTrack](${issueUrl})`)

  return parts.join('\n\n')
}

/**
 * Format linked issues as a markdown section with deep links.
 * Groups links by relationship type (e.g. "Depends on", "Subtask of", "Relates to").
 */
function formatLinkedIssues(
  issue: YouTrackIssue,
  baseUrl: string
): string | null {
  const grouped: Record<string, Array<{ id: string; summary: string; resolved: boolean }>> = {}

  const addLink = (label: string, linked: { idReadable: string; summary: string; resolved: number | null }) => {
    const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1)
    if (!grouped[capitalizedLabel]) grouped[capitalizedLabel] = []
    // Deduplicate — same issue can appear in both dedicated fields and links array
    if (grouped[capitalizedLabel].some(existing => existing.id === linked.idReadable)) return
    grouped[capitalizedLabel].push({
      id: linked.idReadable,
      summary: linked.summary,
      resolved: linked.resolved != null
    })
  }

  const processIssueLink = (link: YouTrackIssueLink) => {
    if (!link.linkType || !link.issues || link.issues.length === 0) return

    let label: string
    if (link.direction === 'OUTWARD') {
      label = link.linkType.sourceToTarget || link.linkType.name
    } else if (link.direction === 'INWARD') {
      label = link.linkType.targetToSource || link.linkType.name
    } else {
      label = link.linkType.name
    }

    for (const linked of link.issues) {
      addLink(label, linked)
    }
  }

  // Parent and subtasks come in dedicated fields, separate from the links array.
  if (issue.parent?.issues && issue.parent.issues.length > 0) {
    const parentLabel = issue.parent.linkType?.targetToSource || 'Subtask of'
    for (const linked of issue.parent.issues) {
      addLink(parentLabel, linked)
    }
  }

  if (issue.subtasks?.issues && issue.subtasks.issues.length > 0) {
    const subtaskLabel = issue.subtasks.linkType?.sourceToTarget || 'Parent for'
    for (const linked of issue.subtasks.issues) {
      addLink(subtaskLabel, linked)
    }
  }

  if (issue.links) {
    for (const link of issue.links) {
      processIssueLink(link)
    }
  }

  const labels = Object.keys(grouped)
  if (labels.length === 0) return null

  const lines: string[] = ['### Linked Issues', '']

  for (const label of labels) {
    for (const item of grouped[label]) {
      const issueUrl = `${baseUrl}/issue/${item.id}`
      const strikethrough = item.resolved ? '~~' : ''
      lines.push(`- **${label}**: ${strikethrough}[${item.id}](${issueUrl}) — ${item.summary}${strikethrough}`)
    }
  }

  return lines.join('\n')
}

function formatCustomFields(issue: YouTrackIssue): string {
  const lines: string[] = []

  if (issue.project) {
    lines.push(
      `| Project | ${issue.project.name} (${issue.project.shortName}) |`
    )
  }

  lines.push(`| ID | ${issue.idReadable} |`)

  for (const field of issue.customFields) {
    const value = formatCustomFieldValue(field)
    if (value) {
      lines.push(`| ${field.name} | ${value} |`)
    }
  }

  if (issue.tags && issue.tags.length > 0) {
    const tagNames = issue.tags.map((t) => t.name).join(', ')
    lines.push(`| Tags | ${tagNames} |`)
  }

  if (lines.length === 0) return ''

  return (
    '---\n\n**Properties**\n\n| Property | Value |\n| --- | --- |\n' +
    lines.join('\n')
  )
}

function formatCustomFieldValue(field: YouTrackCustomField): string | null {
  if (field.value === null || field.value === undefined) return null

  if (typeof field.value === 'object' && !Array.isArray(field.value)) {
    const val = field.value as YouTrackCustomFieldValue
    return (
      val.fullName || val.name || val.login || val.presentation || val.text || null
    )
  }

  if (Array.isArray(field.value)) {
    if (field.value.length === 0) return null
    return field.value
      .map((v: YouTrackCustomFieldValue) =>
        v.fullName || v.name || v.login || v.presentation || v.text || ''
      )
      .filter(Boolean)
      .join(', ')
  }

  if (typeof field.value === 'string') return field.value || null
  if (typeof field.value === 'number') return String(field.value)

  return null
}

export function localStatusToYouTrack(localStatus: string): string | null {
  const mapping: Record<string, string> = {
    [TaskStatus.NotStarted]: 'Open',
    [TaskStatus.AgentWorking]: 'In Progress',
    [TaskStatus.ReadyForReview]: 'In Review',
    [TaskStatus.Completed]: 'Fixed'
  }
  return mapping[localStatus] || null
}

export function localPriorityToYouTrack(localPriority: string): string | null {
  const mapping: Record<string, string> = {
    critical: 'Critical',
    high: 'Major',
    medium: 'Normal',
    low: 'Minor'
  }
  return mapping[localPriority] || null
}
