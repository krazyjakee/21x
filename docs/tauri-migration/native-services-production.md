# Production native URL and version services

This slice of the opt-in production host owns two existing desktop operations directly:
`shell:openExternal` and `app:getVersion`. They are separate from the Node
service registry. Both use the current native engine epoch and the existing
trusted main-window label/origin policy; an unavailable, stopping or replaced
engine cannot authorize a call. App version comes from Tauri package metadata.

The renderer facade permits the version read during durable recovery and fences
external opening until its registered rehydrator succeeds. This hydration fence
is a renderer availability guard, not a native authorization receipt. The native
host independently checks the fixed trusted main identity, current epoch and
live owner before admitting work, then rechecks lifecycle/origin immediately
before a blocking native launch. Payloads cannot select a program, file path,
profile, callback identity or capability. Later direct native clipboard reading
uses a distinct document receipt; see [clipboard image ownership](clipboard-image-bindings.md).

UI opening admits bounded HTTP(S) and mailto URLs. The reviewed service callback
`host.shell.openExternal` uses the same actual native owner with HTTP(S) only.
The opener is pinned to `tauri-plugin-opener = 2.5.4`, enabled only by the
production feature. Its injected link handler is disabled, and no direct opener
plugin IPC permission is granted. File open/reveal, dialogs, clipboard,
notifications, tray/login/energy services and arbitrary protocol handlers remain
outside this slice.

At most four native launch calls are admitted; additional work fails explicitly
instead of forming an unbounded queue. An independent owner task retains and
joins each blocking invocation even when its public response is cancelled or
times out. Shutdown fences new calls synchronously and waits for all accepted
native invocations before Node profile/store release and application exit; failed ownership/drain checks retain
the host. There is no automatic replay or manufactured cancellation receipt.

The pinned opener uses the OS default handler and returns a launch-handoff
acknowledgement. It does not prove a browser window opened, contain or own the
external browser, or acknowledge browser exit. Existing user browsers are never
killed by this owner. Once accepted, an external launch may be irreversible.

External OAuth browser flows remain explicitly unavailable: native URL opening
does not implement current/legacy deep-link registration or a correctly owned
OAuth callback receiver. No new app URL scheme registration is added here.
The later [private OAuth authority](native-oauth-authority.md) adds finite
register/open/retire leases and one-shot private delivery infrastructure. It
preserves that unavailable state until native ingress, approved identity and
provider consumers are integrated and proven.

Source tests cover finite URL/DTO policy, bounded admission, abandoned public
requests retaining raw work, failed/panicked native calls and shutdown fencing.
Installed behavior, actual OS default-handler behavior and all-platform
acceptance remain unproven; this implementation does not close the broader #215
gate or authorize a live release/profile cutover.
