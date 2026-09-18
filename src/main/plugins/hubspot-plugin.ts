/**
 * HubSpot Tickets Task Source Plugin
 *
 * Integrates HubSpot CRM Tickets as a task source.
 * Supports dual authentication: OAuth2 (recommended) + Private App tokens (fallback).
 * Enables importing tickets, syncing status/priority, and executing ticket actions.
 */

import type { TaskRecord } from '../database'
import { TaskStatus } from '../../shared/constants'
import { replaceRemoteImageUrlsInTask } from './replace-image-urls'
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
import { HubSpotClient, type HubSpotAttachment, type HubSpotTicket, type HubSpotPipeline } from './hubspot-client'
import { saveTaskAttachment } from './attachments'
import { extensionForMimeType, hasKnownExtension, mimeTypeForPath, sniffMimeType } from '../mime'

export class HubSpotPlugin implements TaskSourcePlugin {
  id = 'hubspot'
  displayName = 'HubSpot'
  description = 'Import and manage support tickets from HubSpot CRM'
  icon = 'Ticket'

  // Cache pipelines to map stage IDs to ticket states (OPEN/CLOSED)
  private pipelineCache: Map<string, HubSpotPipeline[]> = new Map()

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'auth_type',
        label: 'Authentication Method',
        type: 'select',
        required: true,
        default: 'oauth',
        options: [
          { value: 'oauth', label: 'OAuth 2.0 (Recommended)' },
          { value: 'private_app', label: 'Private App Access Token' }
        ],
        description: 'Choose how to authenticate with HubSpot'
      },
      // OAuth fields
      {
        key: '_oauth_setup_link',
        label: 'OAuth Setup',
        type: 'text',
        required: false,
        placeholder: 'https://developers.hubspot.com/docs/getting-started/quickstart',
        description:
          '👉 Follow the HubSpot quickstart guide at https://developers.hubspot.com/docs/getting-started/quickstart. Set redirect URI to: http://localhost:3000/callback (or ports 3000-3010)'
      },
      {
        key: 'client_id',
        label: 'OAuth Client ID',
        type: 'text',
        required: false,
        description: 'Copy from your HubSpot OAuth app settings'
      },
      {
        key: 'client_secret',
        label: 'OAuth Client Secret',
        type: 'password',
        required: false,
        description: 'Copy from your HubSpot OAuth app settings (stored securely)'
      },
      // Private App fields
      {
        key: 'access_token',
        label: 'Private App Access Token',
        type: 'password',
        required: false,
        description: 'Get from Settings > Integrations > Private Apps. Requires "tickets", "crm.objects.contacts.read", "crm.objects.owners.read", "files", and "forms-uploaded-files" scopes.'
      },
      // Filter options
      {
        key: 'pipeline_id',
        label: 'Pipeline Filter (Optional)',
        type: 'dynamic-select',
        optionsResolver: 'pipelines',
        required: false,
        description: 'Filter tickets by pipeline. Leave empty to sync all pipelines.'
      },
      {
        key: 'owner_id',
        label: 'Owner Filter (Optional)',
        type: 'dynamic-select',
        optionsResolver: 'owners',
        required: false,
        description: 'Filter tickets by owner. Leave empty to sync all tickets.'
      }
    ]
  }

  async resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    // Options can only be fetched once the source exists and is authenticated.
    if (!ctx.sourceId) return []

    try {
      const token = await this.getAccessToken(ctx.sourceId, config, ctx)
      if (!token) return []

      const client = new HubSpotClient(token)

      if (resolverKey === 'owners') {
        const owners = await client.getOwners()
        return owners.map((o) => ({
          value: o.id,
          label: `${o.firstName} ${o.lastName}`.trim() || o.email
        }))
      }

      if (resolverKey === 'pipelines') {
        const pipelines = await client.getPipelines()
        this.pipelineCache.set(ctx.sourceId, pipelines)

        return pipelines.map((p) => ({
          value: p.id,
          label: p.label
        }))
      }

      return []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[hubspot-plugin] Failed to resolve options for ${resolverKey}:`, errorMsg)
      return []
    }
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: PluginActionId.AddNote,
        label: 'Add Note',
        icon: 'MessageSquare',
        requiresInput: true,
        inputLabel: 'Note',
        inputPlaceholder: 'Enter note...'
      },
      {
        id: PluginActionId.UpdatePriority,
        label: 'Update Priority',
        icon: 'Flag',
        requiresInput: true,
        inputLabel: 'Priority',
        inputPlaceholder: 'HIGH, MEDIUM, or LOW'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }

    try {
      const token = await this.getAccessToken(sourceId, config, ctx)
      if (!token) {
        result.errors.push('Authentication failed. Please configure OAuth or provide a Private App token.')
        return result
      }

      const client = new HubSpotClient(token)

      const pipelines = await client.getPipelines()
      this.pipelineCache.set(sourceId, pipelines)

      // The first sync imports open tickets only; later syncs fetch every
      // ticket (open or closed) modified in the last 24 hours.
      const lastSyncedAt = ctx.db.getTaskSource(sourceId)?.last_synced_at
      const modifiedAfter = lastSyncedAt
        ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        : undefined
      const onlyOpen = !lastSyncedAt

      const pipelineId = config.pipeline_id as string | undefined
      const ownerId = config.owner_id as string | undefined
      const tickets = await client.getTickets(pipelineId, ownerId, modifiedAfter, onlyOpen)

      for (const ticket of tickets) {
        try {
          let ownerName = ''
          if (ticket.properties.hubspot_owner_id) {
            const owner = await client.getOwner(ticket.properties.hubspot_owner_id)
            if (owner) {
              ownerName = `${owner.firstName} ${owner.lastName}`.trim() || owner.email
            }
          }

          let contactInfo = ''
          if (ticket.associations?.contacts?.results?.[0]) {
            const contactId = ticket.associations.contacts.results[0].id
            const contact = await client.getContact(contactId)
            if (contact) {
              const name = `${contact.properties.firstname || ''} ${contact.properties.lastname || ''}`.trim()
              contactInfo = name || contact.properties.email || ''
            }
          }

          const mapped = await this.mapHubSpotTicket(ticket, ownerName, contactInfo, pipelines, client)

          // Incremental syncs also return recently closed tickets. Closing an
          // already-imported ticket completes its task; a ticket that was
          // closed before it was ever imported is not brought in.
          if (mapped.status === TaskStatus.Completed && !ctx.db.getTaskByExternalId(sourceId, ticket.id)) {
            continue
          }

          const upserted = upsertSourcedTask(ctx, sourceId, ticket.id, mapped, {
            title: ticket.properties.subject || 'Untitled Ticket',
            source: 'HubSpot'
          })
          if (!upserted) {
            console.error('[hubspot-plugin] Failed to create task:', ticket.id)
            continue
          }
          const taskId = upserted.task.id
          if (upserted.created) result.imported++
          else result.updated++

          const hubspotAttachments = await client.getTicketAttachments(ticket.id)
          if (hubspotAttachments.length > 0) {
            await this.downloadAttachments(taskId, hubspotAttachments, client, ctx)
          }

          replaceRemoteImageUrlsInTask(taskId, ctx, '[hubspot-plugin]')
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error'
          const ticketTitle = ticket.properties.subject || 'Unknown ticket'
          result.errors.push(`Failed to import "${ticketTitle}": ${errorMsg}`)
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
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<void> {
    if (!task.external_id) {
      console.log('[hubspot-plugin] Task has no external_id, skipping export')
      return
    }

    const token = await this.getAccessToken(task.source_id!, config, ctx)
    if (!token) {
      console.error('[hubspot-plugin] No access token, cannot export update')
      return
    }

    const client = new HubSpotClient(token)

    if ('status' in changedFields && changedFields.status === 'completed') {
      try {
        const pipelines = this.pipelineCache.get(task.source_id!) || await client.getPipelines()

        const ticket = await client.getTicket(task.external_id)
        if (!ticket) {
          console.error('[hubspot-plugin] Ticket not found in HubSpot')
          return
        }

        const ticketPipeline = pipelines.find((p) => p.id === ticket.properties.hs_pipeline)
        if (!ticketPipeline) {
          console.error('[hubspot-plugin] Pipeline not found for ticket')
          return
        }

        const closedStage = ticketPipeline.stages.find((s) => s.metadata.ticketState === 'CLOSED')
        if (!closedStage) {
          console.error('[hubspot-plugin] No CLOSED stage found in pipeline')
          return
        }

        const updatePayload: Record<string, unknown> = { hs_pipeline_stage: closedStage.id }
        if (task.resolution) updatePayload.hs_resolution = task.resolution
        await client.updateTicket(task.external_id, updatePayload)

        console.log(`[hubspot-plugin] Closed HubSpot ticket ${task.external_id}${task.resolution ? ' with resolution' : ''}`)
      } catch (err) {
        console.error('[hubspot-plugin] Failed to close ticket:', err)
      }
    }

    if ('resolution' in changedFields) {
      try {
        await client.updateTicket(task.external_id, {
          hs_resolution: changedFields.resolution || ''
        })
        console.log(`[hubspot-plugin] Updated resolution for ticket ${task.external_id}`)
      } catch (err) {
        console.error('[hubspot-plugin] Failed to update resolution:', err)
      }
    }

    // Only unassignment can be exported here: the assignee is a display name
    // that cannot be mapped back to an owner ID. reassignTask handles the rest.
    if ('assignee' in changedFields && typeof changedFields.assignee === 'string') {
      try {
        const assigneeDisplay = changedFields.assignee as string
        if (!assigneeDisplay) {
          await client.updateTicket(task.external_id, { hubspot_owner_id: '' })
          console.log(`[hubspot-plugin] Unassigned ticket ${task.external_id}`)
        }
      } catch (err) {
        console.error('[hubspot-plugin] Failed to update assignee:', err)
      }
    }
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    input: string | undefined,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ActionResult> {
    if (!task.source_id || !task.external_id) {
      return { success: false, error: 'Task not linked to HubSpot' }
    }

    try {
      const token = await this.getAccessToken(task.source_id, config, ctx)
      if (!token) {
        return { success: false, error: 'Authentication failed' }
      }

      const client = new HubSpotClient(token)

      switch (actionId) {
        case PluginActionId.Complete:
          // Completion is handled via exportUpdate when the local task status
          // changes to Completed (moves ticket to CLOSED pipeline stage).
          // Return success so the caller can proceed with the local update.
          return { success: true, taskUpdate: { status: TaskStatus.Completed } }

        case PluginActionId.AddNote:
          if (!input) {
            return { success: false, error: 'Note text is required' }
          }
          await client.addTicketNote(task.external_id, input)
          return { success: true }

        case PluginActionId.UpdatePriority:
          if (!input) {
            return { success: false, error: 'Priority is required' }
          }
          const priority = input.toUpperCase()
          if (!['HIGH', 'MEDIUM', 'LOW'].includes(priority)) {
            return { success: false, error: 'Invalid priority. Use: HIGH, MEDIUM, or LOW' }
          }
          await client.updateTicket(task.external_id, {
            hs_ticket_priority: priority
          })
          return {
            success: true,
            taskUpdate: { priority: this.mapPriorityFromHubSpot(priority) }
          }

        default:
          return { success: false, error: `Unknown action: ${actionId}` }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: `Action failed: ${errorMsg}` }
    }
  }

  async getUsers(
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<import('../../shared/types').SourceUser[]> {
    if (!ctx.sourceId) {
      console.log('[hubspot-plugin] No source ID, cannot fetch users')
      return []
    }

    try {
      const token = await this.getAccessToken(ctx.sourceId, config, ctx)
      if (!token) {
        console.log('[hubspot-plugin] No access token, cannot fetch users')
        return []
      }

      const client = new HubSpotClient(token)
      const owners = await client.getOwners()

      return owners.map((o) => ({
        id: o.id,
        email: o.email,
        name: `${o.firstName} ${o.lastName}`.trim() || o.email
      }))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[hubspot-plugin] Failed to fetch users:', errorMsg)
      return []
    }
  }

  async reassignTask(
    task: TaskRecord,
    userIds: string[],
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<import('../../shared/types').ReassignResult> {
    if (!task.external_id) {
      return { success: false, error: 'Task not linked to HubSpot' }
    }

    if (!userIds || userIds.length === 0) {
      return { success: false, error: 'No user IDs provided' }
    }

    try {
      const token = await this.getAccessToken(task.source_id!, config, ctx)
      if (!token) {
        return { success: false, error: 'Authentication failed' }
      }

      const client = new HubSpotClient(token)

      // HubSpot tickets have a single owner.
      const ownerId = userIds[0]
      await client.updateTicket(task.external_id, {
        hubspot_owner_id: ownerId
      })

      console.log(`[hubspot-plugin] Reassigned ticket ${task.external_id} to owner ${ownerId}`)
      return { success: true }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[hubspot-plugin] Failed to reassign ticket:', errorMsg)
      return { success: false, error: `Reassignment failed: ${errorMsg}` }
    }
  }

  /**
   * Get access token based on auth type (OAuth or Private App)
   */
  private async getAccessToken(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<string | null> {
    const authType = config.auth_type as string

    if (authType === 'oauth') {
      if (!ctx.oauthManager) {
        console.error('[hubspot-plugin] OAuth manager not available')
        return null
      }
      return await ctx.oauthManager.getValidToken(sourceId)
    } else if (authType === 'private_app') {
      return (config.access_token as string) || null
    }

    return null
  }

  /**
   * Map HubSpot ticket to local task format
   */
  private async mapHubSpotTicket(
    ticket: HubSpotTicket,
    ownerName: string,
    contactInfo: string,
    pipelines: HubSpotPipeline[],
    client: HubSpotClient
  ): Promise<Partial<TaskRecord>> {
    const parts: string[] = []

    if (ticket.properties.content) {
      parts.push(ticket.properties.content)
      parts.push('')
      parts.push('---')
      parts.push('')
    }

    parts.push('## 📋 Ticket Details')
    parts.push('')

    if (ticket.properties.hs_pipeline_stage) {
      let statusDisplay = ticket.properties.hs_pipeline_stage
      for (const pipeline of pipelines) {
        const stage = pipeline.stages.find((s) => s.id === ticket.properties.hs_pipeline_stage)
        if (stage) {
          statusDisplay = `${pipeline.label} → ${stage.label}`
          break
        }
      }
      parts.push(`**Status:** ${statusDisplay}`)
    }

    if (contactInfo) {
      parts.push(`**Contact:** ${contactInfo}`)
    }

    if (ticket.properties.createdate) {
      const created = new Date(ticket.properties.createdate)
      parts.push(`**Created:** ${created.toLocaleString()}`)
    }

    if (ticket.properties.hs_lastmodifieddate) {
      const modified = new Date(ticket.properties.hs_lastmodifieddate)
      parts.push(`**Last Modified:** ${modified.toLocaleString()}`)
    }

    if (ticket.properties.hs_ticket_category) {
      parts.push(`**Category:** ${ticket.properties.hs_ticket_category}`)
    }

    parts.push('')
    parts.push('---')
    parts.push('')
    const ticketUrl = await client.getTicketUrl(ticket.id)
    parts.push(`🔗 [View in HubSpot](${ticketUrl})`)

    const description = parts.join('\n')

    const outputFields = [
      {
        id: 'resolution',
        name: 'Resolution',
        type: 'text',
        required: false,
        value: ticket.properties.hs_resolution || ''
      }
    ]

    return {
      title: ticket.properties.subject || 'Untitled Ticket',
      description,
      status: this.mapStatusFromHubSpot(ticket.properties.hs_pipeline_stage, pipelines),
      priority: this.mapPriorityFromHubSpot(ticket.properties.hs_ticket_priority || 'MEDIUM'),
      assignee: ownerName || '',
      due_date: ticket.properties.hs_due_date || null,
      labels: ticket.properties.hs_ticket_category ? [ticket.properties.hs_ticket_category] : [],
      output_fields: outputFields,
      resolution: ticket.properties.hs_resolution || null
    }
  }

  /**
   * Map HubSpot ticket stage to local status
   * Uses pipeline metadata to determine if stage is OPEN or CLOSED
   */
  private mapStatusFromHubSpot(stageId: string | undefined, pipelines: HubSpotPipeline[]): string {
    if (!stageId) return 'not_started'

    for (const pipeline of pipelines) {
      const stage = pipeline.stages.find((s) => s.id === stageId)
      if (stage) {
        if (stage.metadata.ticketState === 'CLOSED') {
          return 'completed'
        }
        // Open stage: refine by label.
        const label = stage.label.toLowerCase()
        if (label.includes('waiting') || label.includes('new')) {
          return 'not_started'
        }
        if (label.includes('progress') || label.includes('working')) {
          return 'agent_working'
        }
        return 'agent_working'
      }
    }

    // Unknown stage: guess from its ID.
    const lowerStageId = stageId.toLowerCase()
    if (lowerStageId.includes('closed') || lowerStageId.includes('done')) {
      return 'completed'
    }
    if (lowerStageId.includes('new') || lowerStageId.includes('waiting')) {
      return 'not_started'
    }

    return 'agent_working'
  }

  /**
   * Map HubSpot priority to local priority
   * HubSpot: HIGH, MEDIUM, LOW
   */
  private mapPriorityFromHubSpot(hubspotPriority: string): string {
    const priorityMap: Record<string, string> = {
      HIGH: 'high',
      MEDIUM: 'medium',
      LOW: 'low'
    }
    return priorityMap[hubspotPriority] || 'medium'
  }

  /**
   * Download ticket attachments not yet saved. An attachment saved without a
   * recognised extension is downloaded again so it gets one.
   */
  private async downloadAttachments(
    taskId: string,
    attachments: HubSpotAttachment[],
    client: HubSpotClient,
    ctx: PluginContext
  ): Promise<void> {
    const task = ctx.db.getTask(taskId)
    if (!task) return

    // Dedupe by file ID: the signed URL changes on every sync.
    const saved = new Map<string, string>()
    for (const a of (task.attachments || []) as Array<{ filename: string; hubspot_file_id?: string }>) {
      if (a.hubspot_file_id) saved.set(a.hubspot_file_id, a.filename)
    }

    let downloadedCount = 0
    let skippedCount = 0

    for (const attachment of attachments) {
      const savedFilename = saved.get(attachment.id)
      if (savedFilename !== undefined && hasKnownExtension(savedFilename)) {
        skippedCount++
        continue
      }

      try {
        const buffer = await client.downloadAttachment(attachment.url)
        // HubSpot's file `type` is a category ("IMG", "DOCUMENT"), not a MIME
        // type, so it only counts when it looks like one.
        const declaredMime = attachment.type?.includes('/') ? attachment.type : undefined
        const sniffedMime = sniffMimeType(buffer)
        const extension = attachment.extension
          ? `.${attachment.extension}`
          : extensionForMimeType(declaredMime ?? sniffedMime ?? '')
        const filename = `${attachment.name}${extension}`
        saveTaskAttachment(ctx, taskId, {
          buffer,
          filename,
          mimeType: declaredMime ?? (hasKnownExtension(filename) ? mimeTypeForPath(filename) : sniffedMime ?? mimeTypeForPath(filename)),
          extra: { hubspot_file_id: attachment.id, hubspot_url: attachment.url },
          replaces: (existing) => existing.hubspot_file_id === attachment.id
        })
        saved.set(attachment.id, filename)
        downloadedCount++
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[hubspot-plugin] Failed to download attachment ${attachment.name}:`, errorMsg)
      }
    }

    if (downloadedCount > 0 || skippedCount > 0) {
      console.log(`[hubspot-plugin] Attachments: ${downloadedCount} downloaded, ${skippedCount} skipped`)
    }
  }

  /**
   * Returns markdown documentation for setting up HubSpot integration
   */
  getSetupDocumentation(): string {
    return `# HubSpot Integration Setup Guide

## Overview

Connect your HubSpot CRM to sync support tickets as tasks. This integration supports both OAuth 2.0 (recommended) and Private App authentication.

## Prerequisites

- A HubSpot account with CRM access
- Admin permissions to create apps or access tokens

## Authentication Methods

### Option 1: OAuth 2.0 (Recommended)

OAuth provides more granular permissions and better security. Use this for production environments.

### Option 2: Private App Access Token

Simpler setup but requires managing a long-lived access token. Good for testing or single-user scenarios.

---

## OAuth 2.0 Setup

### Step 1: Create a HubSpot OAuth App

1. Go to [HubSpot Developer Account](https://app.hubspot.com/signup-hubspot/developers)

2. Navigate to **Apps** → **Create app**

3. Fill in basic information:

   - **App name**: \`nuanu\` or your app name
   - **Description**: "Task management integration"

### Step 2: Configure OAuth Settings

1. Go to the **Auth** tab of your app

2. Add **Redirect URLs:**

   - \`http://localhost:3000/callback\`
   - \`http://localhost:3001/callback\`
   - \`http://localhost:3002/callback\`
   - ... (up to port 3010)

3. Select **Required Scopes:**

   - \`tickets\` - Read and write tickets
   - \`crm.objects.contacts.read\` - Read contact info
   - \`crm.objects.owners.read\` - Read ticket owners
   - \`files\` - Access attachments
   - \`forms-uploaded-files\` - Access form uploads

### Step 3: Get OAuth Credentials

1. Copy the **Client ID** from the Auth tab

2. Copy the **Client Secret** (show and copy)

3. Paste both into the form in the app

4. **Important**: Keep your Client Secret secure!

### Step 4: Connect to HubSpot

1. Click **Connect to HubSpot**

2. Choose which HubSpot account to authorize (if you have multiple)

3. Review the requested permissions

4. Click **Grant Access**

5. You'll be redirected back automatically

### Step 5: Optional Filters

After connecting, configure filters:

- **Pipeline Filter**: Select a specific ticket pipeline (e.g., "Support", "Sales")
- **Owner Filter**: Only sync tickets assigned to a specific user
- Leave empty to sync all tickets

---

## Private App Setup

### Step 1: Create a Private App

1. In HubSpot, go to **Settings** → **Integrations** → **Private Apps**

2. Click **Create private app**

3. Fill in basic information:

   - **Name**: \`nuanu\` or your app name
   - **Description**: "Task management integration"

### Step 2: Configure Scopes

1. Go to the **Scopes** tab and select:

   - \`tickets\` - Read and write tickets
   - \`crm.objects.contacts.read\` - Read contact info
   - \`crm.objects.owners.read\` - Read ticket owners
   - \`files\` - Access attachments
   - \`forms-uploaded-files\` - Access form uploads

### Step 3: Generate Access Token

1. Click **Create app**

2. Copy the **Access token** (shown only once!)

3. Paste it into the "Private App Access Token" field

4. **Important**: Store this token securely - it cannot be retrieved again

---

## Features

### Import Tickets

- Automatically imports HubSpot support tickets
- Maps ticket fields to tasks:
  - Subject → Title
  - Description/Content → Description
  - Priority (HIGH, MEDIUM, LOW)
  - Status/Stage → Task status
  - Owner → Assignee
  - Attachments

### Bidirectional Sync

- Update ticket priority from the app
- Changes sync back to HubSpot automatically

### Attachments

- Downloads ticket attachments automatically
- Stores files locally with tasks
- Preserves original filenames and MIME types

### Filtering

- Filter by pipeline (e.g., only "Support" tickets)
- Filter by owner/assignee
- Customizable sync frequency

## Status Mapping

HubSpot ticket status maps to task status:

| HubSpot Stage | Task Status |
|---------------|-------------|
| New / Waiting | Not Started |
| In Progress / Working | In Progress |
| Closed / Resolved | Completed |

The mapping adapts to your pipeline stage names automatically.

## Troubleshooting

### OAuth callback not working

- Ensure redirect URIs include ports 3000-3010
- Check that http://localhost is allowed (not https)
- Try restarting the OAuth flow

### "Insufficient permissions" error

- Verify all required scopes are enabled in your app
- For Private Apps, check the Scopes tab
- For OAuth, review the app's Auth settings

### Tickets not importing

- Check that you have tickets in HubSpot
- Verify OAuth/token is connected (green checkmark)
- Check pipeline/owner filters aren't too restrictive
- Try clicking **Sync Now** manually

### Attachments not downloading

- Verify \`files\` and \`forms-uploaded-files\` scopes are enabled
- Check file size limits (HubSpot has size restrictions)
- Look for errors in the console

### Rate limiting

- HubSpot has API rate limits (100 requests/10 seconds for most)
- The integration handles rate limits automatically with backoff
- If you hit limits frequently, reduce sync frequency

## Support

For more help:

- [HubSpot API Documentation](https://developers.hubspot.com/docs/api/overview)
- [OAuth Guide](https://developers.hubspot.com/docs/api/working-with-oauth)
- [Private Apps Guide](https://developers.hubspot.com/docs/api/private-apps)
`
  }
}
