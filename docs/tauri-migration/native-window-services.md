# Native window state, chrome and focused controls

This #215/#214 continuation owns the native physical window and its local
controls. It adds no global voice shortcut, microphone grant, scheme identity,
login-item registration, renderer-selected window or general native dispatcher.

## Profile state and restoration

Native sends exact private `engine.windowState.load` and
`engine.windowState.save` requests to the existing Source singleton. The sealed
`windowState: host` launch capability requires the actual UI host. No public
operation routes these names. The store borrows the current database/profile
lease and owns only `__native_window_state_v1`, deliberately absent from the
production public settings list. It bounds persisted materialization to 1024
bytes; malformed/foreign state restores defaults without deleting or rewriting
it. Reads and writes recheck the same current profile owner.

The versioned record contains normal physical x/y/width/height, scale, maximized
and fullscreen flags. Hidden/minimized rectangles are not saved. Coordinates
are finite integers within +/-1,000,000; dimensions are 64..32768 physical
pixels; scale is 0.5..8. Restoration considers at most 32 monitor work areas,
selects the greatest saved intersection or primary monitor, preserves logical
size across DPI changes, clamps dimensions to the work area and recenters a
fully disconnected position. Negative secondary monitor positions are valid.
No Electron preference/profile file is mutated or silently migrated.

Native observations coalesce into one latest record plus at most one raw write.
The owner synchronously fences new observations on stop, then flushes captured
state before the Source engine may release its database/profile. A lost public
waiter cannot release the retained raw write. A close deadline blocks cleanup
until an explicit retry can join it. A completed persistence failure returns
`saved=false` to native shutdown and logs a fixed unavailable code; it does not
invent a saved receipt or prevent the independently-owned engine from shutting
down after the raw write has actually settled.

## Focused menus, keyboard and chrome

Native menus have a finite app-owned action table: undo/redo/cut/copy/paste/select
all, reload, zoom in/out/reset, fullscreen, minimize/maximize/restore, close,
show and quit. No callback, script, selector, path or action string comes from
the renderer. Queued native work rechecks admission and the captured physical
window. Focused actions require that window to hold focus. Show/quit remain
app-owned controls while Source is unavailable. Close uses the existing native
close/tray policy, and quit uses the existing owned shutdown path. An app-owned Quit request
remains available after a failed drain so that path can retry; it never reopens
ordinary native admission or bypasses the shutdown coordinator.

Linux editing menu clicks call exact WebKit editing commands. Editing keyboard
accelerators stay with the focused WebView/terminal so Ctrl+C and other terminal
input are not diverted to a global hook. Non-Linux editing menu items remain
disabled until their actual platform counterpart is implemented/proven. Zoom
uses half-level steps with the retained 1.2 exponent and range -8..9, resets once
on launch, and supports exact local menu accelerators plus shifted Ctrl+'+'.
A native reload invalidates the document receipt before dispatching reload.
Editing callbacks use a captured in-memory generation/physical-window ticket
inside WebKit, avoiding re-entry into Tauri’s locked WebView dispatcher.
There is no native renderer command replay after navigation or reconnect.

On Linux a native GTK header is constructed before realization while the window
is hidden; the physical document is attached only after its native handle
exists. An authorized window is never unrealized/recreated merely to change
chrome. The retained `app.setTitleBarOverlay({color,symbolColor})` operation
accepts only exact six-digit RGB strings and the current physical-document
lease. It has no arbitrary CSS or window-selector fields. The style cache holds
at most 64 weak references to the exact header/internal symbol widgets and
replaces its previous provider. Unsupported
platform/header services refuse the operation explicitly. A owns renderer hook
error handling and repaint after reconnect.

The capability, navigation, popup, download and WebView permission policy stays
restricted. New-window and WebView permission requests remain denied. This
window work does not arm voice permission or turn a cached browser decision
into microphone authority. Menus/keyboard hooks remain attached to the native
window lifetime, with synchronous owner/work fences preventing effects during
shutdown; raw accepted actions remain tracked independently of public waiters.

## Attachment follow-up

Metadata-only `attachments.save` now refuses nonordinary Captain/execution-anchor
roles before claiming any selection or reading bytes. Their retained
`db.updateTask` route cannot append file metadata, so the native picker must not
be exposed there without an explicit domain append operation. Existing literal
saved reads/open/download and atomic chat-image behavior remain supported.
Ordinary member rows still retain their literal storage and captured group
scope; no member is aliased to an execution anchor.

An accepted file copy is preserved if a later explicit metadata update fails or
its renderer disappears. Durable ownership/digest journaling and safe
unreferenced-copy reconciliation remain open; a filename pattern alone is not
unlink authority. Native drop receipts and attachment viewer URLs also remain
open and no DOM/raw-path fallback is granted.

## Evidence and remaining acceptance

Tests distinguish bounded monitor policy, real SQLite/private peer ownership,
raw write/cancel cleanup, typed native facade/transport controls and isolated
real Wry/GTK/Openbox behavior. The GUI fixture uses synthetic assets, the same
production CSP, temporary XDG roots and a private D-Bus/Xvfb session. WebKit may
auto-activate portal/keyring/accessibility services inside that isolated session;
no Source credential helper, provider, microphone or live profile is used.
Controlled GUI proof is not installed production Source-to-window acceptance,
multimonitor hardware evidence or supported-platform packaging acceptance.

Global shortcut registration, login items under the approved installed identity,
remaining attachment viewer/drop ownership and cross-platform native services
remain open. Final app identity/current+legacy scheme handling remains a user
decision. Hosted Verify is unavailable: repository Actions disabled
(actions/permissions enabled:false), awaiting user decision. No settings endpoint,
workflow dispatch, release, live profile cutover or Electron retirement is made.
