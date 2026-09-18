# Connectors (embedded pieces)

20x embeds selected MIT-licensed Activepieces pieces behind a 20x-owned piece
host that runs in an Electron `utilityProcess` (`src/main/connectors/piece-host/`).
SQLite replaces Activepieces' Postgres and Redis. Pieces never get database
access: the host hands each run a resolved credential (`context.auth`) and a KV
store bound to one instance and scope (`context.store`).

## Storage (`src/main/connectors/connector-store.ts`)

Tables are created in `createTables()` (`src/main/database/schema.ts`) with
`CREATE TABLE IF NOT EXISTS`, so fresh and existing databases both get them
without a schema version bump. Everything cascades from `connector_instances`.

| Table | Holds |
| --- | --- |
| `connector_instances` | piece name, pinned piece version, display name, config JSON, `auth` (safeStorage ciphertext) + `auth_type`, enabled |
| `connector_kv` | JSON values keyed by `(instance_id, scope, key)`; scope is `project` or `flow` |
| `connector_sync_state` | one row per instance: cursor JSON, attempt count, next retry time, last error, last sync time |
| `connector_dead_letters` | items that exhausted their retries: external id, payload JSON, error, attempts |

`ConnectorStore` takes anything with a `db` handle (`new ConnectorStore(databaseManager)`).

KV limits, enforced before anything is written, throw `ConnectorKvLimitError`
(`code: 'CONNECTOR_KV_LIMIT'`, `kind: 'key' | 'value' | 'instance'`):

- key: 128 characters
- value: 512 KB of JSON
- instance: 10 MB total (keys + values, all scopes); overwriting a key counts net of its old value

`kvGet` returns `null` for a missing key, matching the pieces `store.get` contract.

## Credentials (`src/main/connectors/credentials.ts`)

`ConnectorCredentialStore` handles `secret_text`, `basic` and `custom_auth`
credentials.

- **Persistent** (default): encrypted with `safeStorage` and stored in
  `connector_instances.auth`. Unlike `encryptSecret()` elsewhere in the
  database layer there is **no plaintext fallback**.
- **Encryption unavailable** (e.g. Linux with no Secret Service keyring):
  persistent setup throws `ConnectorCredentialsUnavailableError`
  (`code: 'CONNECTOR_CREDENTIALS_UNAVAILABLE'`, `remediation` text,
  `sessionOnlyAvailable: true`). The UI should show the remediation and offer
  session-only mode.
- **Session-only** (`set(id, creds, 'session')`): kept in memory for this app run
  and never written; any persisted copy is cleared.
- Ciphertext that can no longer be decrypted reads as "no credentials" and the
  user must reconnect.
- Deleting an instance removes the row (and its ciphertext) and the session copy.

Credentials must never be logged or put into errors, task content or dead
letters. Pass such text through `redactCredentials(text, creds)` (or
`ConnectorCredentialStore.redact(id, text)`), which also catches derived forms
(Basic `user:pass`, its base64, URL-encoded values). Values shorter than four
characters are not redacted.

## Connector bridge task source (`src/main/connectors/bridge/`)

The `connector-bridge` task-source plugin
(`src/main/plugins/connector-bridge-plugin.ts`) turns an allowlisted piece into
a 21x task source. A new source needs a bundled piece, an allowlist entry and a
**task mapping**. It needs no provider-specific client code.

### Task mappings (`bridge/mappings.ts`, types in `bridge/mapping.ts`)

A mapping sits next to the allowlist and declares:

- `import.target`: one allowlisted list/search **action**, or one allowlisted
  **polling trigger**. `onEnable` runs once, and the cursor records it so a
  restart doesn't reset the trigger.
- `import.props`: the props passed to the piece. Each prop is a constant
  (`{ value }`) or a user-entered config value (`{ config: key }`, declared in
  `configProps`). `itemsPath` points at the item array in the output.
- `fields`: dot paths from each item to `externalId` (stable identity for
  idempotent upserts), `title`, `description`, `dueDate`, `url`, `labels`
  (`labels[].name`) and `status` (the item is closed at the source when the
  value at `path` is one of `completedValues`).
- `update` (optional): one allowlisted update action plus the props that take
  the title, the due date (ISO 8601) and open/closed. A local Completed closes
  the item and a local Not Started reopens it. The other workflow states belong
  to 21x and are never pushed.

`validateMapping()` rejects a mapping that names a non-allowlisted action or
trigger, a non-polling trigger, or an unsafe path (`__proto__`, more than one
`[]`). The engine also rejects an invalid mapping before it calls anything, and
`PieceHostClient` checks the allowlist again on every call. Trello
(`@activepieces/piece-trello`) imports with `list_cards_in_board`
(`filter: all`) and updates with `update_card`.

Mapped output is validated and capped. A wrong type rejects the item and
over-long text is truncated:

| Limit | Value |
| --- | --- |
| piece output per sync | 5 MB JSON |
| single item | 256 KB JSON |
| items per sync | 1000 |
| external id / title / description | 256 / 500 / 64 K chars |
| labels | 20 x 64 chars |
| attachments | none: mappings can't name them (out of scope) |

Control characters are stripped and every text field goes through
`redactCredentials()`. URLs must be http(s) and lose any userinfo.

### Sync, conflicts and completion (`bridge/engine.ts`)

- **One job at a time per connector instance**, enforced by an in-memory lock.
  A sync requested while one is running shares that job's result. Updates for
  the same instance queue behind it.
- Imports go through `upsertSourcedTask()` with the source's `project_id`, so
  tasks land in the source's project and follow the shared status rule. An item
  that is already closed at the source never creates a new task.
- **Failures never delete or change cached tasks.** The error appears in the
  sync result (the task-source error display) and in `connector_sync_state.last_error`.
- A per-item mapping or write error is reported as `<Label> item <id>: ...`.
  After 3 failures the item goes to `connector_dead_letters` (the payload is
  redacted, and anything over 64 KB is replaced by a size note). The item is
  then skipped until its content changes.
- **Conflict rule:** if a local title, due date or status change hasn't
  reached the source yet (a pending update), import leaves those fields alone
  until the update lands.
- **Completion gate:** `executeAction('complete')` closes the item through the
  update action and completes the task locally only after that succeeds.
  `exportUpdate` round-trips title, due date and open/closed.

### Retries and scheduling (`bridge/retry.ts`, `bridge/scheduler.ts`)

- 429 and 5xx responses, piece timeouts and host crashes are retryable.
  Everything else fails permanently. Pieces report HTTP failures as messages,
  so `classifyError()` reads the status (pieces-common `"status":503`, axios
  `status code 503`, "rate limit") and any `Retry-After` from the message.
- The backoff is `30 s x 2^(n-1)`, capped at 1 h. A `Retry-After` value wins
  (up to 24 h), and even a manual sync honours it. A manual sync can skip a
  5xx backoff window.
- Job attempts are stored in `connector_sync_state` (`attempt_count`,
  `next_retry_at`, `last_error`). Per-item failures, pending updates, the
  rate-limit window and trigger state live in the `cursor` JSON. All of it
  survives a restart. After 5 failed attempts the job is dead-lettered and
  normal polling resumes.
- An update that fails transiently is queued and retried by the scheduler. A
  permanent failure is dead-lettered.
- The scheduler ticks every 30 s. A source runs when a retry is due, or every
  `poll_interval_minutes` (default 15, 0 = manual only).

### Config and IPC

Task-source config: `piece_name`, `connector_instance_id`, `props` and
`poll_interval_minutes`. The form (`ConnectorBridgeConfigForm.tsx`) uses the
`connectors:*` IPC (`src/main/ipc/connectors.ts`) to list the mapped pieces,
create the instance, store or clear credentials (write-only, with the
session-only fallback when the keychain is unavailable) and read sync status.
Nothing in the bridge is exposed to coding agents through MCP or the task API.
