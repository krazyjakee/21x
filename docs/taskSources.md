# Task Sources

Task sources allow importing tasks from external systems (Linear, HubSpot, GitHub Issues, Notion, YouTrack) via task source plugins. Each task source is linked to a plugin and stores that plugin's configuration.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐     ┌──────────────────┐
│  Sidebar UI  │────▶│ TaskSource   │────▶│ SyncManager│────▶│  PluginRegistry  │
│  (sync btn)  │     │   Store      │     │            │     │  (plugin by id)  │
└─────────────┘     └──────────────┘     └────────────┘     └──────┬───────────┘
                                                                    │
                                                         ┌─────────▼─────────┐
                                                         │ TaskSourcePlugin  │
                                                         │ (external API)    │
                                                         └───────────────────┘
```

### Key Files

| File | Role |
|------|------|
| `src/main/database/schema.ts` | `task_sources` table, task `external_id`/`source_id` columns |
| `src/main/database.ts` | Task source CRUD methods |
| `src/main/plugins/types.ts` | `TaskSourcePlugin` and `PluginContext` interfaces |
| `src/main/plugins/registry.ts` | `PluginRegistry` (plugins are registered in `src/main/index.ts`) |
| `src/main/plugins/*-plugin.ts` | Linear, HubSpot, GitHub Issues, Forgejo, Notion, YouTrack plugins |
| `src/main/plugins/sourced-tasks.ts` | `upsertSourcedTask` — the shared create/refresh write path every plugin imports through |
| `src/main/sync-manager.ts` | Import, export and action logic, delegated to the source's plugin |
| `src/main/ipc/task-sources.ts` | IPC handlers for `taskSource:*`, `plugin:*` and `oauth:*` channels |
| `src/renderer/src/stores/task-source-store.ts` | Zustand store for task sources |
| `src/renderer/src/stores/ui-store.ts` | `sourceFilter` state |
| `src/renderer/src/components/settings/tabs/IntegrationsSettings.tsx` | Task source list UI |
| `src/renderer/src/components/settings/forms/TaskSourceFormDialog.tsx` | Task source create/edit dialog |
| `src/renderer/src/components/plugins/` | Per-plugin config forms |

## Data Model

### `task_sources` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | cuid2 |
| `name` | TEXT | Display name (e.g. "Linear") — also used as `task.source` |
| `plugin_id` | TEXT | Which plugin handles this source |
| `config` | TEXT (JSON) | Plugin-specific configuration |
| `last_synced_at` | TEXT | ISO timestamp of last successful sync |
| `enabled` | INTEGER | 1 = active, 0 = disabled |

### Task Columns Added

| Column | Type | Description |
|--------|------|-------------|
| `external_id` | TEXT | The task's ID in the external system |
| `source_id` | TEXT FK → task_sources | Which source this task came from |

A unique index on `(source_id, external_id)` prevents duplicate imports.

Local tasks have `external_id = NULL`, `source_id = NULL`, `source = 'local'`.

## How a Task Source Works

### 1. Configuration

In **Settings → Integrations**, the user:

1. Picks a plugin
2. Gives the source a name (e.g. "Linear")
3. Fills in the plugin's config form (and completes OAuth where the plugin needs it)

### 2. Import (Sync)

Triggered manually — user clicks the sync button in the sidebar header or "Sync now" on a source.

**Flow:**

1. `SyncManager.importTasks(sourceId)` is called
2. Fetches the `TaskSourceRecord` and looks up its plugin in the `PluginRegistry` by `plugin_id`
3. `plugin.importTasks(sourceId, config, ctx)` fetches items from the external system and writes each one through `upsertSourcedTask(ctx, sourceId, externalId, fields, createDefaults)`, which upserts by `(source_id, external_id)` and writes with the `'task-source'` origin (`DatabaseManager.updateTask` only lets that origin close a sourced task)
4. `last_synced_at` is updated on the source

**Status rule (all plugins).** The source decides whether a task is open or closed; 20x owns the workflow state (triaging, agent working, ready for review, …) while the task is open:

| At the source | Locally | Result |
|---------------|---------|--------|
| Closed | Any open status | Task is completed |
| Open | Completed | Task is reopened as Not Started |
| Open | Open | Local status is kept (the source's in-between states are ignored) |

A task the user completed in 20x only (`complete_at_source: false`) stays completed: `DatabaseManager.updateTask` re-applies `completed` so a refresh never reopens it. New tasks are created with the status mapped from the source. HubSpot additionally skips items that were already closed before they were ever imported, because its incremental query returns recently closed tickets.

### 3. Export (Two-Way Sync)

When a user updates a task that has a `source_id` and `external_id`, the change is automatically pushed back.

**Flow:**

1. `task-store.ts` `updateTask` detects `updated.source_id && updated.external_id`
2. Fires `taskSourceApi.exportUpdate(taskId, changedFields)` in the background
3. `SyncManager.exportTaskUpdate` fetches the task and its source
4. Calls `plugin.exportUpdate(task, changedFields, config, ctx)`

### 4. Actions

`SyncManager.executeAction` calls `plugin.executeAction(actionId, task, input, config, ctx)`. If the result carries a `taskUpdate`, it is applied to the local task.

### 5. Conflict Resolution

Last-write-wins. On import, the external system's data overwrites local changes. On export, local changes are pushed immediately. No merge logic.

## UI

### Sidebar

- **Sync button** (RefreshCw icon) — appears next to Settings when sources exist. Syncs all enabled sources, shows spinner while running. After sync, refetches all tasks.
- **Source filter** — dropdown in the filters section: "All Sources", "Local", or individual source names. Filters `tasks` by `source_id`.

### Task List Item

Tasks from external sources show a small badge with the source name (e.g. "Linear") below the priority badge.

## Connector OAuth2 (#15)

Embedded connector pieces (see `docs/connectors.md`) that authenticate with
OAuth2 use 21x's own loopback flow (`src/main/oauth/connector-oauth-flow.ts`,
the same server, PKCE helper and provider contract as the Linear / HubSpot /
MCP flows) and store the token set with the connector's credentials. The
per-provider decisions live as data in the piece's allowlist entry
(`oauth` in `src/main/connectors/allowlist.ts`) and are recorded here.

| Provider (piece) | Mode | PKCE | Loopback redirect | Scopes requested | Refresh | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Todoist (`@activepieces/piece-todoist` 0.5.0) | `user-supplied`: the user creates an app at developer.todoist.com/appconsole.html and pastes its Client ID and Client secret | No. Todoist does not document PKCE and needs the client secret at the token endpoint, so the secret is stored (encrypted) with the connector, never shipped | Accepted: any OAuth redirect URL can be registered in the app console; register `http://localhost:3000/callback` (21x falls back to 3001-3010 when 3000 is busy). Not yet verified against a live account | `data:read_write` — the smallest scope that can read tasks and update / close / reopen them (`data:read` cannot write; `data:delete` and `project:delete` are not requested) | Tokens never expire and no refresh token is issued; revocation surfaces as `HTTP 401` and a "reconnect" state | A 21x-registered Todoist app is a follow-up decision: it would need the secret in the app bundle, which the security policy forbids, so `registered` mode is reserved for providers that accept PKCE public clients |

Decisions that apply to every provider:

- **Mode.** `registered` (a 21x-registered app) is only an option for
  providers that accept a PKCE public client with a loopback redirect; the
  repo never carries a client secret. Every provider that needs a confidential
  client is `user-supplied`.
- **Loopback.** Only providers that accept `http://localhost:<port>/callback`
  are supported; `loopbackRedirect: false` refuses to connect with a clear
  message. The deep-link scheme is not used for connectors.
- **Scopes.** The allowlist entry lists the smallest scopes the allowlisted
  operations need; a mapping may narrow them further (`auth.scopes`), never
  widen them.
- **Refresh and revocation.** Handled in the main process by
  `ConnectorOAuthService`: refresh five minutes before expiry, `invalid_grant`
  marks the connection revoked, and the sync status shows one clear error
  until the user reconnects. Pieces only ever see the access token.
