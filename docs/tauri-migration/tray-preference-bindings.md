# Durable minimize-to-tray preference

This Source slice retains exactly `app:getMinimizeToTray() -> boolean` and
`app:setMinimizeToTray(enabled: boolean) -> boolean`. It uses the existing
`minimize_to_tray` setting and actual `DatabaseManager.setSetting`; setting
true stores exactly `"true"`, setting false stores exactly `"false"`, and the
setter returns the submitted boolean. Shipping app IPC emits no setting event
for these controls, so no event, native callback or alternate writer is added.
Preference mutation neither stops sessions nor drains/restarts admission.

The browser-pure `TRAY_PREFERENCE_CODECS` map exposes only the two finite
operations, an empty getter payload and exact `{enabled}` setter payload.
Strings, numbers, null, missing/extra keys, paths, actions, document stamps and
caller-provided authority refuse. Both operations use the legacy
`{defined: true, value: boolean}` result envelope; undefined/null/string results
are malformed.

`TrayPreferenceBackendOptions` requires actual `database` and `manager`
identities, captured `engineEpoch` and `trayAvailable`, `assertAvailable`,
`assertOwners({database,manager})`, `isTrustedDesktop` and
`canManageGlobalConfiguration(caller, 'read' | 'write')`. A true tray flag must
come from the actual host capability/owner lease at trusted construction. It
is never inferred from callback presence, a successful callback or public
input. Absent tray capability registers neither command. Source does not claim
tray behavior without the actual native integration.

Public reads and writes require trusted main-window origin/principal, current
engine epoch, a native-stamped document lease, current owner and the matching
read/write configuration grant. Private native ingress supplies and
validates the actual current document; a syntactically valid public string
cannot choose it. The backend freezes admitted caller metadata and rechecks
current grants/capability/owner before effect and before returning. Replacing
captured DB/manager/capability identities refuses. No public arbitrary setting
key or host action is accepted.

`getPreference(): boolean` is the separate app-owned native close lookup. It
checks the actual current Source owner and tray capability without fabricating
a renderer/document caller. Its SQL returns only a boolean scalar, reading at
most the exact four-byte value needed for comparison. Missing, empty, legacy
noncanonical text and nontext values mean false; only stored text exactly
`"true"` means true. Huge legacy values are never fetched through a full setting
or credential getter. Source does not enumerate settings or expose secrets.
Only this finite app-owned lookup enters the native close decision.

The backend retains up to sixteen admitted request promises and their abort
controllers. Cancellation/shutdown fences queued effects and close joins
admitted work before profile disposal. DB writes are synchronous actual
accepted effects: losing a grant after commit can reject publication but does
not roll back the durable preference, manufacture native actions or replay
that write. `shutdown()` and bounded `close()` fence future requests; the
borrowed manager and database remain owned by the enclosing production owner.

The Linux owner builds one native Tauri tray with fixed Open and Quit actions.
The retained public controls carry the actual native document lease through
`engine.tray.preferenceCommand`; Source checks a native UI snapshot before
dispatch, and native rechecks the document before delivering the result.
Hydration can read the preference while writes remain fenced. The separate
`engine.tray.preference` lookup accepts exactly an empty object and returns
exactly `{enabled: boolean}`. It grants no renderer-selected native action.

Native CloseRequested prevents default destruction and admits one decision at
a time. False selects the existing owned application shutdown path. True asks
the native owner to hide the same physical main window. Async GIO reads the
StatusNotifierWatcher's unique bus owner and registered-host property, then
rechecks the owner before hiding. Exact variant types and byte bounds precede
Rust string projection. Missing or changed host keeps the window visible and
focused with one owned nonblocking local message. A failed Source close lookup
selects normal application shutdown; it cannot strand a hidden service error.

Fixed Open and Quit are app-owned actions. They verify current physical main
ownership and native admission independently of Source health. Open shows and
focuses the app; Quit enters the existing ExitRequested drain. Neither accepts
content, paths, URLs or a generic action dispatcher. There is no per-session
stop merely because the main window hides.

Shutdown synchronously revokes native/UI effects, joins admitted close/menu/GIO
work, then removes and drops the owned tray/menu and retires dialog callbacks
on the GUI thread before Source profile disposal. Cleanup has an independent
driver after normal work admission closes. Its private icon directory has
exclusive creation and mode 0700. A held metadata-only descriptor captures the
actual icon file; cleanup checks its version before dependency Drop and refuses
known replacements or symlinks. Missing icon bytes can retire as absent, while
unrelated files prevent directory removal. The pinned tray library unlinks its
icon by pathname, so these preflights do not establish atomic protection from
a concurrent same-UID namespace replacement. The pinned Tauri API retains
global menu listeners with no unregister
operation, so one per-App reservation bounds a listener holding only a weak
owner reference. No new package versions or checksums are selected; the
production feature enables Tauri's already-locked tray dependency.

Authored tests use real portable SQLite, the actual DatabaseManager and actual
AgentManager owner identity. They cover exact persisted values, bounded scalar
reads with huge/legacy settings, no secret/full-settings getters, missing
capability, strict caller/epoch/document authority, separate read/write grants,
revocation/cancellation before DB effect, accepted-write preservation, immutable
owner/capability bindings, sixteen-request admission and joined shutdown.
Pure codec cases cover malformed arguments/results and private-field refusal.
Native tests also exercise exact GLib variant policy, real private directory
identity and retained raw callback/cleanup lifetime. Commands and final results
are recorded in the batch evidence; these fixtures do not prove panel visibility.

This is partial #202/#208/#212/#215 progress. Installed supported-platform tray,
window recreation/close/quit/background continuity and complete native desktop
parity remain open. Hosted voice remains deferred; this work authorizes no live
profile cutover or release.
