import {
  PluginActionId,
  type TaskSourcePlugin,
  type PluginConfigSchema,
  type ConfigFieldOption,
  type PluginContext,
  type PluginAction,
  type PluginSyncResult,
  type ActionResult
} from './types'
import type { TaskRecord } from '../database'
import type { SourceUser, ReassignResult } from '../../shared/types'
import { TaskStatus } from '../../shared/constants'
import { replaceRemoteImageUrlsInTask } from './replace-image-urls'
import { upsertSourcedTask } from './sourced-tasks'
import { normalizeUrlForComparison, buildNormalizedUrlSet } from './url-utils'
import { saveTaskAttachment } from './attachments'
import { mimeTypeForPath } from '../mime'
import { NotionClient, type NotionBlock, type NotionPage } from './notion-client'
import {
  FILTERABLE_PROPERTY_TYPES,
  NotionPropertyType,
  PRIORITY_TO_LOCAL,
  STATUS_TO_LOCAL,
  buildNotionFilter,
  buildPropertyMap,
  formatProperties,
  localPriorityToNotion,
  localStatusToNotion,
  statusOptionNames,
  type NotionFilterConfig,
  type PropertyMap
} from './notion-properties'

// ── Next statuses (stored in source config) ──────────────────

/**
 * The statuses a user can move a task to from 20x. The user selects these in
 * the source form from the real options of the Notion status property, because
 * the name heuristics below only know the default Notion board names.
 */
function readNextStatuses(config: Record<string, unknown>): string[] {
  const raw = config.next_statuses
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const name = value.trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    result.push(name)
  }
  return result
}

/**
 * The status a completed task moves to. Returns null when the user selected
 * none, or when the selection is stale — the status list can change in Notion
 * after the source was configured.
 */
function readCompletionStatus(config: Record<string, unknown>): string | null {
  const raw = config.completion_status
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name) return null
  const nextStatuses = readNextStatuses(config)
  if (nextStatuses.length === 0) return name
  const match = nextStatuses.find((s) => s.toLowerCase() === name.toLowerCase())
  return match ?? null
}

/** All status names the user configured, in the spelling Notion expects. */
function configuredStatuses(config: Record<string, unknown>): string[] {
  const nextStatuses = readNextStatuses(config)
  const completion = readCompletionStatus(config)
  if (completion && !nextStatuses.some((s) => s.toLowerCase() === completion.toLowerCase())) {
    return [...nextStatuses, completion]
  }
  return nextStatuses
}


// ── Plugin ───────────────────────────────────────────────────

export class NotionPlugin implements TaskSourcePlugin {
  id = 'notion'
  displayName = 'Notion'
  description = 'Import tasks from a Notion data source'
  icon = 'BookOpen'

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'api_token',
        label: 'Integration Token',
        type: 'password',
        required: true,
        placeholder: 'ntn_...',
        description: 'Internal Integration Token from notion.so/profile/integrations'
      },
      {
        key: 'data_source_id',
        label: 'Data source',
        type: 'dynamic-select',
        optionsResolver: 'data_sources',
        required: true,
        dependsOn: { field: 'api_token', value: '__any__' }
      },
      {
        key: 'filters',
        label: 'Filters',
        type: 'text',
        dependsOn: { field: 'data_source_id', value: '__any__' },
        description: 'Structured filter configuration (managed by custom form)'
      },
      {
        key: 'next_statuses',
        label: 'Next statuses',
        type: 'dynamic-select',
        optionsResolver: 'status_options',
        multiSelect: true,
        dependsOn: { field: 'data_source_id', value: '__any__' },
        description: 'Statuses a task can be moved to from 20x'
      },
      {
        key: 'completion_status',
        label: 'Status on completion',
        type: 'dynamic-select',
        optionsResolver: 'status_options',
        dependsOn: { field: 'data_source_id', value: '__any__' },
        description: 'Status written to Notion when a task is completed at source'
      }
    ]
  }

  async resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    const token = config.api_token as string
    if (!token) return []

    const client = new NotionClient(token)

    if (resolverKey === 'data_sources') {
      const dataSources = await client.searchDataSources()
      return dataSources.map((dataSource) => ({
        value: dataSource.id,
        label: dataSource.title.map((t) => t.plain_text).join('') || 'Untitled'
      }))
    }

    if (resolverKey === 'status_options') {
      const dataSourceId = config.data_source_id as string
      if (!dataSourceId) return []

      try {
        const db = await client.getDataSource(dataSourceId)
        const propMap = buildPropertyMap(db)
        if (!propMap.status) return []
        return statusOptionNames(db.properties[propMap.status.name]).map((name) => ({
          value: name,
          label: name
        }))
      } catch (err) {
        console.error('[notion] Failed to fetch status options:', err)
        return []
      }
    }

    if (resolverKey === 'data_source_properties') {
      const dataSourceId = config.data_source_id as string
      if (!dataSourceId) return []

      try {
        const db = await client.getDataSource(dataSourceId)
        const result: ConfigFieldOption[] = []

        // Pre-fetch users if any people property exists
        const hasPeopleProperty = Object.values(db.properties).some(
          (p) => p.type === NotionPropertyType.People
        )
        let userOptions: Array<{ value: string; label: string }> = []
        if (hasPeopleProperty) {
          try {
            const users = await client.getUsers()
            userOptions = users
              .filter((u) => u.type === 'person')
              .map((u) => ({
                value: u.id,
                label: u.name || u.person?.email || u.id
              }))
          } catch {
            // Non-fatal: users endpoint may not be accessible
          }
        }

        for (const [name, prop] of Object.entries(db.properties)) {
          if (!FILTERABLE_PROPERTY_TYPES.has(prop.type as NotionPropertyType)) continue

          const info: { name: string; type: string; options?: Array<{ value: string; label: string }> } = {
            name,
            type: prop.type
          }

          if (prop.type === NotionPropertyType.Status && prop.status) {
            info.options = prop.status.options.map((o) => ({ value: o.name, label: o.name }))
          } else if (prop.type === NotionPropertyType.Select && prop.select) {
            info.options = prop.select.options.map((o) => ({ value: o.name, label: o.name }))
          } else if (prop.type === NotionPropertyType.MultiSelect && prop.multi_select) {
            info.options = prop.multi_select.options.map((o) => ({ value: o.name, label: o.name }))
          } else if (prop.type === NotionPropertyType.People) {
            info.options = userOptions
          }

          result.push({ value: JSON.stringify(info), label: name })
        }

        return result
      } catch (err) {
        console.error('[notion] Failed to fetch data source properties:', err)
        return []
      }
    }

    return []
  }

  getActions(config: Record<string, unknown>): PluginAction[] {
    const nextStatuses = readNextStatuses(config)
    const changeStatus: PluginAction = {
      id: PluginActionId.ChangeStatus,
      label: 'Change Status',
      icon: 'ArrowRightCircle',
      requiresInput: true,
      inputLabel: 'New Status',
      inputPlaceholder:
        nextStatuses.length > 0 ? `e.g. ${nextStatuses[0]}` : 'e.g. Done, In Progress'
    }
    // With next statuses configured the user picks one instead of typing a
    // name that Notion may not have.
    if (nextStatuses.length > 0) {
      changeStatus.inputOptions = nextStatuses.map((name) => ({ value: name, label: name }))
    }

    return [
      changeStatus,
      {
        id: PluginActionId.UpdatePriority,
        label: 'Update Priority',
        icon: 'AlertTriangle',
        requiresInput: true,
        inputLabel: 'New Priority',
        inputPlaceholder: 'e.g. High, Low'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }
    const token = config.api_token as string
    const dataSourceId = config.data_source_id as string

    const client = new NotionClient(token)

    try {
      // Fetch DB schema and build property map
      const db = await client.getDataSource(dataSourceId)
      const propMap = buildPropertyMap(db)

      // Build filter from config
      const notionFilter = buildNotionFilter(config.filters as NotionFilterConfig[] | undefined)

      // Get last synced time for incremental sync
      const source = ctx.db.getTaskSource(sourceId)
      const lastSyncedAt = source?.last_synced_at ?? null

      // Fetch pages
      const pages = await client.queryAllPages(dataSourceId, notionFilter, lastSyncedAt)

      for (const page of pages) {
        if (page.archived) continue

        try {
          const mapped = this.mapPage(page, propMap, config)
          if (!mapped.title) continue

          // Fetch page blocks for both content rendering and file extraction
          let blocks: NotionBlock[] = []
          const parts: string[] = []
          try {
            blocks = await client.getPageBlocks(page.id)
            const content = client.blocksToMarkdown(blocks)
            if (content) parts.push(content)
          } catch {
            // Non-fatal: page may have no content
          }

          // Append properties table
          const propsSection = formatProperties(page, propMap.title)
          if (propsSection) parts.push(propsSection)

          // Append link to Notion page
          if (page.url) {
            parts.push('')
            parts.push(`🔗 [View in Notion](${page.url})`)
          }

          const description = parts.join('\n\n')

          const upserted = upsertSourcedTask(ctx, sourceId, page.id, {
            title: mapped.title,
            // Keep the existing description if the page content could not be read.
            description: description || undefined,
            status: mapped.status,
            priority: mapped.priority,
            assignee: mapped.assignee,
            due_date: mapped.dueDate,
            labels: mapped.labels
          }, {
            title: mapped.title,
            description,
            type: 'general',
            priority: 'medium',
            source: 'Notion'
          })
          if (!upserted) {
            console.error('[notion] Failed to create task for page:', page.id)
            continue
          }
          const taskId = upserted.task.id
          if (upserted.created) result.imported++
          else result.updated++

          // Collect all file URLs from page properties (Files type) and content blocks
          const fileUrls: Array<{ url: string; filename: string }> = []

          // 1. Extract files from Files-type properties
          for (const [, prop] of Object.entries(page.properties)) {
            if (prop.type === 'files' && prop.files && prop.files.length > 0) {
              fileUrls.push(...client.extractFilesFromProperty(prop.files))
            }
          }

          // 2. Extract files from content blocks (images, files, PDFs, videos, audio)
          if (blocks.length > 0) {
            fileUrls.push(...client.extractFilesFromBlocks(blocks))
          }

          // Download and save attachments
          if (fileUrls.length > 0) {
            console.log(`[notion] Found ${fileUrls.length} files for page "${mapped.title}"`)
            await this.downloadNotionFiles(taskId, fileUrls, client, ctx)
          }

          // Replace remote image URLs in description with local attachment URLs
          // so images still display after remote links expire
          replaceRemoteImageUrlsInTask(taskId, ctx, '[notion]')
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          result.errors.push(`Page ${page.id}: ${msg}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      result.errors.push(`Import failed: ${msg}`)
    }

    ctx.db.updateTaskSourceLastSynced(sourceId)
    return result
  }

  async exportUpdate(
    task: TaskRecord,
    changedFields: Record<string, unknown>,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<void> {
    if (!task.external_id) return

    const token = config.api_token as string
    const dataSourceId = config.data_source_id as string
    const client = new NotionClient(token)

    try {
      const db = await client.getDataSource(dataSourceId)
      const propMap = buildPropertyMap(db)
      const properties: Record<string, unknown> = {}

      if (changedFields.title && typeof changedFields.title === 'string') {
        properties[propMap.title] = {
          title: [{ text: { content: changedFields.title } }]
        }
      }

      if (changedFields.status && propMap.status) {
        const localStatus = changedFields.status as string
        const notionStatus =
          (localStatus === TaskStatus.Completed ? readCompletionStatus(config) : null) ??
          localStatusToNotion(localStatus, db.properties[propMap.status.name])
        if (notionStatus) {
          if (propMap.status.type === NotionPropertyType.Status) {
            properties[propMap.status.name] = { status: { name: notionStatus } }
          } else {
            properties[propMap.status.name] = { select: { name: notionStatus } }
          }
        }
      }

      if (changedFields.priority && propMap.priority) {
        const notionPriority = localPriorityToNotion(
          changedFields.priority as string,
          db.properties[propMap.priority.name]
        )
        if (notionPriority) {
          properties[propMap.priority.name] = { select: { name: notionPriority } }
        }
      }

      if (changedFields.due_date !== undefined && propMap.dueDate) {
        properties[propMap.dueDate.name] = changedFields.due_date
          ? { date: { start: changedFields.due_date as string } }
          : { date: null }
      }

      if (Object.keys(properties).length > 0) {
        await client.updatePage(task.external_id, properties)
      }
    } catch (err) {
      console.error('[notion] Export update failed:', err)
    }
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ActionResult> {
    if (!task.external_id) {
      return { success: false, error: 'Task has no external ID' }
    }

    // "complete" is a generic completion action — treat it as a status change
    // so Notion moves the page on. The status the user selected wins; without
    // one, fall back to the Done/Complete name heuristics.
    if (actionId === PluginActionId.Complete) {
      actionId = PluginActionId.ChangeStatus
      input = readCompletionStatus(config) ?? 'completed'
    }

    if (!input) {
      return { success: false, error: 'Input value is required' }
    }

    const token = config.api_token as string
    const dataSourceId = config.data_source_id as string
    const client = new NotionClient(token)

    try {
      const db = await client.getDataSource(dataSourceId)
      const propMap = buildPropertyMap(db)
      const properties: Record<string, unknown> = {}

      if (actionId === PluginActionId.ChangeStatus && propMap.status) {
        // Prefer a status the user selected, then the name heuristics against
        // the DB schema, and finally the input as typed.
        const notionStatus =
          this.matchConfiguredStatus(input, config) ??
          localStatusToNotion(input, db.properties[propMap.status.name]) ??
          input
        if (propMap.status.type === NotionPropertyType.Status) {
          properties[propMap.status.name] = { status: { name: notionStatus } }
        } else {
          properties[propMap.status.name] = { select: { name: notionStatus } }
        }
      } else if (actionId === PluginActionId.UpdatePriority && propMap.priority) {
        const notionPriority = localPriorityToNotion(input, db.properties[propMap.priority.name]) || input
        properties[propMap.priority.name] = { select: { name: notionPriority } }
      } else {
        return { success: false, error: `Unknown action or missing property: ${actionId}` }
      }

      await client.updatePage(task.external_id, properties)

      const taskUpdate: Record<string, unknown> = {}
      if (actionId === PluginActionId.ChangeStatus) {
        const completionStatus = readCompletionStatus(config)
        const localStatus =
          completionStatus && completionStatus.toLowerCase() === input.toLowerCase()
            ? TaskStatus.Completed
            : STATUS_TO_LOCAL[input.toLowerCase()]
        if (localStatus) taskUpdate.status = localStatus
      } else if (actionId === PluginActionId.UpdatePriority) {
        const localPriority = PRIORITY_TO_LOCAL[input.toLowerCase()]
        if (localPriority) taskUpdate.priority = localPriority
      }

      return { success: true, taskUpdate: Object.keys(taskUpdate).length > 0 ? taskUpdate : undefined }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: `Action failed: ${msg}` }
    }
  }

  async getUsers(
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<SourceUser[]> {
    const token = config.api_token as string
    if (!token) return []

    try {
      const client = new NotionClient(token)
      const users = await client.getUsers()
      return users
        .filter((u) => u.type === 'person') // Notion user type, not our enum
        .map((u) => ({
          id: u.id,
          email: u.person?.email || '',
          name: u.name || u.person?.email || u.id
        }))
    } catch {
      return []
    }
  }

  async reassignTask(
    task: TaskRecord,
    userIds: string[],
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ReassignResult> {
    if (!task.external_id) {
      return { success: false, error: 'Task has no external ID' }
    }

    const token = config.api_token as string
    const dataSourceId = config.data_source_id as string
    const client = new NotionClient(token)

    try {
      const db = await client.getDataSource(dataSourceId)
      const propMap = buildPropertyMap(db)

      if (!propMap.assignee) {
        return { success: false, error: 'No assignee property found in database' }
      }

      const people = userIds.map((id) => ({ id }))
      await client.updatePage(task.external_id, {
        [propMap.assignee.name]: { people }
      })

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: msg }
    }
  }

  getSetupDocumentation(): string {
    return `# Notion Integration Setup

## Overview

Import tasks from any Notion data source. Supports incremental sync, server-side filtering by data source properties, and bidirectional updates.

## Prerequisites

- A Notion workspace
- An Internal Integration (API token)

## Setup Steps

### 1. Create an Integration

1. Go to [notion.so/profile/integrations/internal](https://www.notion.so/profile/integrations/internal)
2. Click **New integration**
3. Enter an **Integration name** (e.g. "20x Tasks")
4. Select your **Associated workspace**
5. Click **Create**

### 2. Configure Capabilities

On the **Configuration** tab after creation:

1. Copy the **Internal Integration Secret** (starts with \`ntn_\`) — click **Show** to reveal it
2. Under **Content capabilities**, ensure these are checked: **Read content**, **Update content**
3. Under **User capabilities**, select **Read user information including email addresses** (needed for assignee mapping)
4. Click **Save changes**

### 3. Grant Database Access

Go to the **Content access** tab:

1. Click **Edit access**
2. Select the database(s) you want to sync
3. Confirm access

Alternatively, open the database in Notion → click **...** → **Connections** → **Connect to** → select your integration.

### 4. Configure the Source

1. Paste your **Integration Token**
2. Select the **Database** from the dropdown
3. Optionally select **Filters** to only import specific items (e.g. Status = In Progress)
4. Optionally select the **Next statuses** a task can move to from 20x
5. Click **Save** and **Sync**

## Features

### Smart Filtering
Select property values to filter by. Values from the same property are combined with OR; different properties with AND.

Example: Status = "In Progress" OR "To Do" AND Priority = "High"

### Next Statuses
Select the statuses of your data source that a task can move to from 20x, and
which one a completed task moves to. Use this when your board has custom status
names such as "Ready for QA" or "Shipped" — without it, 20x can only recognise
the default Notion names (To Do, In progress, In review, Done).

### Incremental Sync
After the first full sync, subsequent syncs only fetch pages modified since the last sync.

### Bidirectional Updates
Changes to title, status, priority, and due date sync back to Notion.

## Property Auto-Detection

The integration automatically maps Notion properties to task fields:

| Notion Property Type | Task Field | Detected By |
|---------------------|------------|-------------|
| Title | Title | (every data source has one) |
| Status / Select named "Status" | Status | Type or name |
| Select named "Priority" | Priority | Name |
| People | Assignee | Prefers "Assignee"/"Owner" |
| Date | Due Date | Prefers "Due"/"Deadline"/"Due Date" |
| Multi-select | Labels | Prefers "Tags"/"Labels"/"Category" |

## Troubleshooting

### "Authentication failed"
- Verify your token starts with \`ntn_\`
- Tokens don't expire but can be revoked — check your integration settings

### "Access forbidden"
- Open the database in Notion → **...** → **Connections** → ensure your integration is connected

### No data sources appear
- The integration can only see data sources explicitly shared with it
- Share at least one data source with your integration

### Missing properties in filters
- Only Status, Select, and Multi-select properties appear as filter options
`
  }

  // ── Private helpers ────────────────────────────────────────

  /**
   * Extract task fields from a Notion page using the property map
   */
  private mapPage(
    page: NotionPage,
    propMap: PropertyMap,
    config: Record<string, unknown> = {}
  ): {
    title: string
    status?: string
    priority?: string
    assignee?: string
    dueDate?: string | null
    labels?: string[]
  } {
    const props = page.properties

    // Title
    const titleProp = props[propMap.title]
    const title = titleProp?.title?.map((t) => t.plain_text).join('') || ''

    // Status
    let status: string | undefined
    if (propMap.status) {
      const statusProp = props[propMap.status.name]
      if (statusProp) {
        const rawStatus = propMap.status.type === NotionPropertyType.Status
          ? statusProp.status?.name
          : statusProp.select?.name
        if (rawStatus) {
          // A configured completion status wins over the name heuristics, so a
          // custom name such as "Shipped" does not import back as not started
          // and re-open a task 20x just completed.
          const completionStatus = readCompletionStatus(config)
          status =
            completionStatus && completionStatus.toLowerCase() === rawStatus.toLowerCase()
              ? TaskStatus.Completed
              : STATUS_TO_LOCAL[rawStatus.toLowerCase()] || TaskStatus.NotStarted
        }
      }
    }

    // Priority
    let priority: string | undefined
    if (propMap.priority) {
      const priProp = props[propMap.priority.name]
      const rawPriority = priProp?.select?.name
      if (rawPriority) {
        priority = PRIORITY_TO_LOCAL[rawPriority.toLowerCase()] || 'medium'
      }
    }

    // Assignee
    let assignee: string | undefined
    if (propMap.assignee) {
      const assigneeProp = props[propMap.assignee.name]
      if (assigneeProp?.people && assigneeProp.people.length > 0) {
        const person = assigneeProp.people[0]
        assignee = person.name || person.person?.email || person.id
      }
    }

    // Due date
    let dueDate: string | null = null
    if (propMap.dueDate) {
      const dateProp = props[propMap.dueDate.name]
      if (dateProp?.date?.start) {
        dueDate = dateProp.date.start.split('T')[0]
      }
    }

    // Labels
    let labels: string[] | undefined
    if (propMap.labels) {
      const labelProp = props[propMap.labels.name]
      if (labelProp?.multi_select) {
        labels = labelProp.multi_select.map((s) => s.name)
      }
    }

    return { title, status, priority, assignee, dueDate, labels }
  }

  /**
   * Download Notion files and save them as task attachments.
   * Skips files that have already been downloaded (by URL).
   */
  private async downloadNotionFiles(
    taskId: string,
    files: Array<{ url: string; filename: string }>,
    client: NotionClient,
    ctx: PluginContext
  ): Promise<void> {
    const task = ctx.db.getTask(taskId)
    if (!task) return

    // Signed query params change on every API call, so compare without them.
    const existingUrls = buildNormalizedUrlSet(
      (task.attachments || []) as unknown as Array<Record<string, unknown>>,
      'notion_url'
    )

    for (const file of files) {
      if (existingUrls.has(normalizeUrlForComparison(file.url))) continue

      try {
        const { buffer, filename: headerFilename, contentType } = await client.downloadFile(file.url)
        // The name Notion shows beats the Content-Disposition header.
        const filename = file.filename || headerFilename || `notion-file-${Date.now()}`
        const mimeType = contentType || mimeTypeForPath(filename)
        saveTaskAttachment(ctx, taskId, { buffer, filename, mimeType, extra: { notion_url: file.url } })
        existingUrls.add(normalizeUrlForComparison(file.url))
        console.log(`[notion] Saved attachment: ${filename} (${buffer.length} bytes, ${mimeType})`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[notion] Failed to download ${file.filename}: ${msg}`)
      }
    }
  }

  /**
   * Match user input against the statuses the user configured, so the value
   * written to Notion always uses the spelling Notion knows.
   */
  private matchConfiguredStatus(
    input: string,
    config: Record<string, unknown>
  ): string | null {
    const wanted = input.trim().toLowerCase()
    if (!wanted) return null
    return configuredStatuses(config).find((s) => s.toLowerCase() === wanted) ?? null
  }

}
