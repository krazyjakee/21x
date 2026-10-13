# Connector shutdown ownership

The piece client and connector OAuth service expose bounded `close()` barriers.
They stop admission synchronously and retain raw asynchronous work after public
cancellation or a close deadline. An incomplete close rejects; it does not grant
permission to close the database beneath unfinished work.

The piece client joins credential reads, KV callbacks and actual worker exit.
The OAuth service joins refreshes and authorization-code flows, aborts token
requests, stops pending callback servers and rejects late token persistence or
revocation writes. Callback-server stop clears its timers and rejects pending
callbacks. Cancellation during localhost startup joins the close event before
the startup promise rejects, so the caller cannot open a browser after shutdown.

[Local evidence](evidence/connector-oauth-owner-local.json) records seven OAuth
lifetime controls, two added callback-server controls, the portable suite and
the full application suite. The existing fake Todoist proof still exercises the
pinned piece, loopback callbacks, refresh/revocation and encrypted/session token
storage. These controls use isolated fixtures and no real provider credentials.

Production teardown still uses `disposeConnectorRuntime`. Integration must first
stop admission at polling, manual sync and IPC entry points, join higher-level
bridge jobs, await both barriers, and retain resources when a deadline expires.
The callback HTTP server also needs an explicit close acknowledgement through
its owner. Packaged Node worker transport and external OAuth scheme integration
remain part of [#216](https://github.com/krazyjakee/21x/issues/216).
