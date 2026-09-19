import type { TaskRecord } from '../database'
import type { GitHubIssue } from '../github-manager'
import type { SourceUser, ReassignResult } from '../../shared/types'
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
import { upsertSourcedTask } from './sourced-tasks'

// Labels that map to priority (case-insensitive)
const PRIORITY_LABELS: Record<string, string> = {
  'p0': 'critical',
  'p1': 'high',
  'p2': 'medium',
  'p3': 'low',
  'critical': 'critical',
  'urgent': 'critical',
  'priority:critical': 'critical',
  'priority:high': 'high',
  'priority:medium': 'medium',
  'priority:low': 'low'
}

function mapIssueToTask(issue: GitHubIssue): Partial<TaskRecord> {
  const labelNames = issue.labels.map((l) => l.name)
  return {
    title: issue.title,
    description: issue.body || '',
    status: mapIssueStatus(issue.state, labelNames),
    priority: labelNames.map((l) => PRIORITY_LABELS[l.toLowerCase()]).find(Boolean) || 'medium',
    assignee: issue.assignees[0]?.login || '',
    due_date: issue.milestone?.due_on?.split('T')[0] || null,
    labels: labelNames.filter((n) => !(n.toLowerCase() in PRIORITY_LABELS))
  }
}

function mapIssueStatus(state: string, labels: string[]): TaskStatus {
  if (state === 'closed') return TaskStatus.Completed
  const lower = labels.map((l) => l.toLowerCase())
  if (lower.some((l) => l.includes('in progress') || l === 'wip')) return TaskStatus.AgentWorking
  if (lower.some((l) => l.includes('review'))) return TaskStatus.ReadyForReview
  return TaskStatus.NotStarted
}

type IssueUpdate = { title?: string; body?: string; state?: string; assignees?: string[]; labels?: string[] }

/**
 * The forge calls an issues source makes. `login` is the Forgejo tea login the
 * source was configured with; the gh CLI has a single account and ignores it.
 */
interface IssueForge {
  fetchIssues(owner: string, repo: string, opts: { state: string; assignee?: string; labels?: string; login?: string }): Promise<GitHubIssue[]>
  updateIssue(owner: string, repo: string, number: number, data: IssueUpdate, login?: string): Promise<void>
  addIssueComment(owner: string, repo: string, number: number, body: string, login?: string): Promise<void>
  fetchRepoCollaborators(owner: string, repo: string, login?: string): Promise<Array<{ login: string }>>
}

/** State, assignee and label filters shared by every issues source. */
export function issueFilterFields(forgeName: string): PluginConfigSchema {
  return [
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
      placeholder: `${forgeName} username (optional)`,
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

/** Issue import, sync-back and actions shared by the GitHub and Forgejo sources. */
export abstract class IssuesPlugin implements TaskSourcePlugin {
  abstract id: string
  abstract displayName: string
  abstract description: string
  abstract icon: string
  /** Shown as the task's source, e.g. 'GitHub'. */
  protected abstract sourceName: string

  constructor(private forge: IssueForge) {}

  abstract getConfigSchema(): PluginConfigSchema
  abstract resolveOptions(resolverKey: string, config: Record<string, unknown>, ctx: PluginContext): Promise<ConfigFieldOption[]>
  abstract getSetupDocumentation(): string

  /** Called once per import with the `owner/repo` the tasks will reference. */
  protected onImportRepo(_ctx: PluginContext, _fullRepoName: string): void {}

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

  async importTasks(sourceId: string, config: Record<string, unknown>, ctx: PluginContext): Promise<PluginSyncResult> {
    const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] }
    const owner = config.owner as string
    const repo = config.repo as string

    try {
      const issues = await this.forge.fetchIssues(owner, repo, {
        state: (config.state as string) || 'open',
        assignee: config.assignee as string | undefined,
        labels: config.labels as string | undefined,
        login: config.login as string | undefined
      })

      const fullRepoName = `${owner}/${repo}`
      this.onImportRepo(ctx, fullRepoName)

      for (const issue of issues) {
        try {
          const upserted = upsertSourcedTask(ctx, sourceId, String(issue.number), mapIssueToTask(issue), {
            title: issue.title,
            source: this.sourceName,
            repos: [fullRepoName]
          })
          if (upserted?.created) result.imported++
          else if (upserted) result.updated++
        } catch (err) {
          result.errors.push(`Failed to import #${issue.number} "${issue.title}": ${errorMessage(err)}`)
        }
      }
    } catch (err) {
      result.errors.push(`Import failed: ${errorMessage(err)}`)
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

    const updates: IssueUpdate = {}
    if (changedFields.title) updates.title = changedFields.title as string
    if (changedFields.description) updates.body = changedFields.description as string
    if (changedFields.status) updates.state = changedFields.status === TaskStatus.Completed ? 'closed' : 'open'
    if (changedFields.assignee) updates.assignees = [changedFields.assignee as string]
    if (changedFields.labels) updates.labels = changedFields.labels as string[]
    if (Object.keys(updates).length === 0) return

    try {
      await this.updateIssue(task.external_id, config, updates)
    } catch (err) {
      console.error(`[${this.id}] Export update failed:`, err)
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

    try {
      switch (actionId) {
        case PluginActionId.AddComment:
          if (!input) return { success: false, error: 'Comment text is required' }
          await this.forge.addIssueComment(
            config.owner as string,
            config.repo as string,
            parseInt(task.external_id, 10),
            input,
            config.login as string | undefined
          )
          return { success: true }

        case PluginActionId.Complete:
        case PluginActionId.CloseIssue:
          await this.updateIssue(task.external_id, config, { state: 'closed' })
          return { success: true, taskUpdate: { status: TaskStatus.Completed } }

        case PluginActionId.ReopenIssue:
          await this.updateIssue(task.external_id, config, { state: 'open' })
          return { success: true, taskUpdate: { status: TaskStatus.NotStarted } }

        default:
          return { success: false, error: `Unknown action: ${actionId}` }
      }
    } catch (err) {
      return { success: false, error: `Action failed: ${errorMessage(err)}` }
    }
  }

  async getUsers(config: Record<string, unknown>, _ctx: PluginContext): Promise<SourceUser[]> {
    try {
      const collaborators = await this.forge.fetchRepoCollaborators(
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
      await this.updateIssue(task.external_id, config, { assignees: userIds })
      return { success: true }
    } catch (err) {
      return { success: false, error: errorMessage(err) }
    }
  }

  private updateIssue(externalId: string, config: Record<string, unknown>, updates: IssueUpdate): Promise<void> {
    return this.forge.updateIssue(
      config.owner as string,
      config.repo as string,
      parseInt(externalId, 10),
      updates,
      config.login as string | undefined
    )
  }
}
