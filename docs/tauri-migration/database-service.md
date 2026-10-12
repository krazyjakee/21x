# Synthetic database service slice

`src/service/database-stdio.ts` is the packaged Node entry. It redirects dependency diagnostics to fixed redacted stderr before dynamically importing the domain bootstrap in `database-service.ts`. `pnpm tauri:prepare:database` bundles it with the existing Vite SSR tooling, retaining only the reviewed SQLite/cuid2 runtime imports. A checked `resources/service/database-stdio.mjs` wrapper verifies the pinned Node version, package versions and physical module containment before importing `database-engine.mjs`. Staging writes changed bytes atomically and does not copy repository dependencies. Runtime package dependencies are only standalone-ABI `better-sqlite3` and pure JavaScript `@paralleldrive/cuid2`. There are no agent SDK, Electron, subprocess, or managed MCP tool registry imports.

This entry requires private pipe/socket stdin/stdout, `TWENTYONEX_DATABASE_MODE=synthetic-only`, and absolute host-injected `TWENTYONEX_PROFILE_ROOT` / `TWENTYONEX_RESOURCE_ROOT`. The profile must physically reside under the canonical OS temporary directory and have the dedicated `21x-database-service-` prefix. First initialization accepts only a fresh directory plus the lifetime lock's own files; it never adopts an unmarked existing database. A private `.21x-synthetic-database.json` marker permits subsequent synthetic reopen. The directory and marker do not authorize production migration.

Initialization acquires the shared SQLite lifetime profile guard, uses its canonical root, configures an ephemeral authenticated provider, and then opens the real `DatabaseManager`. No credential operations are exposed. Managed MCP is explicitly disabled; no nonexistent entry/tool capability is advertised. The guard is asserted before each operation and stays held through database close and provider disposal. The permanent lock sentinel must never be copied, read through an unrelated descriptor, or unlinked while held. The native host owns deletion of the disposable profile only after the service has exited.

## Shared wire codecs

`src/shared/database-desktop-codecs.ts` exports `DATABASE_COMMAND_CODECS` and `DATABASE_EVENT_CODECS`, structurally compatible with the renderer client. Payloads are exact named JSON objects, with explicitly optional arguments omitted. Responses use the existing `OptionalResult<JsonValue>`; the native renderer adapter wraps them as `{ engineEpoch, result }`. Undefined and null stay distinct. No automatic JSON conversion of arbitrary undefined/Buffer values is performed.

| Command | Wire payload | Slice behavior |
| --- | --- | --- |
| `db:getTasks` | `{ projectId? }` | Scoped user tasks; coordinator rows remain hidden |
| `db:getTask` / `db:deleteTask` | `{ id }` | Read/delete an eligible local task; missing read is undefined, missing delete is false |
| `db:createTask` | `{ data }` | Local idle task; title plus description/type/priority/labels/project ID, explicit initial status and disabled automation flags |
| `db:updateTask` | `{ id, data }` | Content edits only: title/description/type/priority/labels |
| `project:getAll` | `{ includeArchived? }` | Scoped project list |
| `project:get` | `{ id }` | Scoped project lookup |
| `project:getDefault` | `{}` | Default project lookup |
| `project:create` | `{ data: { name, description? } }` | Create a project and its durable Captain row |
| `settings:get` | `{ key }` | Read an explicitly permitted synthetic UI setting; absent is null |
| `settings:set` | `{ key, value }` | Store a permitted UI setting; result is undefined |
| `settings:getAll` | `{}` | Only theme/sidebar/synthetic UI keys; no credential or internal settings |
| `agentSession:getTranscriptSnapshot` | `{ taskId, sinceSeq? }` | Real durable projection snapshot |
| `agentSession:getTranscriptDelta` | `{ taskId, sinceRev }` | Real durable projection delta and revision cursor |

Task creation/update validation rejects agent assignment, active status transitions, automation, recurrence, source writes, and unsupported metadata. Mutation authorization also refuses active/nonlocal/Captain tasks. This avoids bypassing the shipping task/agent lifecycle owners, which are not connected yet. The registry additionally requires injected trusted-caller/project/settings authority. The synthetic bootstrap authorizes its private owned host pipe for the disposable profile; actual WebView label/origin/frame authorization remains the native command boundary's job.

Task result encoding selects declared renderer fields and excludes private `mcp_scope_nonce`, legacy checklist JSON, and other undeclared database columns. Results and events have explicit validators. Five targeted events (`task:created`, `task:updated`, `task:deleted`, `project:changed`, `transcript:changed`) carry the existing v1 envelope, engine epoch, and a global sequence starting at 1. Updated task IDs and transcript part task IDs must match their event's task. Snapshot/delta results are bounded to 128 parts and existing protocol frame limits; a result that cannot fit fails explicitly. Chunked large-snapshot recovery remains unfinished.

`fixture.transcriptUpsert` is a private synthetic test ingress, outside the desktop manifest and renderer allowlist. It accepts `{ taskId, parts }` (at most 32 explicitly validated parts) and uses the real production transcript transaction/upsert path, emitting durable deltas. Its result is the exact internal `{ maxRev, changedPartIds }` shape. It does not simulate a model, session, or approval response.

## Lifecycle and remaining gates

After `pnpm tauri:prepare:native` and `pnpm tauri:prepare:database`, build with
`pnpm tauri:build --debug --features synthetic-desktop`. That explicit feature
selects the fixed database entry, a fresh private temporary profile, fourteen
native command schemas and targeted desktop events. The ordinary feasibility
build keeps its existing entry. The frontend reveals an isolated task list/form
and durable transcript reads only when native status identifies the synthetic
service. Its debug GUI proof creates/edits a task, observes events, creates a
project, persists a setting, reloads the actual WebView and rehydrates those
records. Browser commands and a stale epoch are tested at the native boundary.
The manual Linux native workflow has a `synthetic-desktop` mode for this check;
passing direct-child or headless Rust tests does not establish the GUI result.

The standard initialize/ping handshake returns exactly `{ protocolVersion: 1, engineEpoch, nodeVersion: process.version }`; shutdown accepts `{}` and returns `{ stopped: true }`. Shutdown waits for active handlers and queued response/event writes to drain before closing resources. Pipe EOF/error and signals stop the service; protocol cancellation remains advisory and committed mutations are never replayed. This service spawns no children.

Shared codec tests cover named arguments, unsupported lifecycle fields, binary rejection, privacy projection, undefined/null semantics, and event association. Peer tests cover final response drain and disconnect rejection. The standalone SQLite proof retains real CRUD/projection/reopen coverage with explicit ABI selection. Native integration, packaged service execution, renderer reload/hydration, and lock-contention/crash proofs are central/native batch work.

After the native owner stages the checked entry, `node scripts/database-service-proof.mjs --service-entry /absolute/repo/src-tauri/resources/service/database-stdio.mjs --node /absolute/standalone/node` runs a direct private-pipe proof against that actual bundle. It checks competing-profile startup rejection, real commands/events, cancellation before effects, unknown approval/credential command denial, projection updates and duplicate suppression, reload-style snapshot/delta queries, graceful drain/exit, reopen persistence, new epochs, and selected-task deletion. The Vitest wrapper skips unless `TAURI_DATABASE_SERVICE_ENTRY` explicitly selects the staged entry; `TAURI_NODE_RUNTIME` selects the standalone executable, defaulting to `node` on PATH rather than an Electron runner. No addon build or implicit root SQLite fallback occurs. All children must exit before the synthetic profile is removed; a failed child stop retains it and fails the report. These reload queries are not an installed GUI reload or HITL proof.

Windows pipe validation retains the same strict FIFO/socket boundary. Source review of pinned Node 22.23.2 shows libuv classifying `FILE_TYPE_PIPE` as `UV_NAMED_PIPE`, then returning `_S_IFIFO` from fstat; ordinary owned pipes should therefore satisfy `isFIFO()` without permitting redirected regular files. This is source inference, with execution still required on Windows. [Handle classification](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/win/handle.c#L28), [fstat classification](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/win/fs.c#L2046).

G2 is partial: real agent transcript ingress, HITL approval ownership/response, complete task lifecycle/source effects, full settings behavior and masking, large snapshots, and all other desktop operations remain unbound. `agentSession:approve` deliberately remains unknown until its real owner is integrated. Neither this entry nor its marker enables live migration, profile import, or automatic task restart.
