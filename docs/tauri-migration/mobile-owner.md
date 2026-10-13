# Mobile API shutdown ownership

The existing mobile HTTP/WebSocket server now retains native listener startup,
WebSocket close and every raw HTTP route after public socket disconnect. Its
HTTP handler awaits the route rather than detaching it. Stopping closes
admission, terminates owned WebSockets, clears the advertised binding, and joins
native close and raw requests before another dependency set can replace them.
Startup calls coalesce to the actual port; cancelled startup cannot publish a
stale binding.

`closeMobileApiServer()` permanently closes registered/direct database sources,
joins retired servers and queued settings work, and refuses source revival.
The one-to-three-second deadline rejects without dropping raw ownership; retry
can join a held route through its final SQLite write. Queued settings
reconciliation checks closure before database reads or listener creation.
Application teardown closes admission before agents and includes this barrier
with the task API/source/connector drains before SQLite close.

The existing 47 mobile regressions run under standalone Node using portable
SQLite and cleanup after server drain. They retain pairing/session-token,
HTTP/WebSocket, task/source/feedback, access-settings and authorization behavior.
New controls cover actual WebSocket close, pending startup, failed-close/retry
with a disconnected late write, queued settings cancellation, invalid deadlines
and a directly started source after reusable stop. Controllers are fixtures;
no real mobile device, model call, public tunnel or production Tauri binding is
claimed. Mobile stays opt-in, and desktop speech-audio separation remains an
independent [#218](https://github.com/krazyjakee/21x/issues/218) /
[#219](https://github.com/krazyjakee/21x/issues/219) acceptance requirement.

[Local evidence](evidence/mobile-owner-local.json) records exact commands, source/
report hashes and full-suite results. The production bootstrap, pairing/native UI,
public tunnel lifecycle, complete process trees and installed device/recovery
acceptance remain open.

Final local rechecks passed 1,223 complete standalone/private-pipe cases with
zero skips in 83 files and 5,288 full application cases with 20 optional skips
in 379 files. Existing mobile and the first six lifetime controls passed 53
focused cases under each launcher; the additional direct-source regression
passed in both final full runs. Forced typecheck, changed-source lint, source/
contract freshness and desktop/mobile build passed within recorded scopes.
