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

## Trello proof of concept (#16)

`src/main/connectors/bridge/trello-poc.test.ts` drives the **real pinned
`@activepieces/piece-trello` 0.6.0 bundle** through the real piece-host runtime
(in-process behind a fake transport, loaded by the production
`piece-registry.ts`) and the connector bridge, against a fake Trello HTTP API.
pieces-common 0.12.5, which the piece bundles, sends every request through the
global `fetch`, so the fake API replaces `globalThis.fetch`; nothing reaches
the network. The allowlist and the Trello mapping under test are the
production ones.

### Wiring

Trello is wired with three declarative entries and nothing else:

| Where | What |
| --- | --- |
| `allowlist.ts` | `@activepieces/piece-trello@0.6.0`, 13 actions, the `deadline` polling trigger |
| `bridge/mappings.ts` | import through `list_cards_in_board` (`filter: all`), fields `id`/`name`/`desc`/`due`/`url`/`labels[].name`/`closed`, update through `update_card` (`name`, `due`, `closed`) |
| `piece-host/piece-registry.ts` | the static `require` line for the bundled package |

A test walks `src/main/connectors/**` and asserts those are the only
non-test files that mention Trello, and that the mapping survives a JSON round
trip (pure data, no functions). Outside the connector layer the word appears
only in user-facing strings (the plugin description and setup text, the
source-label colour in `TaskBoard.tsx`). There is no Trello client code.

### Test matrix

| Case | Result |
| --- | --- |
| Import: cards → canonical fields (title, description + link, due date or null, labels, open/closed); archived cards never create tasks | Pass |
| Round trip: complete closes the card first (`PUT /1/cards/{id}` `{closed:true}`), then the task completes; title and due date pushed; Not Started reopens; workflow states never sent; next import reads back what was pushed | Pass |
| Pagination | The action asks once, with no page cursor; Trello returns the board in one response. The bridge imports the first 1000 items and reports the rest (tested with 1001). See limits below. |
| 429 | Backs off, blocks manual syncs for the window, recovers. The `Retry-After` header is **not** honoured with the real piece (see below). |
| 5xx | Exponential backoff, then dead letter after `maxAttempts`; cached tasks untouched and still editable throughout |
| 401 / revoked token | One clear permanent error (`Permission denied…` on import, `HTTP 401: invalid token` on the completion gate), no retries, no dead letter, no task changes, no secret in errors, sync state or host logs |
| Cancellation mid-sync | Fails cleanly (`…cancelled. Existing tasks were kept.`), no backoff, host killed, next sync uses a fresh host |
| Restart during a sync | Attempt count, `next_retry_at` and the cursor resume from `connector_sync_state`; the scheduler waits until due. A sync interrupted in flight writes nothing before the piece answers, and an orphaned run converges on the same tasks (idempotent). |
| Duplicate items | The same card twice in one response and across syncs yields one task |
| Piece crash | `PieceHostCrashedError` is retried with backoff; the host is restarted on the next call |
| Piece timeout | A hung request hits the call timeout, the host is killed, the sync fails with `attempt n of m`; the next sync succeeds on a fresh host |
| 100 items | 100 cards imported (99 plus one per-item mapping error reported as `Trello item c-100: …`), 99 updates pushed; a card deleted at the source dead-letters with `HTTP 404: The requested resource was not found.`, a transient 503 is queued and lands on the next sync; the local edit wins until then |
| Polling trigger cursor | The real `deadline` trigger keeps `lastPoll` in `connector_kv` (scope `flow`) across a restart and only emits new cards |

### What needed fixing

- `bridge/retry.ts` `errorMessage()`: pieces-common's `HttpError` puts the
  whole failure in the message as `{"response":{"status":404,"body":…},"request":{"body":…}}`.
  Users now see `HTTP 404: <body>` in per-item errors, sync state, dead letters
  and the completion-gate error; the request body (task text) is left out.
  Classification still reads the raw error.
- No mapping, allowlist or engine bug was found with the real piece.

### Limits found (plainly)

- **`Retry-After` is lost.** pieces-common serialises only status and body into
  the error, so the bridge cannot see the header; 429s use the bridge's own
  backoff (30 s, 60 s, …). Trello's 429 is rewritten by the piece to
  "Trello rate limit exceeded", which the classifier recognises.
- **No pagination.** `list_cards_in_board` has no page cursor and requests every
  card field. Real cards are 2–3 KB of JSON, so a board of roughly 1500–2500
  cards exceeds the 5 MB output cap and the sync fails with a clear, permanent
  error (tasks are kept). Boards above 1000 cards import only the first 1000.
  A fix needs a `fields` or `limit` prop upstream, or a per-list import
  (`list_cards_in_list`).
- **List moves are not a status.** Archive (`closed`) ↔ Completed is the status
  round trip. Moving a card to another list changes nothing in 21x, and 21x
  cannot move cards; that needs a config-valued status mapping
  (`done_list_id`) that the declarative format does not have yet. Clearing a
  due date is not pushed either (the piece ignores a falsy `due`).
- **Cancellation** is driven by the `AbortSignal` on `PieceHostClient.call`;
  the engine does not expose one, so today only app shutdown (`dispose()`) or
  a caller-provided runtime wrapper cancels a sync.
- **Security (fixed):** pieces-common's `sendRequest()` sets
  `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` inside the piece host on
  every request, which would make the host accept any certificate for
  `api.trello.com` and expose Trello's key + token (query-string auth) to a
  man-in-the-middle. `piece-host/tls-guard.ts`, installed by `host-entry.ts`
  before any piece code runs, clears that override on every fetch and pins
  `https.globalAgent` to verify peers; `trello-poc.test.ts` checks it holds
  through a real import.

### Success criteria

| Criterion | Verdict |
| --- | --- |
| Allowlist entry + declarative mapping only, no Trello client code | Met (asserted by test) |
| Round-trip updates reliable | Met for title, due date and open/closed; list moves and due-date clearing are out of the mapping's reach |
| Cached tasks stay usable when the piece fails | Met for 401, 429, 5xx, crash, timeout, cancellation and deleted cards |
| Per-piece package cost acceptable | Not decided here. Unpacked size: `src/index.js` 495 KB plus 73 KB of i18n (13 locales), no runtime dependencies, framework and pieces-common inlined. Packaged size, host cold start, memory and 100-item sync timings per platform are #17's measurements. |

The connector layer holds up for Trello with the limits above. The TLS
finding is the one blocker before a release that bundles the piece.
