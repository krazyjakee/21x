import type { ForgejoManager } from '../forgejo-manager'
import { recordRepoProviders } from '../repo-providers'
import type { ConfigFieldOption, PluginConfigSchema, PluginContext } from './types'
import { IssuesPlugin, issueFilterFields } from './issues-plugin'

/**
 * Imports and syncs Forgejo (or Gitea) issues through the tea CLI. Each source
 * pins the tea login it was configured with, so several Forgejo servers can be
 * used side by side without re-authenticating in 20x.
 */
export class ForgejoIssuesPlugin extends IssuesPlugin {
  id = 'forgejo-issues'
  displayName = 'Forgejo Issues'
  description = 'Import and sync issues from a Forgejo repository using the tea CLI'
  icon = 'GitBranch'
  protected sourceName = 'Forgejo'

  constructor(private forgejoManager: ForgejoManager) {
    super(forgejoManager)
  }

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
      ...issueFilterFields('Forgejo')
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

  // Imported tasks reference this repo; make sure their workspaces are
  // cloned through tea rather than the default provider's CLI.
  protected onImportRepo(ctx: PluginContext, fullRepoName: string): void {
    recordRepoProviders(ctx.db, [fullRepoName], 'forgejo')
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
