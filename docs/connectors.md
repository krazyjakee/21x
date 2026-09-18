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
