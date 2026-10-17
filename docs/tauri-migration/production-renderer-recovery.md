# Production renderer recovery

The opt-in production frontend already builds the real task/project/dashboard,
settings, Commander and canvas App through `desktopApi`. The October 13
foundation replaced the historical 368 direct preload references; current AST
inventory finds one production reader in `lib/desktop-api.ts`, used only by the
Electron compatibility host. Installing a native host supplies the typed
command/event codecs, transport and explicit unavailable behavior. These source
facts do not establish installed UI parity or retire shipping Electron.

Task, project and shared settings snapshot owners now coalesce reads. An event
or accepted local write crossing a read invalidates it; the owner re-reads rather
than overwriting a newer task update/create/delete or project change. There is
no growing event journal. Eight continuously crossed reads report backpressure
and retain the native recovery fence. Read failures participate in the same
fence; UI refresh wrappers still expose errors without unhandled rejections.
Only reads retry. Creates, updates, exports, approvals and provider operations
are not replayed by recovery.

Native reconnect disconnects the old client before awaiting bootstrap. A captured
renderer connection generation rejects publication into a replacement document,
including same-engine-epoch replacement. Task/project listener cohorts own their
unsubscribe functions and retire queued publications on pagehide/HMR. Project
listeners install before the first snapshot, instead of depending on a mounted
layout component. Independent existing shared listener leases retain their
normal reference counts.

Saved project selection restores as local render state. An explicit user
selection, including Default while a read is pending, wins. An archived selection
falls back locally without a settings write during hydration. Shared settings
now join the task/project/agent/Commander recovery barrier, so failed settings
reads cannot silently unlock writes. This covers shared organization/provider
preferences; it is not a claim that every settings tab has complete native UX.

Native canvas/drawing reads prefer their scoped project value. Only Default may
fall back to a pre-project global value, and only when no scoped value or prior
migration marker exists. Empty scoped data and markers prevent resurrection.
Recovery does not copy values or write migration markers. A later explicit edit
uses the existing scoped save operation. Electron retains its existing one-time
copy/marker policy. Retired browser/webpage records retain the existing inert
renderer policy; the recovery layer adds no creation or control operation.

The new controls execute the actual native renderer host, DesktopClient,
codecs, transport adapter and Zustand owners with a controlled native invoke/
event boundary and no preload calls. They exercise crossed task/project reads,
coalescing/backpressure, same-epoch replacement, settings failure/retry, project
selection, listener disposal and legacy layout fallback. Existing task search,
drag/drop, subtask, priority, project, layout, settings, transcript and retired
browser regressions remain part of the renderer gate. Controlled transport
responses are not a production Source database, an installed WebView or actual
OS dialog/input evidence.

[Revision-bound evidence](evidence/issue-209-renderer-recovery-local-20261017.json)
records commands, versions, hashes, failures and exact limits. Remaining renderer
work includes native attachment imports/drop receipts, native keyboard/window
controls, unsupported OAuth/updater/voice surfaces and complete settings parity.
Those operations require their domain owners' bindings; no fallback to raw file
paths or Electron preload is granted. Installed pending-reload/reconnect,
snapshot/delta and listener acceptance on supported native targets remains open.
Repository Actions is disabled pending the user's decision; no settings endpoint
or workflow dispatch is used. #209/#202 and migration gates remain open. No live
release/profile cutover, Electron retirement or hosted voice change is made.

## Native preferences and activity continuation

General preferences load each supported native value independently. An unavailable
login-at-startup operation no longer prevents notification permission or the tray
preference from loading. The native host reconnect observer re-reads once for each
connection generation and discards retired reads. Preference changes wait for the
actual receipt, show a fixed retry-boundary error on refusal, and do not replay.
Unmount disposes the observer. Captain prewarm remains unavailable in the native
preview. The existing notification-off toggle remains local UI state; this slice
does not introduce a persisted notification opt-out policy.

The always-mounted update dialog and General settings use the existing native
`app.getVersion` operation when updater version is unavailable. Native updater
controls remain explicitly unavailable and issue no check/download/install calls.
Version failures are caught. Electron retains its existing updater behavior and
regressions; no feed, updater implementation or distribution policy is selected.

Eight native preference/update React controls run through the actual typed host,
transport and codecs with no preload. Eight additional agent-store controls consume
#212's finite heartbeat/disconnect events through that same boundary. Freshness
updates leave session state, turn bookkeeping, transcripts and commands untouched.
Source sequence replay, foreign session heartbeats and malformed disconnect
metadata are refused; same-epoch reconnect, source-epoch replacement and document
disposal retire queued callbacks. These are controlled renderer tests rather than
installed OS notification, tray, updater or process-recovery acceptance.
