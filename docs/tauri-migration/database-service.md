# Synthetic database service slice

`src/service/database-stdio.ts` is the packaged Node entry. It redirects dependency diagnostics to fixed redacted stderr before dynamically importing the domain bootstrap in `database-service.ts`. `pnpm tauri:prepare:database` bundles it with the existing Vite SSR tooling, retaining only the reviewed SQLite/cuid2 runtime imports. A checked `resources/service/database-stdio.mjs` wrapper verifies the pinned Node version, package versions and physical module containment before importing `database-engine.mjs`. Staging writes changed bytes atomically and does not copy repository dependencies. Runtime package dependencies are only standalone-ABI `better-sqlite3` and pure JavaScript `@paralleldrive/cuid2`. No agent SDK or Electron runtime is loaded, and no model call, shell process, or managed MCP tool registry is enabled. The optional agent mode uses the actual portable manager with an explicitly injected deterministic adapter.

This entry requires private pipe/socket stdin/stdout, `TWENTYONEX_DATABASE_MODE=synthetic-only`, and absolute host-injected `TWENTYONEX_PROFILE_ROOT` / `TWENTYONEX_RESOURCE_ROOT`. The profile must physically reside under the canonical OS temporary directory and have the dedicated `21x-database-service-` prefix. First initialization accepts only a fresh directory plus the lifetime lock's own files; it never adopts an unmarked existing database. A private `.21x-synthetic-database.json` marker permits subsequent ordinary synthetic database reopen. The debug agent mode requires a fresh profile and rejects an existing marker. The directory and marker do not authorize production migration.

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

Task creation/update validation rejects agent assignment, active status transitions, automation, recurrence, source writes, and unsupported metadata. Mutation authorization also refuses active/nonlocal/Captain tasks. These database mutations cannot bypass agent lifecycle ownership. The optional agent mode connects its separately authorized fixture task through the actual manager described below. The registry additionally requires injected trusted-caller/project/settings authority. The synthetic bootstrap authorizes its private owned host pipe for the disposable profile; actual WebView label/origin/frame authorization remains the native command boundary's job.

Task result encoding selects declared renderer fields and excludes private `mcp_scope_nonce`, legacy checklist JSON, and other undeclared database columns. Results and events have explicit validators. Five targeted events (`task:created`, `task:updated`, `task:deleted`, `project:changed`, `transcript:changed`) carry the existing v1 envelope, engine epoch, and a global sequence starting at 1. Updated task IDs and transcript part task IDs must match their event's task. Snapshot/delta results are bounded to 128 parts and existing protocol frame limits; a result that cannot fit fails explicitly. Chunked large-snapshot recovery remains unfinished.

`fixture.transcriptUpsert` is a private synthetic test ingress, outside the desktop manifest and renderer allowlist. It accepts `{ taskId, parts }` (at most 32 explicitly validated parts) and uses the real production transcript transaction/upsert path, emitting durable deltas. Its result is the exact internal `{ maxRev, changedPartIds }` shape. It does not simulate a model, session, or approval response.

## Lifecycle and remaining gates

After `pnpm tauri:prepare:native` and `pnpm tauri:prepare:database`, build with
`pnpm tauri:build --debug --features synthetic-desktop`. That explicit feature
selects the fixed database entry, a fresh private temporary profile, the fourteen base database
native command schemas and targeted desktop events. The ordinary feasibility
build keeps its existing entry. The frontend reveals an isolated task list/form
and durable transcript reads only when native status identifies the synthetic
service. Its debug GUI proof creates/edits a task, observes events, creates a
project, persists a setting, reloads the actual WebView and rehydrates those
records. Browser commands and a stale epoch are tested at the native boundary.
The manual Linux native workflow has a `synthetic-desktop` mode for this check.
The [installed Linux database-only run](https://github.com/krazyjakee/21x/actions/runs/38288055264) passed its 13 Boolean receipts; the checked [report](evidence/linux-x64-synthetic-desktop-installed-gui.json) records the actual GUI reload. Direct-child or headless Rust tests alone do not establish that result.

The standard initialize/ping handshake returns exactly `{ protocolVersion: 1, engineEpoch, nodeVersion: process.version }`; shutdown accepts `{}` and returns `{ stopped: true }`. Shutdown waits for active handlers and queued response/event writes to drain before closing resources. Pipe EOF/error and signals stop the service; protocol cancellation remains advisory and committed mutations are never replayed. This service spawns no children.

Shared codec tests cover named arguments, unsupported lifecycle fields, binary rejection, privacy projection, undefined/null semantics, and event association. Peer tests cover final response drain and disconnect rejection. The standalone SQLite proof retains real CRUD/projection/reopen coverage with explicit ABI selection. Native integration, packaged service execution, renderer reload/hydration, and lock-contention/crash proofs are central/native batch work.

After the native owner stages the checked entry, `node scripts/database-service-proof.mjs --service-entry /absolute/repo/src-tauri/resources/service/database-stdio.mjs --node /absolute/standalone/node` runs a direct private-pipe proof against that actual bundle. It checks competing-profile startup rejection, real commands/events, cancellation before effects, unknown approval/credential command denial in database-only mode, projection updates and duplicate suppression, reload-style snapshot/delta queries, graceful drain/exit, reopen persistence, new epochs, and selected-task deletion. The Vitest wrapper skips unless `TAURI_DATABASE_SERVICE_ENTRY` explicitly selects the staged entry; `TAURI_NODE_RUNTIME` selects the standalone executable, defaulting to `node` on PATH rather than an Electron runner. No addon build or implicit root SQLite fallback occurs. All children must exit before the synthetic profile is removed; a failed child stop retains it and fails the report. These reload queries are not an installed GUI reload or HITL proof.

Windows pipe validation retains the same strict FIFO/socket boundary. Source review of pinned Node 22.23.2 shows libuv classifying `FILE_TYPE_PIPE` as `UV_NAMED_PIPE`, then returning `_S_IFIFO` from fstat; ordinary owned pipes should therefore satisfy `isFIFO()` without permitting redirected regular files. This is source inference, with execution still required on Windows. [Handle classification](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/win/handle.c#L28), [fstat classification](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/win/fs.c#L2046).

## Debug actual-manager approval path

After native/database staging, `pnpm tauri:build --debug --features synthetic-agent` selects the same fixed database entry and adds five commands through `desktop_invoke`. This feature is rejected at compile time outside debug builds. The host injects `TWENTYONEX_AGENT_MODE=deterministic-fixture`; the renderer cannot select the mode, adapter, profile, or executable. Startup creates one public fixture agent and a dedicated synthetic task in the same real SQLite database, with the same profile lock and ephemeral authenticated provider. Existing profiles are rejected. No SDK/model, shell, secrets, browser, or managed MCP services are enabled.

| Command | Wire payload | Actual owner behavior |
| --- | --- | --- |
| `agent:getAll` | `{}` | Public fixture agent only |
| `agentSession:start` | `{ agentId, taskId, skipInitialPrompt? }` | Scoped assignment and real manager admission/start; no arbitrary workspace or skipped fixture prompt |
| `agentSession:resume` | `{ agentId, taskId, sessionId }` | Exact persisted/live owner association and current status snapshot |
| `agentSession:approve` | `{ sessionId, approved, requestId, message?, responseType? }` | Required matching live approval identity and persisted running card; actual manager response and adapter decision confirmation |
| `agentSession:stop` | `{ sessionId }` | Acknowledged actual manager/adapter teardown |

The deterministic adapter generates the permission request; database service code does not fabricate approval success. Stale, duplicate, missing, foreign, and restored callback identities are rejected. Agent CRUD, arbitrary sends, other tasks/sessions and real backend parity remain outside this grant. [Agent desktop boundary](agent-desktop-boundary.md) and [portable manager](portable-agent-manager.md) describe the owner and fixtures.

The agent mode validates actual manager task/projection/status events plus bounded queue, project, concurrency and recovery notifications. These share the database event envelope, adopted epoch and global sequence, targeted only to native `main`. The staged owner proof passed with real standalone-ABI SQLite, **85 modules and 30 validated events**, covering approval acceptance/rejection, pending live-resume snapshot, acknowledged stop, owner recreation and durable projections. The actual bundled private-pipe proof passed locally with 14 events and on the hosted runner with 15; counts reflect observed notifications, not a fixed API contract. Both verified pending-owner snapshot, approval completion and active-task deletion denial.

The agent GUI runner extends the database-only receipt from 13 to **20 Booleans**. It starts the dedicated task, observes the actual pending approval and rejects a stale request, then returns `{ reloadRequired: true }`. After an actual WebView reload it resumes the existing owner, restores the pending permission card and enabled approval control, sends the matching response, and observes durable approved output and `ready_for_review`. The seven additional receipts are `agentStarted`, `approvalRequested`, `staleApprovalDenied`, `approvalAccepted`, `agentCompleted`, `agentStatusEventObserved`, and `agentTranscriptRehydrated`. The [installed Linux run](https://github.com/krazyjakee/21x/actions/runs/38299978450) passed all twenty, native close and owned-process absence at `a4a980f`; its [retained report](evidence/linux-x64-synthetic-agent-installed-gui.json) also records the passing native and private-pipe proofs. Other OS families still need this actual agent slice.

Shutdown stops the real manager before closing SQLite. It stops polling/retry timers and drains owned starts/polls/idle transitions with a one-second bound, then cancels the 125 ms projection coalescing timer and synchronously flushes pending durable events. `AGENT_SHUTDOWN_INCOMPLETE` retains ownership maps; any owner/server shutdown failure exits with database/provider/profile lock still held rather than closing resources prematurely. The service has a three-second forced-exit fallback. Fixtures use this owner drain instead of an arbitrary post-stop sleep.

This is not an all-SDK shutdown proof: raw adapter creation can outlive its inner timeout and subsequent cleanup callback, and asynchronous transcript backfill/persisted-message reads are not comprehensively lifetime-tracked. Those real-provider paths remain gates. Complete task/source effects, full settings behavior and masking, large snapshots, backend parity and remaining desktop operations are still unfinished. Neither this entry nor its marker enables live migration, profile import, or automatic task restart.
