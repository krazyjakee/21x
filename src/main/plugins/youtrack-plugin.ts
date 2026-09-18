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
import { sniffMimeType } from '../mime'
import { YouTrackClient, type YouTrackAttachment } from './youtrack-client'
import {
  ENUM_FIELD_TYPE,
  PRIORITY_FIELD_TYPE,
  STATE_FIELD_TYPE,
  STATUS_TO_LOCAL,
  buildDescription,
  buildYqlQuery,
  localPriorityToYouTrack,
  localStatusToYouTrack,
  mapIssue
} from './youtrack-mapping'

// ── Plugin ───────────────────────────────────────────────────

export class YouTrackPlugin implements TaskSourcePlugin {
  id = 'youtrack'
  displayName = 'YouTrack'
  description = 'Import tasks from a YouTrack project'
  icon = 'Bug'

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'server_url',
        label: 'Server URL',
        type: 'text',
        required: true,
        placeholder: 'https://youtrack.your-company.com',
        description:
          'Your YouTrack instance URL (cloud or self-hosted)'
      },
      {
        key: 'api_token',
        label: 'Permanent Token',
        type: 'password',
        required: true,
        placeholder: 'perm:...',
        description:
          'Bottom-left profile icon → Profile → Account Security → New Token (scope: YouTrack). See https://www.jetbrains.com/help/youtrack/server/manage-permanent-token.html'
      },
      {
        key: 'project',
        label: 'Project',
        type: 'dynamic-select',
        optionsResolver: 'projects',
        required: true,
        dependsOn: { field: 'api_token', value: '__any__' }
      },
      {
        key: 'assignee',
        label: 'Assignee',
        type: 'dynamic-select',
        optionsResolver: 'users',
        multiSelect: true,
        dependsOn: { field: 'project', value: '__any__' }
      },
      {
        key: 'state',
        label: 'State',
        type: 'dynamic-select',
        optionsResolver: 'states',
        multiSelect: true,
        dependsOn: { field: 'project', value: '__any__' }
      },
      {
        key: 'priority',
        label: 'Priority',
        type: 'dynamic-select',
        optionsResolver: 'priorities',
        multiSelect: true,
        dependsOn: { field: 'project', value: '__any__' }
      },
      {
        key: 'issue_type',
        label: 'Type',
        type: 'dynamic-select',
        optionsResolver: 'types',
        multiSelect: true,
        dependsOn: { field: 'project', value: '__any__' }
      },
      {
        key: 'custom_query',
        label: 'Additional Query (YQL)',
        type: 'text',
        placeholder: '#Unresolved sort by: updated desc',
        description:
          'Optional YouTrack search query appended to filters above'
      }
    ]
  }

  async resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    const serverUrl = config.server_url as string
    const token = config.api_token as string
    if (!serverUrl || !token) return []

    const client = new YouTrackClient(serverUrl, token)

    if (resolverKey === 'projects') {
      try {
        const projects = await client.getProjects()
        return projects.map((p) => ({
          value: p.shortName,
          label: `${p.name} (${p.shortName})`
        }))
      } catch (err) {
        console.error('[youtrack] Failed to fetch projects:', err)
        return []
      }
    }

    if (resolverKey === 'users') {
      try {
        const users = await client.getUsers()
        return users.map((u) => ({
          value: u.login,
          label: u.fullName || u.login
        }))
      } catch (err) {
        console.error('[youtrack] Failed to fetch users:', err)
        return []
      }
    }

    // For states, priorities, and types — resolve from project custom fields
    if (
      resolverKey === 'states' ||
      resolverKey === 'priorities' ||
      resolverKey === 'types'
    ) {
      const projectShortName = config.project as string
      if (!projectShortName) return []

      try {
        // First get the project ID from short name
        const projects = await client.getProjects()
        const project = projects.find((p) => p.shortName === projectShortName)
        if (!project) return []

        const customFields = await client.getProjectCustomFields(project.id)

        let targetFieldTypeId: string
        let fallbackFieldName: string
        if (resolverKey === 'states') {
          targetFieldTypeId = STATE_FIELD_TYPE
          fallbackFieldName = 'state'
        } else if (resolverKey === 'priorities') {
          targetFieldTypeId = PRIORITY_FIELD_TYPE
          fallbackFieldName = 'priority'
        } else {
          targetFieldTypeId = ENUM_FIELD_TYPE
          fallbackFieldName = 'type'
        }

        // Find field by type ID first, then by name as fallback
        let field = customFields.find(
          (f) => f.field.fieldType.id === targetFieldTypeId
        )
        if (!field) {
          field = customFields.find(
            (f) =>
              f.field.name.toLowerCase() === fallbackFieldName
          )
        }

        if (!field?.bundle?.values) return []

        return field.bundle.values.map((v) => ({
          value: v.name,
          label: v.name
        }))
      } catch (err) {
        console.error(
          `[youtrack] Failed to fetch ${resolverKey}:`,
          err
        )
        return []
      }
    }

    return []
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: PluginActionId.OpenInYouTrack,
        label: 'Open in YouTrack',
        icon: 'ExternalLink'
      },
      {
        id: PluginActionId.AddComment,
        label: 'Add Comment',
        icon: 'MessageSquare',
        requiresInput: true,
        inputLabel: 'Comment',
        inputPlaceholder: 'Enter your comment...'
      },
      {
        id: PluginActionId.ChangeState,
        label: 'Change State',
        icon: 'ArrowRightCircle',
        requiresInput: true,
        inputLabel: 'New State',
        inputPlaceholder: 'e.g. In Progress, Fixed, Done'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }
    const serverUrl = config.server_url as string
    const token = config.api_token as string

    const client = new YouTrackClient(serverUrl, token)

    try {
      // Always do a full sync using the configured filters.
      // This ensures all issues are kept up-to-date (description, links, status, etc.)
      // regardless of when they were last modified in YouTrack.
      const yql = buildYqlQuery(config)
      console.log('[youtrack] YQL query:', yql)

      // Fetch all matching issues
      const issues = await client.getAllIssues(yql)
      console.log(`[youtrack] Fetched ${issues.length} issues`)

      for (const issue of issues) {
        try {
          const mapped = mapIssue(issue)
          if (!mapped.title) continue

          // Build description with issue details
          const description = buildDescription(issue, client.getBaseUrl())

          const upserted = upsertSourcedTask(ctx, sourceId, issue.id, {
            title: mapped.title,
            description,
            status: mapped.status,
            priority: mapped.priority,
            assignee: mapped.assignee,
            labels: mapped.labels
          }, {
            title: mapped.title,
            type: mapped.type || 'general',
            priority: 'medium',
            source: 'YouTrack'
          })
          if (!upserted) {
            console.error(
              '[youtrack] Failed to create task for issue:',
              issue.idReadable
            )
            continue
          }
          const taskId = upserted.task.id
          if (upserted.created) result.imported++
          else result.updated++

          // Download attachments
          if (issue.attachments && issue.attachments.length > 0) {
            console.log(
              `[youtrack] Found ${issue.attachments.length} attachments for issue "${issue.idReadable}"`
            )
            await this.downloadYouTrackAttachments(
              taskId,
              issue.attachments,
              client,
              ctx
            )
          }

          // Replace remote image URLs with local attachment paths
          replaceRemoteImageUrlsInTask(taskId, ctx, '[youtrack]')
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          result.errors.push(`Issue ${issue.idReadable}: ${msg}`)
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

    const serverUrl = config.server_url as string
    const token = config.api_token as string
    const client = new YouTrackClient(serverUrl, token)

    try {
      const updates: Record<string, unknown> = {}

      if (changedFields.title && typeof changedFields.title === 'string') {
        updates.summary = changedFields.title
      }

      if (changedFields.description && typeof changedFields.description === 'string') {
        updates.description = changedFields.description
      }

      // For custom field updates, we need to use a different approach
      const customFieldUpdates: Array<{ $type: string; name: string; value: unknown }> = []

      if (changedFields.status) {
        const stateValue = localStatusToYouTrack(
          changedFields.status as string
        )
        if (stateValue) {
          customFieldUpdates.push({
            $type: 'StateIssueCustomField',
            name: 'State',
            value: { $type: 'StateBundleElement', name: stateValue }
          })
        }
      }

      if (changedFields.priority) {
        const priorityValue = localPriorityToYouTrack(
          changedFields.priority as string
        )
        if (priorityValue) {
          customFieldUpdates.push({
            $type: 'SingleEnumIssueCustomField',
            name: 'Priority',
            value: { $type: 'EnumBundleElement', name: priorityValue }
          })
        }
      }

      if (customFieldUpdates.length > 0) {
        updates.customFields = customFieldUpdates
      }

      if (Object.keys(updates).length > 0) {
        await client.updateIssue(task.external_id, updates)
      }
    } catch (err) {
      console.error('[youtrack] Export update failed:', err)
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

    const serverUrl = config.server_url as string
    const token = config.api_token as string
    const client = new YouTrackClient(serverUrl, token)

    if (actionId === PluginActionId.OpenInYouTrack) {
      // Fetch the issue to get the readable ID for URL construction
      try {
        const issue = await client.getIssue(task.external_id)
        const url = `${client.getBaseUrl()}/issue/${issue.idReadable}`
        return {
          success: true,
          taskUpdate: { _openUrl: url }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: `Failed to get issue URL: ${msg}` }
      }
    }

    if (actionId === PluginActionId.AddComment) {
      if (!input) {
        return { success: false, error: 'Comment text is required' }
      }
      try {
        await client.addComment(task.external_id, input)
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: `Failed to add comment: ${msg}` }
      }
    }

    if (actionId === PluginActionId.Complete) {
      try {
        await client.updateIssue(task.external_id, {
          customFields: [{
            $type: 'StateIssueCustomField',
            name: 'State',
            value: { $type: 'StateBundleElement', name: 'Done' }
          }]
        })
        return { success: true, taskUpdate: { status: TaskStatus.Completed } }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: `Failed to complete issue: ${msg}` }
      }
    }

    if (actionId === PluginActionId.ChangeState) {
      if (!input) {
        return { success: false, error: 'State value is required' }
      }
      try {
        await client.updateIssue(task.external_id, {
          customFields: [{
            $type: 'StateIssueCustomField',
            name: 'State',
            value: { $type: 'StateBundleElement', name: input }
          }]
        })

        // Map back to local status
        const taskUpdate: Record<string, unknown> = {}
        const localStatus = STATUS_TO_LOCAL[input.toLowerCase()]
        if (localStatus) taskUpdate.status = localStatus

        return {
          success: true,
          taskUpdate:
            Object.keys(taskUpdate).length > 0 ? taskUpdate : undefined
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: `Failed to change state: ${msg}` }
      }
    }

    return { success: false, error: `Unknown action: ${actionId}` }
  }

  async getUsers(
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<SourceUser[]> {
    const serverUrl = config.server_url as string
    const token = config.api_token as string
    if (!serverUrl || !token) return []

    try {
      const client = new YouTrackClient(serverUrl, token)
      const users = await client.getUsers()
      return users.map((u) => ({
        id: u.login,
        email: u.email || '',
        name: u.fullName || u.login
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

    const serverUrl = config.server_url as string
    const token = config.api_token as string
    const client = new YouTrackClient(serverUrl, token)

    try {
      // YouTrack typically has a single Assignee field
      const login = userIds[0]
      if (!login) {
        return { success: false, error: 'No user specified' }
      }

      await client.updateIssue(task.external_id, {
        customFields: [
          {
            $type: 'SingleUserIssueCustomField',
            name: 'Assignee',
            value: { $type: 'User', login }
          }
        ]
      })

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: msg }
    }
  }

  getSetupDocumentation(): string {
    return `# YouTrack Integration Setup

## Overview

Import tasks from a YouTrack project. Supports filtering by state, priority, assignee, type, and custom YQL queries. Works with both YouTrack Cloud and self-hosted instances.

## Prerequisites

- A YouTrack instance (Cloud or self-hosted)
- A permanent token with YouTrack scope

## Setup Steps

### 1. Generate a Permanent Token

See [JetBrains documentation](https://www.jetbrains.com/help/youtrack/server/manage-permanent-token.html) for full details.

1. Open YouTrack and click the **profile icon** (bottom-left)
2. Go to **Profile** > **Account Security**
3. Under **Tokens**, click **New token...**
4. Enter a **Token name** (e.g. "21x Integration")
5. Under **Scope**, select **YouTrack**
6. Click **Create**
7. **Copy the token immediately** -- it won't be shown again

### 2. Configure the Source

1. Enter your **Server URL** (e.g. \`https://youtrack.your-company.com\` or \`https://your-org.youtrack.cloud\`)
2. Paste your **Permanent Token**
3. Select the **Project** from the dropdown
4. Optionally filter by **Assignee**, **State**, **Priority**, or **Type**
5. Optionally add a raw **YQL query** for advanced filtering
6. Click **Save** and **Sync**

## Features

### Smart Filtering
Select filter values for state, priority, assignee, and type. Multiple values for the same field are combined with OR. All field filters and the optional custom YQL query are combined with AND.

### YouTrack Query Language (YQL)
Use the **Additional Query** field to add any valid YQL expression:
- \`#Unresolved\` -- only unresolved issues
- \`sort by: updated desc\` -- sort by last updated
- \`created: {Last week}\` -- issues created in the last week
- \`tag: important\` -- issues with a specific tag

### Incremental Sync
After the first full sync, subsequent syncs only fetch issues updated since the last sync.

### Bidirectional Updates
Changes to title, state, and priority sync back to YouTrack.

### Attachments
File attachments on YouTrack issues are downloaded and stored locally.

## Troubleshooting

### "Authentication failed"
- Verify your permanent token is correct
- Tokens can be revoked -- check Account Security in your profile

### "Access forbidden"
- Your token may lack the YouTrack scope
- You may not have access to the selected project

### No projects appear
- Check that your YouTrack URL is correct and reachable
- Some self-hosted instances restrict admin API access -- contact your admin

### Self-hosted instances
- Use the full URL including any path prefix (e.g. \`https://server.com/youtrack\`)
- The instance must be reachable from your machine (VPN/LAN)
`
  }

  // ── Private helpers ────────────────────────────────────────

  /**
   * Download YouTrack attachments and save them as task attachments.
   * Skips files that have already been downloaded (by URL).
   */
  private async downloadYouTrackAttachments(
    taskId: string,
    attachments: YouTrackAttachment[],
    client: YouTrackClient,
    ctx: PluginContext
  ): Promise<void> {
    const task = ctx.db.getTask(taskId)
    if (!task) return

    const existingUrls = buildNormalizedUrlSet(
      (task.attachments || []) as unknown as Array<Record<string, unknown>>,
      'youtrack_url'
    )

    for (const att of attachments) {
      try {
        const attUrl = att.url.startsWith('http')
          ? att.url
          : `${client.getBaseUrl()}${att.url}`
        if (existingUrls.has(normalizeUrlForComparison(attUrl))) continue

        const { buffer, filename, contentType } =
          await client.downloadAttachment(att.url)

        saveTaskAttachment(ctx, taskId, {
          buffer,
          filename: att.name || filename,
          // Magic bytes win over the reported type.
          mimeType: sniffMimeType(buffer) || att.mimeType || contentType,
          extra: { youtrack_url: attUrl }
        })
      } catch (err) {
        console.error(
          `[youtrack] Failed to download attachment "${att.name}":`,
          err
        )
      }
    }
  }
}
