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

### OAuth2 pieces (`src/main/connectors/oauth.ts`, #15)

A piece declared with `PieceAuth.OAuth2({ authUrl, tokenUrl, scope })` gets an
`oauth` block in its allowlist entry (`AllowedPieceOAuth`: `mode`, `authUrl`,
`tokenUrl`, `scopes`, `pkce`, `loopbackRedirect`; see docs/taskSources.md
"Connector OAuth2" for the per-provider decisions) and `auth.type: 'oauth2'`
in its task mapping. The repo never holds a client secret.

- **Flow.** `ConnectorOAuthService.connect(instanceId, { clientId, clientSecret })`
  runs `runLoopbackOAuthFlow()` (`src/main/oauth/connector-oauth-flow.ts`):
  the same steps as `OAuthManager.startLocalhostOAuthFlow` — `LocalOAuthServer`
  on `http://localhost:3000-3010/callback`, a PKCE pair from
  `src/main/oauth/pkce.ts`, a `state` check, code exchange — through a
  `ConnectorOAuthProvider` (`src/main/oauth/providers/connector-oauth-provider.ts`)
  built from the allowlist entry. PKCE is sent only when the entry says the
  provider supports it. The token endpoint is the only network call the main
  process makes for a connector.
- **Storage.** The token set (`{ type: 'oauth2', clientId, clientSecret,
  accessToken, refreshToken, expiresAt, ... }`) is stored with the instance's
  other credentials: safeStorage ciphertext, or session-only, with the same
  no-plaintext-fallback rule. It is keyed by connector instance id. The
  `oauth_tokens` table is not used because its `source_id` / `mcp_server_id`
  columns are foreign keys to task sources and MCP servers; moving connector
  tokens there needs a schema change and would reintroduce `encryptSecret`'s
  plaintext fallback.
- **Resolution.** The service is the `PieceCredentialSource` every piece call
  goes through (`ConnectorRuntime.credentials`). It refreshes a token that
  expires within five minutes, persists the new set, and hands the piece only
  `{ type: 'OAUTH2', access_token, token_type, scope }` — never the refresh
  token or the client secret.
- **Failure.** A token that is expired with no refresh token, or whose refresh
  the provider refuses with `invalid_grant`, is marked `revoked` and every
  use throws `ConnectorOAuthError` (`code: 'CONNECTOR_OAUTH'`). The bridge
  turns that into one permanent sync error (`<Label> sync failed: <Label>
  access was revoked or has expired; reconnect it in the task source
  settings. Existing tasks were kept.`) in the sync result and
  `connector_sync_state.last_error`, with no retries and no dead letter; a
  local edit made meanwhile is queued and lands on the first sync after the
  user reconnects. A token revoked at the provider without a refresh step
  surfaces as the piece's own `HTTP 401` permanent error. Neither path
  crashes a sync or touches cached tasks.
- **IPC / form.** `connectors:oauthConnect(instanceId, { clientId,
  clientSecret }, storage)` runs the flow; `connectors:credentialStatus`
  reports `oauth.state` (`none` / `connected` / `revoked`);
  `connectors:clearCredentials` disconnects. `ConnectorBridgeConfigForm`
  shows the client id / secret fields, the redirect URL to register, the
  requested scopes, a Connect (or Reconnect) button and Disconnect.

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
  the title, the due date (ISO 8601, or `YYYY-MM-DD` with
  `dueDateFormat: 'date'`) and open/closed. A local Completed closes the item
  and a local Not Started reopens it. The other workflow states belong to 21x
  and are never pushed. When the update action cannot change completion,
  `statusActions` names dedicated `complete` / `reopen` actions; the bridge
  runs the status action first, then the update action for the other fields.

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

## Todoist OAuth2 proof (#15)

`src/main/connectors/bridge/todoist-oauth.test.ts` drives the **real pinned
`@activepieces/piece-todoist` 0.5.0 bundle** through the real piece-host
runtime and the connector bridge, with the token resolved by
`ConnectorOAuthService`, against a **fake Todoist**: a fake authorization
server (the "browser" is a function that checks the authorization URL and
calls the real loopback callback server over localhost), a fake token endpoint
and a fake task API behind `globalThis.fetch`. Nothing reaches the network.
The allowlist entry, its `oauth` block and the Todoist mapping under test are
the production ones; the test also asserts the `oauth` block equals the
piece's own `todoistAuth` declaration.

Todoist is wired with the same three declarative entries as Trello
(`allowlist.ts`, `bridge/mappings.ts`, `piece-host/piece-registry.ts`), which
a test asserts are the only non-test files in `src/main/connectors/**` that
mention it.

| Case | Result |
| --- | --- |
| Connect | Authorization URL: `response_type=code`, the user's client id, loopback `redirect_uri`, `scope=data:read_write`, `state`; no PKCE parameters for Todoist. Exchange: form-encoded with the client secret and the same redirect URI. Token set stored as keychain ciphertext (`auth_type = oauth2`); no secret in the browser URL. |
| PKCE | With a provider entry that sets `pkce: true`: S256 `code_challenge` in the URL, `code_verifier` at exchange (verified by the fake), no client secret needed (public client). |
| Refused exchange / keychain unavailable | Nothing stored; the keychain check happens before the browser opens and the session-only path connects. |
| Import | `todoist_filter_tasks` follows `next_cursor` across pages, sends `Authorization: Bearer <token>`, maps `content` / `description` / `due.date` / `labels`; completed tasks are not returned by Todoist and never create tasks. |
| Refresh | Expired (or within five minutes of expiry, including after a restart): one `grant_type=refresh_token` request with the client credentials, the new set persisted, the new bearer used for every later call, no second refresh within the window. |
| Revoked (refresh refused) | One clear permanent error, `last_error` set, no retries, no dead letter, no task change, no secret in errors or logs, status `revoked`, no further token requests; completion gate fails cleanly; a local edit is queued; reconnect lands it. |
| Revoked (non-expiring token, as real Todoist) | `HTTP 401` permanent error, no refresh attempted. |
| Expired, no refresh token | "cannot be renewed; reconnect" error, no API call. |
| Round trip | Complete closes first (`POST /tasks/{id}/close`), then the task completes; reopen + title + due date go as `/reopen` then `POST /tasks/{id}` with `content` and `due_date=YYYY-MM-DD`; workflow states and descriptions never sent; a 5xx on the field update after a successful close is queued and retried. |
| Disconnect | Token set and client registration gone; the next sync asks to connect. |

Limits found:

- **Completed tasks disappear rather than complete.** `todoist_filter_tasks`
  returns active tasks only, so a task closed in Todoist stops appearing and
  the 21x task stays open. Closing through the mapping's status field needs
  `todoist_list_completed_tasks*` (a second import target), which the
  declarative format does not have.
- **No task link.** Todoist's API v1 task object has no `url`; the mapping
  cannot synthesise `https://app.todoist.com/app/task/<id>`.
- **Due dates are calendar days.** The piece routes any value matching
  `\d{4}-\d{2}-\d{2}` to Todoist's `due_date`, which refuses a timestamp, so
  the mapping pushes `YYYY-MM-DD` (`dueDateFormat: 'date'`); a time of day set
  in 21x is dropped at the source.
- **Real Todoist issues no refresh token.** The refresh path is proven against
  the fake provider; with Todoist it is never exercised and revocation shows
  up as `HTTP 401`.
