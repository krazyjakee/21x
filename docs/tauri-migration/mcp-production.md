# Production MCP bindings

The experimental production service exposes ten exact desktop commands through
`McpBackend` and `MCP_CODECS`: list, create, update, delete, testConnection,
startOAuthFlow, getOAuthStatus, revokeOAuthToken, probeForAuth, and
submitManualClientId. These declarations do not establish installed native
transport, browser OAuth, or release parity for issue #213.

The backend borrows the actual DatabaseManager, AgentManager, OAuthManager,
McpProbeService, SyncManager and authenticated credential provider from ProductionOwner.
`assertMcpOwners` checks those identities; the registry separately checks native
caller origin/WebView and current engine epoch. Global configuration, server,
affected agent and project grants precede mutation. Exact executable/argv or
network endpoint and environment-name authority precede probing. Registration
is a finite command list and is not authorization.

Headers, environment values and OAuth registration client secrets use the
profile's authenticated encrypted format at rest. Their public DTO contains
`__21x_mcp_secret_set__` markers, including empty-value semantics. Update markers
preserve the corresponding existing value; markers cannot create credentials.
OAuth tokens never appear in desktop results. CRUD accepts reviewed fields only;
source, OAuth metadata and generic enable flags cannot be supplied. Source
provenance and per-agent tool filters remain owned by existing services.
Legacy plaintext credentials are not implicitly converted by native bootstrap.
Wrong credential formats, excessive SQL field/aggregate sizes and oversized
results reject while preserving the stored rows; pagination remains absent.

A saved-server edit/delete fences new probes, joins that server's accepted raw
probe receipts, then enters AgentManager's shared lifecycle mutation. That owner
fences starts/sends/queues, waits for actual session teardown, updates the DB and
refreshes each affected cached adapter once. Shared adapter users require their
own grants. Deletion refuses every linked task source to prevent the database cascade;
users remove those sources through their own controls first. Unlinked deletion
removes agent references and token rows. Linked-source updates/probes require
source/task/project grants, drain the actual SyncManager leases, and recheck
exact source/task references after asynchronous joins and before the DB effect. A failed refresh
or event delivery never retries the accepted mutation. Cancellation before the
DB effect prevents that write; cancellation afterward does not undo or replay it.
`tasks:refresh` is the existing invalidation event, not a second configuration
writer.

`McpProbeService.probeOwned` separates the bounded public result from `closed`,
which resolves only after child close or HTTP reader/body cleanup. The backend
retains those receipts after public timeout/cancellation. Successful tool-cache
updates join their own raw receipt before acquiring a mutation fence; stale
configuration results cannot update a replacement configuration. Unsaved probes
remain independently owned. Shutdown closes admission and joins raw work; a
failed drain requires the host to retain the database, credentials and process
owner and retry that join. Native probe children receive only the owner's
restricted environment plus explicitly granted server values; app task API
tokens are not exported. HTTP redirects are rejected by the native owner.
Errors are fixed messages without child diagnostics, URLs or credentials.

The app-managed task-management MCP and plugin-managed rows cannot be edited or
deleted through this user domain. Reserved browser/task server names cannot be
created or probed here. This domain does not register retired host browser tools.
An authorized user configuration remains storage only while `configuredMcp` is
disabled. Probes reject before child/network work in that state.

OAuth status and local token revocation use the actual OAuthManager even without
browser capability. Browser start/manual registration reject before discovery,
callback listener creation or navigation unless both configured MCP and the
actual native browser/callback owner are available. There is no notification or
successful callback substitute. The current staged native owner declares these
browser flows unavailable. Before enabling them, prove allowlisted discovery
and issuer endpoints, real native openExternal, loopback callback ownership,
PKCE/state verification, encrypted storage and shutdown/cancellation. Root must
close the borrowed OAuthManager concurrently with backend drain to stop callback
waits. A code path to an existing owner is not installed OAuth evidence.

## Validation scope

Authored tests use actual portable SQLite/schema/DatabaseManager, AgentManager
with controlled coding adapters, the authenticated encryption provider,
OAuthManager for stored status/revocation, and McpProbeService with controlled
child/network sources. They cover finite codecs, credential masking/encrypted
roundtrip, shared-owner Stop/refresh, scope denial, managed-row preservation,
restricted child environment, raw cancellation/close, per-server mutation races, linked-source cascade refusal and sync drains,
independent probes, late-tool rejection, failure latching and unavailable native
capabilities. Existing probe tests additionally contain real isolated Node and
loopback HTTP fixtures; these are not hosted SDK or native installed evidence.
The backend suite also authors an actual isolated process.execPath Node stdio
probe, skipped explicitly when process.execPath is Electron. It asserts encrypted
masked storage, absent provider/task API environment, tool-cache updates and real
child close. No tests or native proofs were executed by the implementation worker.

Coordinator checks should run the new service/shared suites and existing probe,
configuration, serializer, production-owner/transport and native contract suites,
then global typecheck/lint and the existing isolated production proofs. Installed
OAuth, supported-platform configured MCP child/network containment, live SDK
behaviour, OS callback execution and production cutover remain separate gates.
Hosted #92 remains deferred.
