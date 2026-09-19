import type { GitHubManager } from '../github-manager'
import type { ConfigFieldOption, PluginConfigSchema, PluginContext } from './types'
import { IssuesPlugin, issueFilterFields } from './issues-plugin'

export class GitHubIssuesPlugin extends IssuesPlugin {
  id = 'github-issues'
  displayName = 'GitHub Issues'
  description = 'Import and sync issues from a GitHub repository'
  icon = 'Github'
  protected sourceName = 'GitHub'

  constructor(private githubManager: GitHubManager) {
    super(githubManager)
  }

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'owner',
        label: 'Owner',
        type: 'dynamic-select',
        optionsResolver: 'owners',
        required: true,
        description: 'GitHub user or organization'
      },
      {
        key: 'repo',
        label: 'Repository',
        type: 'dynamic-select',
        optionsResolver: 'repos',
        required: true,
        description: 'Repository to import issues from',
        dependsOn: { field: 'owner', value: undefined }
      },
      ...issueFilterFields('GitHub')
    ]
  }

  async resolveOptions(
    resolverKey: string,
    config: Record<string, unknown>,
    _ctx: PluginContext
  ): Promise<ConfigFieldOption[]> {
    try {
      if (resolverKey === 'owners') {
        const status = await this.githubManager.checkGhCli()
        if (!status.authenticated) return []
        const orgs = await this.githubManager.fetchUserOrgs()
        return [
          ...(status.username ? [{ value: status.username, label: `${status.username} (personal)` }] : []),
          ...orgs.map((org) => ({ value: org, label: org }))
        ]
      }

      if (resolverKey === 'repos') {
        const owner = config.owner as string
        if (!owner) return []
        const status = await this.githubManager.checkGhCli()
        const repos = owner === status.username
          ? await this.githubManager.fetchUserRepos()
          : await this.githubManager.fetchOrgRepos(owner)
        return repos.map((r) => ({ value: r.name, label: r.name }))
      }
    } catch {
      return []
    }

    return []
  }

  getSetupDocumentation(): string {
    return `# GitHub Issues Integration

## Overview

Import issues from any GitHub repository and keep them in sync. Changes made locally (status, title, assignees) are pushed back to GitHub automatically.

Uses the **GitHub CLI** (\`gh\`) for authentication — no API tokens or OAuth apps to configure.

## Prerequisites

- [GitHub CLI](https://cli.github.com) installed
- Authenticated via \`gh auth login\`

## Setup Steps

### 1. Install GitHub CLI

\`\`\`
brew install gh
\`\`\`

Or download from [cli.github.com](https://cli.github.com).

### 2. Authenticate

\`\`\`
gh auth login
\`\`\`

Follow the prompts to sign in with your GitHub account. If you've already authenticated for repo management, you're all set.

### 3. Configure the Source

1. Select the **owner** (your personal account or an organization)
2. Select the **repository**
3. Optionally filter by issue state, assignee, or labels

## Features

### Import & Sync
- Issues are imported as tasks with full field mapping
- Re-syncing updates existing tasks without creating duplicates
- Pull requests are automatically excluded

### Bidirectional Updates
- Marking a task **completed** closes the GitHub issue
- Changing title, description, or assignee syncs back to GitHub

### Actions
- **Add Comment** — post a comment on the issue
- **Close Issue** — close and mark as completed
- **Reopen Issue** — reopen a closed issue

## Field Mapping

| GitHub | Local Task |
|--------|------------|
| Issue number | External ID |
| Title | Title |
| Body | Description |
| State + labels | Status |
| Priority labels | Priority |
| First assignee | Assignee |
| Milestone due date | Due date |
| Labels | Labels |

## Label Conventions

### Priority Labels

GitHub has no built-in priority field. The integration recognizes these label names:

| Label | Maps to |
|-------|---------|
| \`p0\`, \`critical\`, \`urgent\`, \`priority:critical\` | Critical |
| \`p1\`, \`priority:high\` | High |
| \`p2\`, \`priority:medium\` | Medium |
| \`p3\`, \`priority:low\` | Low |

Priority labels are consumed during mapping and won't appear in the task's labels list.

### Status Labels

| Label | Maps to |
|-------|---------|
| \`in progress\`, \`wip\` | In Progress |
| \`review\` | Ready for Review |
| *(closed issue)* | Completed |
| *(open, no status label)* | Not Started |

## Troubleshooting

### "gh: command not found"
Install the GitHub CLI and ensure it's in your PATH. Run \`gh --version\` to verify.

### Authentication expired
Run \`gh auth status\` to check. If expired, run \`gh auth login\` again.

### Issues not importing
- Verify the repo exists and you have access: \`gh repo view owner/repo\`
- Check your filter settings — a narrow assignee or label filter may exclude issues
- Pull requests are filtered out automatically

### Sync creates duplicates
This shouldn't happen — issues are matched by their number. If it does, check that the task source wasn't deleted and re-created (which changes the source ID).
`
  }
}
