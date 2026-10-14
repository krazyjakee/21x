# Captured native notification bindings

This slice adds actual application-owned background AgentManager status
notifications to the production Source service. They are enabled only when the
immutable private launch descriptor has `capabilities.notifications: 'host'`.
An unsupported descriptor leaves `agents.notifications` unsupported and omits
`ProductionPrivateCallbacks.notifyStatus`. It does not infer a native grant
from a renderer, attached window, caller payload or successful model response.

The private callbacks are distinct: `host.notification.show` sends a general
notification; `host.notification.status` requests an inactive-window status
notification. Both accept exactly `{title, body}` and return exactly
`{shown: boolean}`. They are private host operations, not retained public
command names. Root's public notification and permission controls are separate
finite bindings. No Source callback, task action, URL, app name, icon or
caller-selected action crosses this boundary.

The staged bootstrap supplies the actual AgentManager notification host when
the capability is enabled: `isSupported()` returns true and `show({title,body})`
invokes the captured optional `notifyStatus` bridge. Source has no attached
AgentWindow. The native status callback independently queries actual current
main-window focus; generic notifications remain unconditional. Working-to-idle
and working-to-approval transition detection stays in the existing manager
path. This slice adds no second event writer, scheduler, session start,
completion inference or report-triggered model/voice turn.

Status text preserves existing short task wording: `Agent finished` with
`"<title>" is ready for review`, or `Agent needs approval` with
`"<title>" is waiting for your approval`. Missing task/title retains the
existing generic fallback. A completed parent's subtasks remain suppressed.
The helper now queries bounded scalar SQL instead of deserializing full task
and parent rows. It fetches at most 1,604 title bytes before JavaScript, safely
decodes malformed UTF8, normalizes controls, caps at 400 Unicode characters
and marks clipping with an ellipsis. The parent lookup returns only a completed
boolean and takes a bounded ASCII task ID. Unrelated huge JSON/private fields
and credentials are neither parsed nor projected. Stored bytes are unchanged.

Both private schemas reuse the canonical shared native notification validator:
nonempty title at most 160 UTF8 bytes, body at most 2,048 UTF8 bytes, no NUL or
malformed Unicode, and body-only tab/CR/LF support. The status helper's bounded
human title plus wording fits those limits. Diagnostics for optional helper
failure are fixed and omit task/provider/native errors.

Optional denial, unavailable service, rejected/malformed reply or deadline
failure never causes a Source peer disconnect or retries an uncertain native
effect. Notification request promises remain retained under the actual owner
cleanup registration. Concurrent raw acknowledgements block final owner/profile
drain, while shutdown suppresses new publications. Actual transport loss still
uses the existing ServicePeer disconnect and owner teardown; missing native
drain acknowledgement cannot be invented to release profile ownership.

On Linux the native author supplies async GIO session-bus discovery and
`GetNameOwner`, avoiding blocking GTK waits. Permission `granted` means the
captured notification server is available; it does not prove display, DND
state or user attention. Sending uses that exact unique server destination,
fixed `21x Preview` application identity, empty icon/hints, escaped bounded
text, a fixed `openapp` / `Open app` action and ten-second expiry. Click handling
checks captured epoch and reopens/focuses the trusted current main window.
There is no renderer or Source action-dispatch grant. Status-only inactive
suppression uses actual native main focus. The native owner bounds 64 IDs and
in-flight sends and two subscriptions, retaining raw work through its
five-second public deadline and shutdown. Non-Linux and absent server produce
explicit denied/false outcomes. These statements describe authored native
ownership; actual installed GUI/display/click behavior remains a gate.

Authored Source regressions use actual portable SQLite and the actual
production singleton/private ServicePeer pair with controlled native callback
receipts. They cover unsupported capability, sealed descriptor immutability,
actual AgentManager status routing, separate general/status operations,
optional denial/error/malformed/deadline response without service loss or
replay, and concurrent held raw drain/late-publication suppression. Helper
regressions cover exact short/fallback text, completed/incomplete/missing
parents, huge unrelated fields without full getters/JSON parse, UTF8/control
sanitization, focus/unsupported prechecks and retained Electron click behavior.
Browser-pure schemas reject arbitrary action fields and byte-bound mismatches.
Validation commands, results and source hashes are recorded in the batch
evidence; these fixtures do not exercise installed graphical notifications.

This is partial #202/#208/#212/#214/#215 progress. Real installed Linux GUI,
notification daemon/DND/display/click behavior, all supported OS families,
complete native window/tray/shortcut semantics and overall production cutover
remain open. Hosted voice remains deferred.

Raw GVariant replies and action signals are size-checked before Rust copies
server/action strings. The notification owner accepts close acknowledgement
only for its captured server/IDs, including the exact structured `InvalidId`,
`NameHasNoOwner` and `ServiceUnknown` errors that establish absence. Other
errors retain the owner for explicit cleanup retry. Cleanup runs under a
retained independent driver after ordinary work admission has closed, and it
joins both GIO reply captures and subscription retirement. A changed daemon is
reported unavailable rather than redirecting old notification authority.

The GTK/GIO layer receives OS data before Rust validates it. These bounds limit
Rust decoding and app payloads; they are not a hard memory cap inside the OS or
GIO transport. A notification accepted before a lost reply may remain visible;
uncertain sends are never repeated automatically.
