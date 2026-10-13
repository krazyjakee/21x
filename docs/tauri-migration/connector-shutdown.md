# Connector shutdown ownership

The piece client, connector OAuth service and polling scheduler expose bounded `close()` barriers.
They stop admission synchronously and retain raw asynchronous work after public
cancellation or a close deadline. An incomplete close rejects; it does not grant
permission to close the database beneath unfinished work.

The piece client joins credential reads, KV callbacks and actual worker exit.
The OAuth service joins refreshes and authorization-code flows, aborts token
requests, stops pending callback servers and rejects late token persistence or
revocation writes. Callback-server stop clears its timers and rejects pending
callbacks. Cancellation during localhost startup joins the close event before
the startup promise rejects, so the caller cannot open a browser after shutdown.

The scheduler stops its interval, coalesces active passes and joins every source
callback. It retains already scheduled work even when a later source lookup
throws. [Polling evidence](evidence/connector-polling-owner-local.json) covers five
ownership controls and the existing bridge/Trello integration tests. `stop()`
remains a reusable scheduling pause; `close()` permanently stops admission.

[Local evidence](evidence/connector-oauth-owner-local.json) records seven OAuth
lifetime controls, two added callback-server controls, the portable suite and
the full application suite. The existing fake Todoist proof still exercises the
pinned piece, loopback callbacks, refresh/revocation and encrypted/session token
storage. These controls use isolated fixtures and no real provider credentials.

The Electron application teardown now stops source-sync admission, pauses polling
and cancels the connector runtime before stopping agents. It then joins source
sync, plugin and runtime close barriers before SQLite close. A failed drain keeps
SQLite/profile ownership until process exit and exits with failure. Runtime
disposal retains the original raw owners for a later join and refuses recreation.

The bridge engine joins active jobs and rejects queued imports/updates. The
plugin also joins previously paused polling and asynchronous post-sync callbacks.
`SyncManager` retains imports, exports, source actions, user listings and
reassignments through their final database writes. [Integrated local evidence](evidence/connector-source-shutdown-local.json)
records 109 source/connector cases, 548 standalone/private-pipe cases, and the
full application recheck. This integrates the existing Electron source path;
the Tauri production bootstrap and other domain/native lifecycle owners remain open.
The actual callback HTTP server now retains every listener until its close event,
including failed bind attempts. The OAuth flow joins that acknowledgement before
it can persist credentials or settle. [HTTP close evidence](evidence/connector-http-close-local.json)
covers a held acknowledgement, rebinding after close and a busy-port retry.
Packaged Node worker transport and external OAuth scheme integration
remain part of [#216](https://github.com/krazyjakee/21x/issues/216).

The [four-target service-only worker receipts](evidence/service-workers-four-target-scenarios.json)
at `b995a2f` passed the real bundled-Node IPC child control and all six startup/
transcript controls on Windows, macOS x64/arm64 and Linux. They remain service-only
proofs and precede the later OAuth lifetime changes.

`createNodeProcessTransport` now starts the connector host using the owning
standalone Node executable, with no inherited preloads or agent credentials.
It preserves structured messages and reports actual process close, including to
late exit listeners. The host entry supports Node IPC as well as utilityProcess,
keeps the existing allowlist/TLS guard, and exits if its Node parent disconnects.
[Local transport evidence](evidence/connector-node-transport-local.json) includes
the real compiled host loading pinned Trello and executing its local disable
hook with system Node hidden. The Electron runtime still selects utilityProcess;
the original transport control does not establish packaged-resource containment
or exercise a provider API.

The [four-target Node connector run](evidence/node-connector-four-target-scenarios.json)
passed all four child/compiled-host controls on macOS x64/arm64, Windows and Linux
at `a282c8c`. Each target passed 518 portable cases and all six startup/transcript
controls. These reports precede the staged-resource continuation.

The portable runtime core now receives its worker/native host explicitly, so it
can load under standalone Node without Electron imports. The legacy wrapper
supplies shell/utilityProcess. `tauri:prepare:native` separately installs the two
existing exact connector pins; `tauri:prepare:connectors` builds the worker and
records its bytes/package metadata. Staging rejects new dependency closures and
requires the staged entry bytes to match the frozen repository installation.

`createPackagedConnectorTransport` validates regular contained resources, package
pins, metadata/entry hashes and the exact owning Node binary before execution.
There is no repository or PATH fallback. The [staged proof](evidence/connector-staged-resources-local.json)
uses real standalone SQLite and session credentials with both pinned local hooks,
system Node hidden, and runtime close before database close. It passed 558
standalone/private-pipe cases, nine resource controls, four staging controls and
30 foundation cases. Platform workflows now require this separate staged proof.
No installed GUI acceptance, real provider API or external OAuth is claimed.
Redistribution review remains incomplete, including missing vendor notice files.
Tauri plugin/native host/bootstrap bindings remain to integrate.

The plugin implementation is now split similarly: `ConnectorBridgeCore` requires
an explicit runtime and imports no Electron host. The legacy plugin class supplies
its desktop default. [Portable plugin evidence](evidence/connector-portable-plugin-local.json)
extends the staged proof with a real portable database manager, engine ownership
and a configuration rejection before closing plugin/runtime/database in order.
Native source command bindings and production bootstrap integration remain open.

All 63 existing bridge/Trello/Todoist regressions now run under standalone Node,
using the existing portable database helper and injected secret-storage fixture.
They cover mapping/import/export, retry/cursor behavior, source state, local OAuth
callbacks, token refresh/revocation and redaction against fake providers. They use
an in-process transport and mock keychain; the staged real child remains separate.
[Regression evidence](evidence/connector-portable-api-regressions-local.json) records
622 standalone/private-pipe passes and the preserved 63 legacy-launcher passes.

The [initial staged matrix](evidence/connector-staged-platform-partial.json) passed
the actual staged hook proof on Windows and Linux at `4708dd0`. Both macOS targets
stopped in a fixture-path assertion before that phase. The fixture now uses
physical temporary paths and explicitly tests system ancestor aliases such as
macOS `/var` to `/private/var`. Package/link/escape checks remain required. This
matrix is retained as failed overall; the corrected retry is separate evidence.
