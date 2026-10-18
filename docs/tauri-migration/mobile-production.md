# Production mobile control boundary

The production mobile binding borrows the application's installed mobile HTTP/
WebSocket owner, DatabaseManager, AgentManager, Git managers, SyncManager,
PluginRegistry and task schedulers. It does not start another task runtime or
database. `MobileApiDeps.mobileDistRoot` is a trusted, physical packaged SPA
directory supplied by the host. Without verified resources there is no mobile
binding. Electron retains its existing relative `out/mobile` fallback.

`MobileBackend` binds the ten existing preload controls and the two existing
pairing/device notifier payloads. Registration is separate from current trusted
WebView, origin, epoch, global configuration and paired-session grants. `getInfo`
creates a persisted single-use QR code, so it requires write permission and
hydration. Reading the pending PIN or subscribing to its event also requires
write permission: possession of PIN plus pairing ID can mint full-profile mobile
access. Device/session metadata requires read permission. No session token or
token hash leaves these desktop controls.

Mobile listening remains opt-in. Enabling mobile listens on IPv4 loopback;
`lanAccess: true` explicitly binds all IPv4 interfaces. Pairing codes expire after
five minutes, PINs after one minute, PIN attempts after three failures, and pairing
requests use the existing global 20-request/minute budget. Session credentials
are stored as SHA256 hashes. HTTP requests and WebSocket upgrades authenticate
against the same database. Requests recheck authentication after their body is
read; revocation terminates already admitted sockets immediately. Inactive
WebSocket credentials are checked every 30 seconds and before events without
touching `last_seen`; a real client ping counts as activity.

The paired mobile client retains the existing full-profile contract. This is
not a per-device project grant. Task/session starts use actual admission and
HITL uses the current live request owner. Mobile transcript reads use the durable
SQLite projection without seeding another transcript or creating a session.
Reconnect reads that projection; HTTP mutation retries have no new exactly-once
nonce contract and must not be replayed automatically. Native desktop reconnect
likewise does not replay accepted mobile configuration changes.

Production HTTP task create/update/order/completion delegates to the same
`TaskLifecycleBackend` used by desktop. Its private `ProductionMobileActions`
adapter borrows the one SQLite/AgentManager/SyncManager/scheduler graph; it
creates no runtime or storage owner. The HTTP server captures the paired token
and exact server owner after bounded body parsing. An owned manager request
scope rechecks that authority across awaits, raw Stop, source effects and
prewrite. Accepted scheduler work detaches only through the existing accepted
task-effects owner. Metadata and execution status edits cannot invent a second
state writer or bypass real admission. Canonical events publish once through the
root to desktop and authenticated mobile sinks.

Ordinary task resource/agent/skill references, learning and heartbeat changes now
use the desktop service's real validation and effects. Task completion delegates
to its actual local update or scoped source action; source refusal/withdrawal
cannot manufacture completion. Attachment replacement is explicitly refused
without a caller-supplied baseline; the adapter never reads the latest database
array to pretend it was the caller's original intent. Nonempty attachment create
and send remain unavailable. `attachments:save` stays metadata-only, and the
separate #214/#210 CAS contract is not bypassed.

Session/HITL routes use the same manager. Approval responses capture current
task/agent/session/request/type and require the real scoped method's `handled`
receipt. A stale or duplicate request returns conflict, rather than successful
HTTP after an unhandled legacy reply. Public task reads and events project only
declared fields; private MCP nonces/checklist storage never cross this boundary.
The broadcaster rejects speech/TTS names even when called directly, in addition
to the root's finite mobile event list.

Source name/enabled changes enter the real SyncManager mutation lease and recheck source/task bindings
and paired access after raw work drains. Source creation, credential/config/binding
changes, integration option resolution, grouped review and parent reassignment
remain explicit desktop-only effects on this mobile route. These are not
automatically enabled by the full-profile pairing contract. Nonempty attachment
sends also remain unavailable on this path. These refusals preserve existing stored data.
Legacy Electron routes retain their existing behavior.

Control results are finite schemas: up to 128 session rows, 64 KiB total output,
bounded HTTP(S) URLs without userinfo or secret query/fragment data, six-digit
PINs, and idle expiry from greater than zero to 365 days. Live pairing/device
capacity is 128. Portable HTTP rejects oversized stored rows before JSON parsing
and oversized responses, rather than truncating history. Its legacy unpaginated
routes therefore remain a capacity limitation. Provider sync errors become fixed
messages without exporting private configuration. Portable SPA assets reject
symlinks/escaping resources and files above 8 MiB. Oversized/backpressured socket
events disconnect the projection so it can rehydrate; omitted data never pretends
to be a complete live stream.

`TunnelManagerCore` needs a host-selected binary, private root, narrow environment
and actual child spawn owner. Each flight uses an isolated private empty config;
it never reads the user's default cloudflared ingress. A printed URL is insufficient:
an actual registered connection is also required. Concurrent starts share that
flight. Stop/cancellation/error/connection deadline withdraw the URL immediately
but retain process and stdout/stderr ownership until the child's `close` receipt.
No replacement child or config cleanup occurs on a public timeout. Shutdown can
fail and be retried while retaining the exact raw child. Native staging may supply
`tunnel: null`; quick tunnel then fails before effects, while a user-selected
custom URL stays available. The native host does not borrow Electron system paths
or download a binary implicitly.

The application must stop mobile admission and join raw HTTP routes, WebSocket
close, settings reconciliation and tunnel child closure before releasing agents,
SQLite or profile resources. `setMobileApiDeps` cannot replace an installed live
lease, including while disabled; final close marks its database source closed.

Authored tests exercise synthetic real SQLite, loopback HTTP/WebSockets, pairing,
revocation/expiry, actual AgentManager admission/HITL, durable projection reconnect,
source mutation joins, bounds, contained SPA resources and late provider writes.
Tunnel tests use controlled raw child/stream receipts. They are not installed
device, cloudflared-network, live SDK, process-tree, platform or release evidence.
Those #219 gates remain open. Hosted voice #92 remains deferred.


## Linux production continuation (#219)

The web client retains HTTP(S) same-origin reads and sockets, including explicit
ports, in production. Only Vite development uses the existing fixed server-port
override. Socket handlers capture their own connection; late close/error/message
callbacks cannot affect a replacement, and root unmount retires timers and the
visibility observer. No desktop bridge is imported by the web client.

The Source/staged regressions exercise the actual protected-profile production
owner, strict private peer, SQLite, task backend, session manager and schedulers
with real loopback HTTP/WebSocket clients. A controlled Pi process with isolated
HOME/PATH supplies permission/question/streaming receipts. A real protected
profile is closed and reopened; paired hashes and durable transcript identities
survive without blind provider replay. Native callbacks and key-store hardware
are synthetic boundaries. Controlled tunnel proof uses a real local Node child,
no public network, and verifies one process, private config, failed-close
retention and raw close before removal. Native production has no enabled quick
tunnel binary authority; no cloudflared/device/LAN or installed platform proof
is claimed. Hosted Verify is unavailable because repository Actions is disabled,
awaiting user decision; no settings changes or workflows are dispatched.

The focused inherited LAN-policy tests intercept only the requested all-interface
listen and bind their physical fixture sockets to loopback; they assert both the
requested policy and the actual loopback address. They do not establish LAN
exposure acceptance. An initial selected gate ran those pre-existing tests before
this boundary was added and briefly bound synthetic all-interface listeners;
that validation mistake is recorded in the revision evidence, and the repaired
gate is required. No live profile or public tunnel was involved.
