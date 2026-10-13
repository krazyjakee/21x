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
packaged connector assets, resource containment and service runtime selection
remain to integrate. This control does not exercise a provider API.
