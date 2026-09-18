/**
 * Mapping between a Notion data source schema and task fields: property role
 * detection, value formatting, filters, and status/priority name matching.
 */

import { TaskStatus } from '../../shared/constants'
import type {
  NotionDataSource,
  NotionFilter,
  NotionPage,
  NotionPropertySchema,
  NotionPropertyValue
} from './notion-client'

export enum NotionPropertyType {
  Title = 'title',
  RichText = 'rich_text',
  Number = 'number',
  Select = 'select',
  MultiSelect = 'multi_select',
  Status = 'status',
  Date = 'date',
  People = 'people',
  Checkbox = 'checkbox',
  Url = 'url',
  Email = 'email',
  PhoneNumber = 'phone_number',
  Files = 'files',
  CreatedTime = 'created_time',
  LastEditedTime = 'last_edited_time',
  Formula = 'formula',
  Relation = 'relation',
  Rollup = 'rollup',
  UniqueId = 'unique_id'
}

/** Property types that support server-side filtering */
export const FILTERABLE_PROPERTY_TYPES = new Set([
  NotionPropertyType.Status,
  NotionPropertyType.Select,
  NotionPropertyType.MultiSelect,
  NotionPropertyType.People,
  NotionPropertyType.Title,
  NotionPropertyType.RichText,
  NotionPropertyType.Number,
  NotionPropertyType.Checkbox,
  NotionPropertyType.Date
])

/** Stored in the source config. */
export interface NotionFilterConfig {
  property: string
  type: string
  values: string[]
}

/**
 * Maps a Notion property type to its Notion API filter key and operator.
 * Returns { filterKey, operator } for building Notion compound filters.
 */
function buildPropertyFilter(
  type: string,
  property: string,
  val: string
): Record<string, unknown> {
  switch (type) {
    case NotionPropertyType.Status:
      return { property, status: { equals: val } }
    case NotionPropertyType.Select:
      return { property, select: { equals: val } }
    case NotionPropertyType.MultiSelect:
      return { property, multi_select: { contains: val } }
    case NotionPropertyType.People:
      return { property, people: { contains: val } }
    case NotionPropertyType.Title:
      return { property, title: { contains: val } }
    case NotionPropertyType.RichText:
      return { property, rich_text: { contains: val } }
    case NotionPropertyType.Number:
      return { property, number: { equals: Number(val) } }
    case NotionPropertyType.Checkbox:
      return { property, checkbox: { equals: val === 'true' } }
    case NotionPropertyType.Date:
      return { property, date: { on_or_after: val } }
    default:
      return { property, rich_text: { contains: val } }
  }
}

export const STATUS_TO_LOCAL: Record<string, TaskStatus> = {
  'not started': TaskStatus.NotStarted,
  'todo': TaskStatus.NotStarted,
  'to do': TaskStatus.NotStarted,
  'backlog': TaskStatus.NotStarted,
  'in progress': TaskStatus.AgentWorking,
  'doing': TaskStatus.AgentWorking,
  'in review': TaskStatus.ReadyForReview,
  'done': TaskStatus.Completed,
  'complete': TaskStatus.Completed,
  'completed': TaskStatus.Completed
}

const LOCAL_TO_NOTION_STATUS: Record<string, string[]> = {
  [TaskStatus.NotStarted]: ['Not started', 'To Do', 'Backlog'],
  [TaskStatus.AgentWorking]: ['In progress', 'Doing'],
  [TaskStatus.ReadyForReview]: ['In review'],
  [TaskStatus.Completed]: ['Done', 'Complete', 'Completed']
}

export const PRIORITY_TO_LOCAL: Record<string, string> = {
  'critical': 'critical',
  'urgent': 'critical',
  'p0': 'critical',
  'high': 'high',
  'p1': 'high',
  'medium': 'medium',
  'p2': 'medium',
  'low': 'low',
  'p3': 'low'
}

const LOCAL_TO_NOTION_PRIORITY: Record<string, string[]> = {
  critical: ['Critical', 'Urgent', 'P0'],
  high: ['High', 'P1'],
  medium: ['Medium', 'P2'],
  low: ['Low', 'P3']
}

/** Auto-detected from the database schema. */
export interface PropertyMap {
  title: string
  status?: { name: string; type: NotionPropertyType.Status | NotionPropertyType.Select }
  priority?: { name: string; type: NotionPropertyType.Select }
  assignee?: { name: string }
  dueDate?: { name: string }
  labels?: { name: string; type: NotionPropertyType.MultiSelect }
}

/** Name heuristics for auto-detecting property roles */
const ASSIGNEE_HEURISTICS = new Set(['assignee', 'owner', 'assigned to'])
const DUE_DATE_HEURISTICS = new Set(['due', 'deadline', 'due date'])
const LABELS_HEURISTICS = new Set(['tags', 'labels', 'category'])

/**
 * Auto-detect which Notion properties map to task fields
 */
export function buildPropertyMap(
  db: NotionDataSource
): PropertyMap {
  const props = db.properties
  const map: PropertyMap = { title: '' }

  for (const [name, schema] of Object.entries(props)) {
    const lower = name.toLowerCase()

    // Title — every DB has exactly one
    if (schema.type === NotionPropertyType.Title) {
      map.title = name
    }

    // Status
    if (!map.status) {
      if (schema.type === NotionPropertyType.Status) {
        map.status = { name, type: NotionPropertyType.Status }
      } else if (schema.type === NotionPropertyType.Select && lower === 'status') {
        map.status = { name, type: NotionPropertyType.Select }
      }
    }

    // Priority
    if (!map.priority && schema.type === NotionPropertyType.Select && lower === 'priority') {
      map.priority = { name, type: NotionPropertyType.Select }
    }

    // Assignee
    if (schema.type === NotionPropertyType.People) {
      if (!map.assignee) {
        if (ASSIGNEE_HEURISTICS.has(lower)) {
          map.assignee = { name }
        } else {
          map.assignee = { name } // fallback to first People property
        }
      }
    }

    // Due date
    if (schema.type === NotionPropertyType.Date) {
      if (!map.dueDate || DUE_DATE_HEURISTICS.has(lower)) {
        map.dueDate = { name }
      }
    }

    // Labels
    if (schema.type === NotionPropertyType.MultiSelect) {
      if (!map.labels || LABELS_HEURISTICS.has(lower)) {
        map.labels = { name, type: NotionPropertyType.MultiSelect }
      }
    }
  }

  return map
}

/**
 * Format all Notion page properties as a markdown section.
 * Skips the title property (already used as task title).
 */
export function formatProperties(page: NotionPage, titlePropName: string): string {
  const lines: string[] = []

  for (const [name, prop] of Object.entries(page.properties)) {
    if (name === titlePropName) continue

    const val = formatPropertyValue(prop)
    if (val) {
      lines.push(`| ${name} | ${val} |`)
    }
  }

  if (lines.length === 0) return ''

  return '---\n\n**Properties**\n\n| Property | Value |\n| --- | --- |\n' + lines.join('\n')
}

/**
 * Format a single Notion property value as a string
 */
function formatPropertyValue(prop: NotionPropertyValue): string | null {
  switch (prop.type) {
    case 'title':
      return prop.title?.map((t) => t.plain_text).join('') || null
    case 'rich_text':
      return prop.rich_text?.map((t) => t.plain_text).join('') || null
    case 'status':
      return prop.status?.name || null
    case 'select':
      return prop.select?.name || null
    case 'multi_select':
      return prop.multi_select?.map((s) => s.name).join(', ') || null
    case 'people':
      return prop.people?.map((p) => p.name || p.person?.email || p.id).join(', ') || null
    case 'date': {
      if (!prop.date?.start) return null
      const start = prop.date.start.split('T')[0]
      const end = prop.date.end?.split('T')[0]
      return end ? `${start} → ${end}` : start
    }
    case 'number':
      return prop.number != null ? String(prop.number) : null
    case 'checkbox':
      return prop.checkbox ? 'Yes' : 'No'
    case 'url':
      return prop.url || null
    case 'files': {
      if (!prop.files || prop.files.length === 0) return null
      return prop.files.map((f) => {
        const url = f.type === 'file' ? f.file?.url : f.external?.url
        return url ? `[${f.name}](${url})` : f.name
      }).join(', ')
    }
    case 'unique_id': {
      if (!prop.unique_id) return null
      const prefix = prop.unique_id.prefix
      return prefix ? `${prefix}-${prop.unique_id.number}` : String(prop.unique_id.number)
    }
    default:
      return null
  }
}

/**
 * Build Notion API filter from structured filter config.
 * Same property values → OR, different properties → AND.
 */
export function buildNotionFilter(
  filters: NotionFilterConfig[] | undefined
): NotionFilter | undefined {
  if (!filters || filters.length === 0) return undefined

  const andClauses: NotionFilter[] = []

  for (const filter of filters) {
    if (!filter.property || !filter.type || filter.values.length === 0) continue

    const nonEmptyValues = filter.values.filter((v) => v !== '')
    if (nonEmptyValues.length === 0) continue

    const orClauses = nonEmptyValues.map((val) =>
      buildPropertyFilter(filter.type, filter.property, val)
    ) as NotionFilter[]

    if (orClauses.length === 1) {
      andClauses.push(orClauses[0])
    } else {
      andClauses.push({ or: orClauses })
    }
  }

  if (andClauses.length === 0) return undefined
  if (andClauses.length === 1) return andClauses[0]
  return { and: andClauses }
}

/**
 * Option names of a Notion status or select property, in board order.
 */
export function statusOptionNames(propSchema: NotionPropertySchema | undefined): string[] {
  if (!propSchema) return []
  const options =
    propSchema.type === NotionPropertyType.Status
      ? propSchema.status?.options
      : propSchema.select?.options
  return options?.map((o) => o.name) ?? []
}

/**
 * Map local status to a Notion status option name
 */
export function localStatusToNotion(
  localStatus: string,
  propSchema: NotionPropertySchema | undefined
): string | null {
  if (!propSchema) return null

  const candidates = LOCAL_TO_NOTION_STATUS[localStatus]
  if (!candidates) return null

  const optionNames = statusOptionNames(propSchema)
  if (optionNames.length === 0) return null

  for (const candidate of candidates) {
    const match = optionNames.find((n) => n.toLowerCase() === candidate.toLowerCase())
    if (match) return match
  }

  return null
}

/**
 * Map local priority to a Notion select option name
 */
export function localPriorityToNotion(
  localPriority: string,
  propSchema: NotionPropertySchema | undefined
): string | null {
  if (!propSchema?.select?.options) return null

  const candidates = LOCAL_TO_NOTION_PRIORITY[localPriority]
  if (!candidates) return null

  const optionNames = propSchema.select.options.map((o) => o.name)

  for (const candidate of candidates) {
    const match = optionNames.find((n) => n.toLowerCase() === candidate.toLowerCase())
    if (match) return match
  }

  return null
}
