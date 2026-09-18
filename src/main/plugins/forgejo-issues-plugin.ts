import type { TaskRecord } from '../database'
import type { ForgejoManager } from '../forgejo-manager'
import type { SourceUser, ReassignResult } from '../../shared/types'
import { TaskStatus } from '../../shared/constants'
import { recordRepoProviders } from '../repo-providers'
import { mapIssueToTask, mapLocalStatusToIssueState } from './github-issues-plugin'
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
import { upsertSourcedTask } from './sourced-tasks'

/**
 * Imports and syncs Forgejo (or Gitea) issues through the tea CLI. Each source
 * pins the tea login it was configured with, so several Forgejo servers can be
 * used side by side without re-authenticating in 20x.
 */
export class ForgejoIssuesPlugin implements TaskSourcePlugin {
  id = 'forgejo-issues'
  displayName = 'Forgejo Issues'
  description = 'Import and sync issues from a Forgejo repository using the tea CLI'
  icon = 'GitBranch'
  requiresMcpServer = false

  constructor(private forgejoManager: ForgejoManager) {}

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'login',
        label: 'tea Login',
        type: 'dynamic-select',
        optionsResolver: 'logins',
        required: true,
        description: 'Forgejo server login from `tea login list`'
      },
      {
        key: 'owner',
        label: 'Owner',
        type: 'dynamic-select',
        optionsResolver: 'owners',
        required: true,
        description: 'Forgejo user or organization',
        dependsOn: { field: 'login', value: '__any__' }
      },
      {
        key: 'repo',
        label: 'Repository',
        type: 'dynamic-select',
        optionsResolver: 'repos',
        required: true,
        description: 'Repository to import issues from',
        dependsOn: { field: 'owner', value: '__any__' }
      },
      {
        key: 'state',
        label: 'Issue State',
        type: 'select',
        default: 'open',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Closed' },
          { value: 'all', label: 'All' }
        ]
      },
      {
        key: 'assignee',
        label: 'Assignee Filter',
        type: 'text',
        placeholder: 'Forgejo username (optional)',
        description: 'Only import issues assigned to this user'
      },
      {
        key: 'labels',
        label: 'Labels Filter',
        type: 'text',
        placeholder: 'bug, feature (optional)',
        description: 'Comma-separated labels to filter by'
      }
    ]
  }

  async resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    const login = config.login as string | undefined

    try {
      if (resolverKey === 'logins') {
        const logins = await this.forgejoManager.listLogins()
        return logins.map((l) => ({ value: l.name, label: `${l.name} — ${l.user ? `${l.user}@` : ''}${l.url}` }))
      }

      if (!login) return []

      if (resolverKey === 'owners') {
        const [username, orgs] = await Promise.all([
          this.forgejoManager.fetchUsername(login),
          this.forgejoManager.fetchUserOrgs(login)
        ])
        return [
          { value: username, label: `${username} (personal)` },
          ...orgs.map((org) => ({ value: org, label: org }))
        ]
      }

      if (resolverKey === 'repos') {
        const owner = config.owner as string
        if (!owner) return []
        const repos = await this.forgejoManager.fetchOrgRepos(owner, login)
        return repos.map((r) => ({ value: r.name, label: r.name }))
      }
    } catch {
      return []
    }

    return []
  }

  validateConfig(config: Record<string, unknown>): string | null {
    if (!config.login || typeof config.login !== 'string') return 'tea login is required'
    if (!config.owner || typeof config.owner !== 'string') return 'Owner is required'
    if (!config.repo || typeof config.repo !== 'string') return 'Repository is required'
    return null
  }

  getActions(_config: Record<string, unknown>): PluginAction[] {
    return [
      {
        id: PluginActionId.AddComment,
        label: 'Add Comment',
        icon: 'MessageSquare',
        requiresInput: true,
        inputLabel: 'Comment',
        inputPlaceholder: 'Enter your comment...'
      },
      {
        id: PluginActionId.CloseIssue,
        label: 'Close Issue',
        icon: 'XCircle',
        variant: 'destructive'
      },
      {
        id: PluginActionId.ReopenIssue,
        label: 'Reopen Issue',
        icon: 'RotateCcw'
      }
    ]
  }

  async importTasks(
    sourceId: string,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }
    const owner = config.owner as string
    const repo = config.repo as string

    try {
      const issues = await this.forgejoManager.fetchIssues(owner, repo, {
        state: (config.state as string) || 'open',
        assignee: config.assignee as string | undefined,
        labels: config.labels as string | undefined,
        login: config.login as string | undefined
      })

      const fullRepoName = `${owner}/${repo}`
      // Imported tasks reference this repo; make sure their workspaces are
      // cloned through tea rather than the default provider's CLI.
      recordRepoProviders(ctx.db, [fullRepoName], 'forgejo')

      for (const issue of issues) {
        try {
          const mapped = mapIssueToTask(issue)
          const externalId = String(issue.number)
          const upserted = upsertSourcedTask(ctx, sourceId, externalId, mapped, {
            title: issue.title,
            source: 'Forgejo',
            repos: [fullRepoName]
          })
          if (upserted?.created) result.imported++
          else if (upserted) result.updated++
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          result.errors.push(`Failed to import #${issue.number} "${issue.title}": ${msg}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      result.errors.push(`Import failed: ${msg}`)
    }

    return result
  }

  async exportUpdate(
    task: TaskRecord,
    changedFields: Record<string, unknown>,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<void> {
    if (!task.external_id) return
    const owner = config.owner as string
    const repo = config.repo as string
    const number = parseInt(task.external_id, 10)

    const updates: { title?: string; body?: string; state?: string; assignees?: string[]; labels?: string[] } = {}

    if (changedFields.title) updates.title = changedFields.title as string
    if (changedFields.description) updates.body = changedFields.description as string
    if (changedFields.status) updates.state = mapLocalStatusToIssueState(changedFields.status as string)
    if (changedFields.assignee) updates.assignees = [(changedFields.assignee as string)]
    if (changedFields.labels) updates.labels = changedFields.labels as string[]

    if (Object.keys(updates).length > 0) {
      try {
        await this.forgejoManager.updateIssue(owner, repo, number, updates, config.login as string | undefined)
      } catch (err) {
        console.error('[forgejo-issues] Export update failed:', err)
      }
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

    const owner = config.owner as string
    const repo = config.repo as string
    const login = config.login as string | undefined
    const number = parseInt(task.external_id, 10)

    try {
      switch (actionId) {
        case PluginActionId.AddComment:
          if (!input) return { success: false, error: 'Comment text is required' }
          await this.forgejoManager.addIssueComment(owner, repo, number, input, login)
          return { success: true }

        case PluginActionId.Complete:
        case PluginActionId.CloseIssue:
          await this.forgejoManager.updateIssue(owner, repo, number, { state: 'closed' }, login)
          return { success: true, taskUpdate: { status: TaskStatus.Completed } }

        case PluginActionId.ReopenIssue:
          await this.forgejoManager.updateIssue(owner, repo, number, { state: 'open' }, login)
          return { success: true, taskUpdate: { status: TaskStatus.NotStarted } }

        default:
          return { success: false, error: `Unknown action: ${actionId}` }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: `Action failed: ${msg}` }
    }
  }

  async getUsers(
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<SourceUser[]> {
    try {
      const collaborators = await this.forgejoManager.fetchRepoCollaborators(
        config.owner as string,
        config.repo as string,
        config.login as string | undefined
      )
      return collaborators.map((c) => ({ id: c.login, email: '', name: c.login }))
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

    try {
      await this.forgejoManager.updateIssue(
        config.owner as string,
        config.repo as string,
        parseInt(task.external_id, 10),
        { assignees: userIds },
        config.login as string | undefined
      )
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: msg }
    }
  }

  getSetupDocumentation(): string {
    return `# Forgejo Issues Integration

## Overview

Import issues from a Forgejo (or Gitea) repository and keep them in sync. Changes made locally (status, title, assignees, labels) are pushed back to Forgejo.

Uses the **tea CLI** and the logins it already stores — 21x never asks for, reads, or saves Forgejo tokens.

## Prerequisites

- [tea](https://gitea.com/gitea/tea) installed and on your PATH
- At least one login: \`tea login add\`

## Setup Steps

### 1. Add a tea login

\`\`\`
tea login add --url https://forgejo.example.com --token <token>
\`\`\`

Run \`tea login list\` to confirm it is configured.

### 2. Configure the Source

1. Select the **tea login** (one per Forgejo server/account)
2. Select the **owner** (your personal account or an organization)
3. Select the **repository**
4. Optionally filter by issue state, assignee, or labels

## Features

- Issues are imported as tasks; pull requests are excluded
- Re-syncing updates existing tasks without creating duplicates
- Marking a task **completed** closes the Forgejo issue
- **Add Comment**, **Close Issue**, and **Reopen Issue** actions
- Imported tasks are linked to the repository, so starting an agent clones it through tea

Priority and status labels follow the same conventions as GitHub Issues (\`p0\`–\`p3\`, \`priority:*\`, \`wip\`, \`review\`).

## Troubleshooting

### "tea: command not found"
Install tea and make sure it is on your PATH. Run \`tea --version\` to verify.

### Authorization failed (HTTP 401/403)
The token stored by tea was rejected. Update it with \`tea login edit <name>\` or remove and re-add the login.

### Server unreachable
Check the server URL in \`tea login list\` and that the server is reachable from this machine.
`
  }
}
