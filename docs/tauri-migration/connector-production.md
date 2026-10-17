# Production connector controls

`ConnectorBackend` supplies seven exact desktop form controls: bridgePieces,
ensureInstance, credentialStatus, setCredentials, clearCredentials,
oauthConnect and syncStatus. `CONNECTOR_CODECS` defines their bounded requests
and public results. This implementation is scoped progress for #216, not a claim
of installed packaged worker/OAuth parity or authorization to release or migrate
a live profile.

The backend borrows the actual DatabaseManager, SyncManager,
ConnectorBridgeService, ConnectorRuntime, ConnectorBridgeEngine,
ConnectorCredentialStore and captured authenticated SecretStorage. The root
owner checks those identities and current lifetime. The registry independently
checks the trusted WebView/origin and current engine epoch. Registration never
supplies permissions. Global configuration, mapped piece, instance, every
referring source/project and every imported task grant are checked before
operations. No generic piece call, filesystem path, callback namespace or worker
spawn command is added.

Only currently mapped, allowlisted Trello and Todoist pieces at their exact pins
are usable. A supplied instance ID must already exist, belong to the permitted
scope and match the requested piece/pin. Missing, foreign and mismatched IDs fail
before calling legacy ensureInstance; they never create a replacement. Instance
creation without an ID requires an explicit trusted creation grant and finite
capacity. Existing allowlist, licensing and worker package constraints remain
owned by the real runtime.

Credential input is write-only. Declared optional undefined form fields are
omitted from the wire; unknown fields and saved-key markers reject. Persistent
storage uses the exact captured authenticated provider and credential store,
with no plaintext fallback. Session intent uses the runtime's actual memory
store and clears persisted credentials. Unavailable persistent storage returns
fixed remediation and never selects session storage automatically. Status reads
the actual store. Clear affects the actual session and persisted copies.

Credential mutations first hold relevant source mutation leases, draining
accepted imports/exports/background work. Source/task/config/instance snapshots
are rechecked after asynchronous joins and before effects. The runtime's actual
admission guard conservatively refuses outstanding direct engine, piece-client,
OAuth and retiring-worker work, including raw callbacks after public cancellation.
It fences new calls to the same instance through the credential effect. No busy
foreign work is cancelled or mutated. These refusals require a fresh user action;
there is no deferred mutation replay.

OAuth defaults to unavailable before navigation, callback server or network
work. An available native browser/callback owner invokes the actual service with
an internal runtime admission token. The OAuth owner executes the allowlisted
provider flow and token storage, with a backend callback immediately before the
credential write. That callback rechecks cancellation, owner/storage identity,
permission and exact instance/source/task snapshots. Revoked scope, a changed
source binding or caller cancellation during an accepted network flight cannot
persist the late token. Raw network/callback cleanup stays owned after public
cancellation. Root must stop the runtime concurrently with backend drain and
retain the credential store/database if that drain fails. No simulated successful
callback or notification substitutes for native OAuth ownership.

SQL preflights bound legacy instance config/auth, connector source config, sync
cursor and dead-letter payloads before legacy getters can materialize or parse
them. Oversized or malformed records reject and remain stored. Sync status keeps
retry timestamps/counts but replaces error text with a fixed message; credentials,
provider diagnostics, cursors and dead-letter contents never leave this surface.
There is no new event transport or a second background state writer.

## Authored evidence and remaining gates

New codec/backend tests exercise actual portable SQLite/schema, the bridge
service/runtime, encrypted credential/session stores and SyncManager leases.
They cover finite commands, mapped metadata, missing/wrong/foreign instance IDs,
credential/storage/marker semantics, scoped references, immutable async input,
source config changes during drain, direct raw-work refusal, unavailable OAuth,
redacted status, preparse limits and replaced-owner rejection. Controlled OAuth
tests use the actual flow with a synthetic browser invoking a local callback and
a controlled token endpoint; they exercise cancellation and the late prewrite
scope fence. They do not open an external browser or call live connector accounts.
No checks or tests were executed by the implementation worker.

Coordinator validation should run these suites, existing bridge/runtime/worker/
OAuth/source lifetime tests, production owner/native codec/corpus integration,
and global checks. Packaged Node worker containment, call-scoped KV, durable
cursor crash/restart behaviour, representative live retained connectors,
supported native OAuth warm/cold callbacks and final identity integration still
need their stated installed-target evidence. Hosted issue #92 remains deferred.

Coordinator validation and source provenance are recorded in [the October 14
form-control evidence](evidence/issue-closing-20261014-connector-plugin-forms.json).


## Atomic worker checkpoints (October 17 continuation)

`kvBackendFromConnectorStore` now creates a journal for each actual SQLite-backed
worker call. Reads see the call's staged writes/deletes in the captured instance
and scope. Other calls and durable readers keep seeing the committed state.
Failure, cancellation, timeout and process exit discard the journal. A successful
result commits all edits in one SQLite transaction; a failed later write rolls
back earlier edits. Existing key/value/instance limits still apply, and the
in-memory journal additionally bounds staged bytes to 10 MiB and distinct keys
to 4,096. Values are JSON snapshots, so retained references cannot modify a
pending checkpoint. Closed journals reject late access.

The bridge accepts successful import output through a trusted synchronous
callback retained only in the parent. It never sends that callback to a worker
or exposes it as a desktop command. Task upserts, sync state and the call's KV
checkpoint share one transaction. Validation/item errors keep the old worker
checkpoint, allowing a later poll to replay idempotent task upserts. Trigger
onEnable's KV initialization and its enable marker likewise share a transaction;
there is no open SQLite transaction while awaiting worker or network work.
External provider side effects remain outside SQLite rollback.

The standalone transport requests SIGTERM once, escalates to SIGKILL after
250 ms if the child remains open, and clears the escalation timer on actual
close. It targets only its captured child process. The existing raw-work/close
barriers remain authoritative; requesting either signal is not an exit receipt.

Regressions compile the real host loop with an explicitly synthetic provider
loader and use real Node IPC, actual authenticated ciphertext, per-instance KV,
on-disk SQLite reopen, worker errors/crash/timeout/cancel, a SIGTERM-ignoring child,
failed final commit and failed enable-marker writes. The separate existing staged
proof still loads the actual pinned Trello/Todoist local hooks. Synthetic loader
results do not prove live provider APIs, native browser callbacks or installed
packaged connector behavior. Native OAuth warm/cold callbacks, refresh/revoke
under the final current/legacy identity, installed target coverage and
redistribution review remain open. Repository Actions are disabled; hosted
Verify/platform dispatch is unavailable pending the user's decision.

Local command results, source/resource digests, fixture/schema/Node versions,
failure repairs and remaining gaps are retained in the
[October 17 checkpoint evidence](evidence/issue-216-connector-checkpoint-local-20261017.json).
