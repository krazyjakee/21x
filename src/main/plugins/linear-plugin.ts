/**
 * Linear Task Source Plugin
 *
 * Integrates Linear.app as a task source using OAuth2 authentication.
 * Supports importing issues, bidirectional sync, and Linear-specific actions.
 */

import { extname } from 'path'
import type { TaskRecord } from '../database'
import { TaskStatus } from '../../shared/constants'
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
import { LEGACY_OAUTH_CALLBACK_URL, OAUTH_CALLBACK_URL } from '../app-identity'
import { LinearClient, type LinearIssue } from './linear-client'
import { replaceRemoteImageUrlsInTask } from './replace-image-urls'
import { upsertSourcedTask } from './sourced-tasks'
import { normalizeUrlForComparison, buildNormalizedUrlSet } from './url-utils'
import { saveTaskAttachment } from './attachments'
import { hasKnownExtension, mimeTypeForPath, sniffMimeType } from '../mime'

export class LinearPlugin implements TaskSourcePlugin {
  id = 'linear'
  displayName = 'Linear'
  description = 'Import and manage issues from Linear.app using OAuth2'
  icon = 'Zap'

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: '_setup_link',
        label: 'Setup Instructions',
        type: 'text',
        required: false,
        placeholder: 'https://linear.app/settings/api/applications/new',
        description: '👉 Click to create a new OAuth application in Linear. Set redirect URI to: twentyonex://oauth/callback'
      },
      {
        key: 'redirect_uri',
        label: 'Redirect URI',
        type: 'select',
        required: false,
        default: OAUTH_CALLBACK_URL,
        options: [
          { value: OAUTH_CALLBACK_URL, label: OAUTH_CALLBACK_URL },
          { value: LEGACY_OAUTH_CALLBACK_URL, label: `${LEGACY_OAUTH_CALLBACK_URL} (legacy, removed in the next release)` }
        ],
        description: 'Must match the Callback URL of your Linear OAuth application. Update the Linear app to twentyonex://oauth/callback; the legacy nuanu:// URI still works for one release.'
      },
      {
        key: 'client_id',
        label: 'OAuth Client ID',
        type: 'text',
        required: true,
        description: 'Copy the Client ID from your Linear OAuth application'
      },
      {
        key: 'client_secret',
        label: 'OAuth Client Secret',
        type: 'password',
        required: true,
        description: 'Copy the Client Secret from your Linear OAuth application (kept secure locally)'
      },
      {
        key: 'scope',
        label: 'Permissions',
        type: 'select',
        default: 'read,write',
        options: [
          { value: 'read', label: 'Read' },
          { value: 'write', label: 'Write' },
          { value: 'read,write', label: 'Read + Write' },
          { value: 'read,write,issues:create', label: 'Read + Write + Create Issues' },
          { value: 'read,write,issues:create,comments:create', label: 'All Permissions' }
        ],
        description: 'OAuth scopes for Linear API access'
      },
      {
        key: 'assignee_id',
        label: 'Assigned to (Optional)',
        type: 'dynamic-select',
        optionsResolver: 'users',
        required: false,
        description: 'Filter issues by assignee. Leave empty to sync all issues.'
      }
    ]
  }

  async resolveOptions(
    resolverKey: string,
    _config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    if (resolverKey !== 'users') return []
    // Users can only be listed once the source exists and OAuth has completed.
    if (!ctx.sourceId || !ctx.oauthManager) return []

    try {
      const token = await ctx.oauthManager.getValidToken(ctx.sourceId)
      if (!token) return []
      const users = await new LinearClient(token).getUsers()
      return users.map(u => ({ value: u.id, label: u.displayName || u.name || u.email }))
    } catch (error) {
      console.error('[linear-plugin] Failed to fetch users:', error)
      return []
    }
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: PluginActionId.ChangeStatus,
        label: 'Change Status',
        icon: 'ArrowRight',
        requiresInput: true,
        inputLabel: 'New Status',
        inputPlaceholder: 'e.g., In Progress, Done'
      },
      {
        id: PluginActionId.UpdatePriority,
        label: 'Update Priority',
        icon: 'Flag',
        requiresInput: true,
        inputLabel: 'Priority',
        inputPlaceholder: 'e.g., Urgent, High, Medium, Low'
      },
      {
        id: PluginActionId.AddComment,
        label: 'Add Comment',
        icon: 'MessageSquare',
        requiresInput: true,
        inputLabel: 'Comment',
        inputPlaceholder: 'Enter your comment...'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }

    if (!ctx.oauthManager) {
      result.errors.push('OAuth manager not available')
      return result
    }

    try {
      const token = await ctx.oauthManager.getValidToken(sourceId)
      if (!token) {
        result.errors.push('OAuth token expired. Please re-authenticate.')
        return result
      }

      const client = new LinearClient(token)
      const issues = await client.getIssues(config.assignee_id as string | undefined)

      for (const issue of issues) {
        try {
          const mapped = this.mapLinearIssue(issue)
          const upserted = upsertSourcedTask(ctx, sourceId, issue.id, mapped, {
            title: issue.title,
            source: 'Linear'
          })
          if (!upserted) {
            console.error('[linear-plugin] Failed to create task:', issue.id)
            continue
          }
          const taskId = upserted.task.id
          if (upserted.created) result.imported++
          else result.updated++

          const fileUrls = this.extractLinearFileUrls(issue)
          if (fileUrls.length > 0) {
            await this.downloadLinearFiles(taskId, fileUrls, client, ctx)
          }
          if (issue.attachments?.nodes && issue.attachments.nodes.length > 0) {
            await this.downloadAttachments(taskId, issue.attachments.nodes, client, ctx)
          }

          // Point images at local copies so they survive remote link expiry.
          replaceRemoteImageUrlsInTask(taskId, ctx, '[linear-plugin]')
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error'
          result.errors.push(`Failed to import issue "${issue.title}": ${errorMsg}`)
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      result.errors.push(`Import failed: ${errorMsg}`)
    }

    return result
  }

  async exportUpdate(
    task: TaskRecord,
    changedFields: Record<string, unknown>,
    _config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<void> {
    if (!ctx.oauthManager || !task.source_id || !task.external_id) return

    try {
      const token = await ctx.oauthManager.getValidToken(task.source_id)
      if (!token) return

      const client = new LinearClient(token)
      const updates: {
        stateId?: string
        priority?: number
        title?: string
        description?: string
      } = {}

      if (changedFields.status) {
        const issue = await client.getIssue(task.external_id)
        if (issue && issue.team?.id) {
          const states = await client.getWorkflowStates(issue.team.id)
          const targetState = this.findStateForStatus(states, changedFields.status as string)
          if (targetState) {
            updates.stateId = targetState.id
          }
        }
      }

      if (changedFields.priority) {
        updates.priority = this.mapPriorityToLinear(changedFields.priority as string)
      }
      if (changedFields.title) {
        updates.title = changedFields.title as string
      }
      if (changedFields.description) {
        updates.description = changedFields.description as string
      }

      if (Object.keys(updates).length > 0) {
        await client.updateIssue(task.external_id, updates)
      }
    } catch (err) {
      console.error('[linear-plugin] Export update failed:', err)
    }
  }

  /**
   * Resolve user input for the Change Status action: a Linear workflow state
   * name (case-insensitive), or a local status such as "In Progress" or "Done".
   */
  private findStateForInput(
    states: Array<{ id: string; name: string; type: string }>,
    input: string
  ): { id: string; name: string; type: string } | null {
    const wanted = input.trim().toLowerCase()
    const byName = states.find(s => s.name.toLowerCase() === wanted)
    if (byName) return byName
    const normalized = wanted.replace(/[\s-]+/g, '_')
    return this.findStateForStatus(states, normalized === 'done' ? 'completed' : normalized)
  }

  private findStateForStatus(
    states: Array<{ id: string; name: string; type: string }>,
    localStatus: string
  ): { id: string; name: string; type: string } | null {
    const statusLower = localStatus.toLowerCase()

    if (statusLower === 'completed') {
      const completedState = states.find(s =>
        s.type === 'completed' ||
        s.name.toLowerCase().includes('done') ||
        s.name.toLowerCase().includes('completed')
      )
      return completedState || null
    }

    if (statusLower === 'agent_working' || statusLower === 'in_progress') {
      const inProgressState = states.find(s =>
        s.type === 'started' ||
        s.name.toLowerCase().includes('progress') ||
        s.name.toLowerCase().includes('started')
      )
      return inProgressState || null
    }

    if (statusLower === 'not_started' || statusLower === 'todo') {
      const todoState = states.find(s =>
        s.type === 'unstarted' ||
        s.name.toLowerCase().includes('todo') ||
        s.name.toLowerCase().includes('backlog')
      )
      return todoState || null
    }

    return null
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    _config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ActionResult> {
    if (!ctx.oauthManager || !task.source_id || !task.external_id) {
      return { success: false, error: 'OAuth manager or task source not available' }
    }

    try {
      const token = await ctx.oauthManager.getValidToken(task.source_id)
      if (!token) {
        return { success: false, error: 'OAuth token expired. Please re-authenticate.' }
      }

      const client = new LinearClient(token)

      switch (actionId) {
        case PluginActionId.AddComment:
          if (!input) {
            return { success: false, error: 'Comment text is required' }
          }
          await client.addComment(task.external_id, input)
          return { success: true }

        case PluginActionId.UpdatePriority:
          if (!input) {
            return { success: false, error: 'Priority is required' }
          }
          const priority = this.parsePriorityInput(input)
          if (priority === null) {
            return { success: false, error: 'Invalid priority. Use: Urgent, High, Medium, Low, or None' }
          }
          await client.updateIssue(task.external_id, { priority })
          return {
            success: true,
            taskUpdate: { priority: this.mapPriorityFromLinear(priority) }
          }

        case PluginActionId.Complete: {
          const issue = await client.getIssue(task.external_id)
          if (issue?.team?.id) {
            const states = await client.getWorkflowStates(issue.team.id)
            const doneState = this.findStateForStatus(states, 'completed')
            if (doneState) {
              await client.updateIssue(task.external_id, { stateId: doneState.id })
            }
          }
          return { success: true, taskUpdate: { status: TaskStatus.Completed } }
        }

        case PluginActionId.ChangeStatus: {
          if (!input?.trim()) {
            return { success: false, error: 'Status is required' }
          }
          const issue = await client.getIssue(task.external_id)
          if (!issue?.team?.id) {
            return { success: false, error: 'Could not load the Linear issue team' }
          }
          const states = await client.getWorkflowStates(issue.team.id)
          const targetState = this.findStateForInput(states, input)
          if (!targetState) {
            return { success: false, error: `No Linear workflow state matches "${input.trim()}"` }
          }
          await client.updateIssue(task.external_id, { stateId: targetState.id })
          const status = targetState.type === 'completed' || targetState.type === 'canceled'
            ? TaskStatus.Completed
            : this.mapStatusFromLinear(targetState.name)
          return { success: true, taskUpdate: { status } }
        }

        default:
          return { success: false, error: `Unknown action: ${actionId}` }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: `Action failed: ${errorMsg}` }
    }
  }

  /**
   * Extract Linear file upload URLs from issue description and comments
   */
  private extractLinearFileUrls(issue: LinearIssue): Array<{ url: string; filename: string }> {
    const fileUrls: Array<{ url: string; filename: string }> = []

    if (issue.description) {
      const extracted = this.extractFilesFromMarkdown(issue.description)
      fileUrls.push(...extracted)
    }

    if (issue.comments?.nodes) {
      issue.comments.nodes.forEach(comment => {
        if (comment.body) {
          const extracted = this.extractFilesFromMarkdown(comment.body)
          fileUrls.push(...extracted)
        }
      })
    }

    const uniqueUrls = new Map<string, string>()
    fileUrls.forEach(({ url, filename }) => {
      if (!uniqueUrls.has(url)) {
        uniqueUrls.set(url, filename)
      }
    })

    return Array.from(uniqueUrls.entries()).map(([url, filename]) => ({ url, filename }))
  }

  /**
   * Extract files from markdown content, preserving filenames from markdown syntax
   */
  private extractFilesFromMarkdown(markdown: string): Array<{ url: string; filename: string }> {
    const files: Array<{ url: string; filename: string }> = []

    // Pattern 1: ![alt text](https://uploads.linear.app/...)
    const imagePattern = /!\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^\s)]+)\)/g
    let match: RegExpExecArray | null
    while ((match = imagePattern.exec(markdown)) !== null) {
      const altText = match[1]
      const url = match[2]
      const filename = altText && altText.trim() ? altText.trim() : this.extractFilenameFromLinearUrl(url)
      files.push({ url, filename })
    }

    // Pattern 2: [link text](https://uploads.linear.app/...)
    const linkPattern = /\[([^\]]+)\]\((https:\/\/uploads\.linear\.app\/[^\s)]+)\)/g
    while ((match = linkPattern.exec(markdown)) !== null) {
      const linkText = match[1]
      const url = match[2]
      if (!files.some(f => f.url === url)) {
        const filename = linkText && linkText.trim() ? linkText.trim() : this.extractFilenameFromLinearUrl(url)
        files.push({ url, filename })
      }
    }

    // Pattern 3: Plain URLs without markdown syntax
    const plainUrlPattern = /https:\/\/uploads\.linear\.app\/[^\s)]+/g
    const plainUrls = markdown.match(plainUrlPattern) || []
    plainUrls.forEach(url => {
      if (!files.some(f => f.url === url)) {
        const filename = this.extractFilenameFromLinearUrl(url)
        files.push({ url, filename })
      }
    })

    return files
  }

  /**
   * Extract filename from Linear upload URL
   */
  private extractFilenameFromLinearUrl(url: string): string {
    // Linear URLs are like: https://uploads.linear.app/{id}/{id}/{id}
    const parts = url.split('/')
    const lastPart = parts[parts.length - 1]

    if (lastPart && lastPart.includes('.')) {
      return lastPart
    }

    return `linear-file-${lastPart || Date.now()}`
  }

  /**
   * Extract attachment ID from Linear upload URL
   * URLs are like: https://uploads.linear.app/{org}/{team}/{attachment-id}
   */
  private extractAttachmentIdFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url)
      if (!urlObj.hostname.includes('linear.app')) return null

      const parts = urlObj.pathname.split('/').filter(p => p)
      const lastPart = parts[parts.length - 1]

      if (lastPart && /^[a-f0-9-]{36}$/i.test(lastPart)) {
        return lastPart
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Download files uploaded to Linear (referenced from markdown) as task attachments.
   */
  private async downloadLinearFiles(
    taskId: string,
    files: Array<{ url: string; filename: string }>,
    client: LinearClient,
    ctx: PluginContext
  ): Promise<void> {
    const task = ctx.db.getTask(taskId)
    if (!task) return

    // Signed query params change on every API call, so compare without them.
    const existingUrls = buildNormalizedUrlSet(
      (task.attachments || []) as unknown as Array<Record<string, unknown>>,
      'linear_url'
    )

    for (const file of files) {
      if (existingUrls.has(normalizeUrlForComparison(file.url))) continue

      try {
        let fallbackName = file.filename
        const attachmentId = this.extractAttachmentIdFromUrl(file.url)
        if (attachmentId) {
          const metadata = await client.getAttachmentMetadata(attachmentId)
          if (metadata?.title) fallbackName = metadata.title
        }

        const { buffer, filename, contentType } = await client.downloadAttachment(file.url)
        const actualFilename = filename || fallbackName
        const saved = saveTaskAttachment(ctx, taskId, {
          buffer,
          filename: actualFilename,
          mimeType: contentType || sniffMimeType(buffer) || mimeTypeForPath(actualFilename),
          extra: { linear_url: file.url }
        })
        existingUrls.add(normalizeUrlForComparison(file.url))
        console.log(`[linear-plugin] Saved Linear file: ${actualFilename} (${saved.size} bytes, ${saved.mime_type})`)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[linear-plugin] Failed to download Linear file ${file.filename}:`, errorMsg)
      }
    }
  }

  /**
   * Download issue link attachments as task attachments.
   */
  private async downloadAttachments(
    taskId: string,
    attachments: Array<{ id: string; url: string; title?: string; subtitle?: string; metadata?: { size?: number } }>,
    client: LinearClient,
    ctx: PluginContext
  ): Promise<void> {
    const task = ctx.db.getTask(taskId)
    if (!task) return

    const existingUrls = buildNormalizedUrlSet(
      (task.attachments || []) as unknown as Array<Record<string, unknown>>,
      'linear_url'
    )

    for (const attachment of attachments) {
      if (existingUrls.has(normalizeUrlForComparison(attachment.url))) continue

      try {
        const { buffer, filename, contentType } = await client.downloadAttachment(attachment.url)
        const actualFilename = filename || attachment.title || attachment.subtitle || `attachment-${attachment.id}`
        const urlPath = attachment.url.split(/[?#]/)[0]
        const ext = extname(actualFilename) || (hasKnownExtension(urlPath) ? extname(urlPath) : '')
        const finalFilename = ext ? actualFilename : `${actualFilename}.bin`

        const saved = saveTaskAttachment(ctx, taskId, {
          buffer,
          filename: finalFilename,
          size: attachment.metadata?.size,
          mimeType: contentType || mimeTypeForPath(finalFilename),
          extra: { linear_url: attachment.url }
        })
        existingUrls.add(normalizeUrlForComparison(attachment.url))
        console.log(`[linear-plugin] Saved attachment: ${finalFilename} (${saved.size} bytes)`)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[linear-plugin] Failed to download attachment ${attachment.title || attachment.url}:`, errorMsg)
      }
    }
  }

  /**
   * Map Linear issue to local task format
   */
  private mapLinearIssue(issue: LinearIssue): Partial<TaskRecord> {
    return {
      title: issue.title,
      description: issue.description || '',
      status: this.mapStatusFromLinear(issue.state.name),
      priority: this.mapPriorityFromLinear(issue.priority),
      assignee: issue.assignee?.displayName || '',
      due_date: issue.dueDate || null,
      labels: issue.labels?.nodes.map(l => l.name) || []
    }
  }

  /**
   * Map Linear status to local status
   */
  private mapStatusFromLinear(linearStatus: string): string {
    const lower = linearStatus.toLowerCase()

    if (lower.includes('backlog') || lower.includes('todo')) {
      return 'not_started'
    }
    if (lower.includes('progress') || lower.includes('started')) {
      return 'agent_working'
    }
    if (lower.includes('review')) {
      return 'ready_for_review'
    }
    if (lower.includes('done') || lower.includes('complete') || lower.includes('canceled')) {
      return 'completed'
    }

    // Default to not_started for unknown statuses
    return 'not_started'
  }

  /**
   * Map Linear priority to local priority
   * Linear: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
   */
  private mapPriorityFromLinear(linearPriority: number): string {
    const priorityMap: Record<number, string> = {
      0: 'low',
      1: 'critical',
      2: 'high',
      3: 'medium',
      4: 'low'
    }
    return priorityMap[linearPriority] || 'medium'
  }

  /**
   * Map local priority to Linear priority
   */
  private mapPriorityToLinear(localPriority: string): number {
    const priorityMap: Record<string, number> = {
      'critical': 1,
      'high': 2,
      'medium': 3,
      'low': 4
    }
    return priorityMap[localPriority] || 3
  }

  /**
   * Parse user input for priority (e.g., "Urgent", "High", "2")
   */
  private parsePriorityInput(input: string): number | null {
    const lower = input.toLowerCase().trim()

    const priorityMap: Record<string, number> = {
      'urgent': 1,
      'critical': 1,
      'high': 2,
      'medium': 3,
      'med': 3,
      'low': 4,
      'none': 0,
      'no priority': 0
    }

    if (priorityMap[lower] !== undefined) {
      return priorityMap[lower]
    }

    // Try parsing as number
    const num = parseInt(input, 10)
    if (!isNaN(num) && num >= 0 && num <= 4) {
      return num
    }

    return null
  }

  /**
   * Returns markdown documentation for setting up Linear integration
   */
  getSetupDocumentation(): string {
    return `# Linear Integration Setup Guide

## Overview

Connect your Linear workspace to sync issues as tasks. This integration uses OAuth 2.0 for secure authentication.

## Prerequisites

- A Linear workspace (free or paid)
- Admin access to create OAuth applications

## Setup Steps

### Step 1: Create a Linear OAuth Application

1. Go to [Linear Settings → API → Applications](https://linear.app/settings/api/applications/new)
2. Click **Create New Application**
3. Fill in the application details:
   - **Application name**: \`21x\` (or your preferred name)
   - **Description**: "Task management integration"
   - **Callback URLs**: \`twentyonex://oauth/callback\` (apps created before 21x used \`nuanu://oauth/callback\`; update them, or pick the legacy Redirect URI for one more release)

### Step 2: Configure OAuth Credentials

1. After creating the application, you'll see your **Client ID** and **Client Secret**
2. Copy the **Client ID** and paste it into the form
3. Copy the **Client Secret** and paste it into the form
4. **Important**: Keep your Client Secret secure - it's shown only once!

### Step 3: Select Permissions

Choose the OAuth scopes you need:

- **Read**: View issues, teams, and users
- **Write**: Update issue status, priority, and assignees
- **Read + Write**: Recommended for bidirectional sync
- **Issues:Create**: Allow creating new issues from tasks
- **Comments:Create**: Allow adding comments to issues

### Step 4: Connect to Linear

1. Click the **Connect to Linear** button
2. A browser window will open with Linear's authorization page
3. Review the requested permissions
4. Click **Authorize** to grant access
5. You'll be redirected back to the app automatically

### Step 5: Optional Filters

After connecting, you can filter which issues to sync:

- **Assigned to**: Only sync issues assigned to a specific user
- Leave filters empty to sync all issues you have access to

## Features

### Import Issues
- Automatically imports issues from Linear
- Maps Linear fields to task properties:
  - Status (Backlog, Todo, In Progress, Done, Canceled)
  - Priority (Urgent, High, Medium, Low)
  - Assignee, due date, labels

### Bidirectional Sync
- Changes in the app sync back to Linear
- Update priority, status, comments

### Attachments
- Downloads attachments from Linear issues
- Stores them locally with your tasks

## Troubleshooting

### Browser doesn't open for OAuth
- Check that your default browser is set correctly
- Try copying the authorization URL manually

### "Invalid redirect URI" error
- Ensure the redirect URI in Linear is exactly: \`twentyonex://oauth/callback\` (or matches the Redirect URI selected in the source settings)
- No trailing slash, correct protocol scheme

### Issues not importing
- Check that you have access to the Linear workspace
- Verify OAuth token is connected (green checkmark)
- Try clicking **Sync Now** to force a refresh

### Token expired
- OAuth tokens are valid for 24 hours
- The app will automatically refresh your token
- If auto-refresh fails, reconnect via **Connect to Linear**

## Support

For more help:
- [Linear API Documentation](https://developers.linear.app/docs)
- [OAuth Guide](https://developers.linear.app/docs/oauth)
`
  }
}
