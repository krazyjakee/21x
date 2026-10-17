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

[Preferences/activity evidence](evidence/issue-209-native-preferences-activity-local-20261017.json) binds commands and results to the published implementation revision.

## Native file imports and inert browser surfaces

The native task attachment chooser keeps the retained `pick()` and
`save(taskId, path)` signatures. E2's private native selection owner holds the
actual file descriptor and binds a one-shot offer to the physical document;
returned paths are display data. The renderer does not turn DOM `File` paths or
drops into save authority. Task and transcript drops show chooser guidance and
perform no import. Draft files remain pending until the explicit task create
returns its accepted task ID.

Native imports run sequentially through the existing Source mutation lane.
Accepted partial file receipts are merged into explicit task metadata once; a
later save refusal stops the batch, shows a fixed error and does not replay.
Metadata persistence failure is explicit and uncertain copies/updates are not
repeated or destructively rolled back. After accepted task creation, attachment
failure opens the accepted task instead of leaving a form that repeats create.
Withdrawing create intent, replacing a task, reconnecting or unmounting fences
later effects/publications. Picker/save/metadata errors do not expose raw native
paths or diagnostics. These controls use actual UI owners, client/codecs and
transport with controlled native responses; E2's independent GTK/Source proofs
supply the private selection backend evidence.

Ordinary task mutation cannot append metadata to a `task_group` execution anchor
or Captain row. Their native file picker/import surfaces are therefore absent;
saved attachment reads/open/download remain retained. No member storage alias or
new group mutation is invented. An explicit domain attachment operation is still
needed for those file imports. The existing atomic chat-image path is unchanged.

Two additional controls install the actual native host with preload absent and
exercise the existing browser retirement policy: saved browser/webpage panels
render inert content without URLs, embedding, broker/control calls or creation
menu entries. Typed settings hydration and explicit viewport persistence preserve
dormant records and edges; new browser/webpage panels and browser edges are
refused. All generated browser operations retain `removed-browser`, `caller:none`
and `destination:none`. Four existing retirement controls remain in the gate.
This establishes the stated source/controlled-renderer criterion, while installed
native UI recovery and migration umbrella prerequisites remain open.

An accepted copy can remain protected but unreferenced after refused or uncertain
metadata completion. The UI does not silently reimport or delete that copy;
explicit domain reconciliation remains needed. This is a recorded cleanup limit,
not evidence of complete attachment/platform parity.

[Attachment UI and browser evidence](evidence/issue-209-native-attachment-ui-local-20261017.json)
records the full baseline, final affected checks, revisions and remaining defects.

## Agent collection and document-owned activity

Agent collection hydration now uses the same bounded snapshot owner as task and
project reads. Concurrent reads coalesce, accepted create/update/delete receipts
invalidate an older snapshot, and a retired document or connection cannot publish
its pending result. Recovery awaits the strict read result, so a failed agent
list does not release the native mutation fence. Continuous invalidation stops
after eight read attempts with backpressure; accepted writes are never replayed.

One document-owned status/transcript subscription cohort is released on pagehide
and hot replacement. Explicit reinitialization creates one replacement cohort.
The existing heartbeat/disconnect early return remains intact: activity renews
freshness without starting sessions, changing tasks or advancing turn state.
Transcript page and delta readers capture the document/connection generation;
a retired read cannot project artifacts, publish messages, or start another page.

The typed native-host activity regression now has eighteen controls, including
held snapshots across all three CRUD operations, strict recovery refusal/retry,
bounded invalidation, singleton listener replacement and held transcript page
retirement. The existing thirty-five agent-store controls also run in the staged
renderer suite. These are controlled native-boundary tests, not installed WebView
or real provider evidence. Native window lifecycle/platform proof remains open.

## Commander list, search and history ownership

Commander list reads now coalesce and retry a snapshot crossed by a changed
query, archive filter, accepted create/rename/archive, or session update. Search
results come from the service, which searches both titles and stored message
text; the renderer does not infer a content match from the title. The independent
report-inbox read keeps the inbox discoverable during a filtered search. Eight
continuously invalidated snapshots refuse recovery rather than looping forever.

Session/history readers capture the document and connection generation. Changing
selection, retiring the last event subscriber, pagehide or reconnect fences old
history before it can publish or mark a report read. Reconnect remains read-only:
it restores durable history and merges live messages/turns without selecting a
service session, clearing unread reports or starting a model turn. A finished
turn cannot be revived by a delayed history response, and a newer observed turn
survives that response or an older turn terminal. Drafts remain in renderer state.

Reference-counted event cohorts share one callback, retire queued callbacks on
release, and permit a fresh cohort without an old unsubscriber removing it. The
twenty Commander recovery controls now use the actual typed native host,
client, codec and transport with preload absent; their native responses are
controlled. Installed WebView/history, image and provider acceptance remains
separate and open. No native operation or voice capability was added.

## Native titlebar theme continuation

The titlebar hook now consumes the published exact native color contract. It
waits for ready connection plus successful durable hydration before painting,
then repaints once for a new theme or ready replacement connection. Only two
six-digit RGB computed custom properties reach native; no CSS expression,
selector or window identity is supplied. The typed transport supplies the
physical-document receipt. Duplicate connection notices do not repeat a paint.

Refused/unsupported operations keep the current chrome and are caught without
a retry loop. A late old result cannot trigger further work. Pagehide, unmount
and effect replacement release the connection observer and fence queued
callbacks. Electron keeps its existing CSS/color contract and catches both
synchronous and asynchronous bridge refusals; macOS leaves chrome to its native
owner. Sixteen controlled native/compatibility hook regressions exercise these
paths without preload. The actual isolated GTK symbol/header proof belongs to
E2's native-window source28343c43/evidence8c9c2038; these renderer tests do not
establish installed or non-Linux chrome parity.

## Active overview and task-group recovery

Durable native recovery now joins active overview/project-group lists and
retained group snapshots before admitting mutations. Unmounted caches cause no
reads. A replaced view cohort is joined in bounded recovery passes, rather than
letting an old view publish or lifting the fence ahead of its replacement. Read
failures keep recovery fenced and support explicit read-only retry. Accepted
group mutations invalidate snapshots without replay; follow-up reads stay in
the captured connection.

Overview preserves its existing debounce, thirty-second fallback poll and
heartbeat early return. One reference-counted cohort owns timers/listeners and
retires them on final release/pagehide/HMR. Group project sources and retained
snapshot readers have matching disposers; a queued read cannot run after
retirement or publish into a replacement. Thirteen additional actual typed-native
controls extend the collection recovery file to twenty-seven, including the
real native mutation fence and all three active read-failure paths.

The shared snapshot reader also distinguishes an in-flight read from a snapshot
being published: a synchronous refresh requested by publication starts a fresh
read, and a disposed queued reader refuses before its first RPC. The existing
overview/group regressions remain, with asynchronous reads fully joined before
asserting event-burst coalescing. No background owner, scheduler, native operation
or renderer mutation writer was introduced. Installed UI proof remains open.

## Bounded saved images in Markdown

Native Markdown consumes the published optional `attachments.readImage` operation
for literal `app-attachment://taskId/attachmentId` image references. Task IDs and
saved UUIDs are validated without URL decoding/normalization; paths, aliases,
query/fragment additions and extra segments never become requests. The actual
native codec supplies its physical-document receipt and validates the finite
PNG/JPEG/GIF/WebP response. The renderer reuses the shared container admission
before creating a typed blob URL. Native attachment hyperlinks are inert with
guidance to the existing attachment Open/Download controls. Electron retains its
existing scheme image/link behavior; no native raw scheme is registered.

One document-wide pool bounds public preview reads to four, queued requests to
64, resident previews to 16, resident encoded image bytes to 4 MiB and admitted
pixels to 16,777,216. Pixel accounting charges each canvas and every admitted
animation frame. Each image still has the backend's 512 KiB, 4096-edge,
8,388,608 canvas/frame-pixel and finite container/parser bounds. This bounds
renderer admission and owned resident URLs; it does not claim control over
implementation-dependent browser decoder caches. Actual WebView decode/runtime
acceptance remains separate. Budget test fixtures exercise container dimensions
and size, without claiming valid entropy decoding.

Intersection observation delays offscreen requests and releases URLs outside the
viewport. Component/connection generations fence late replies; cancelled queued
requests never invoke. In-flight public read slots remain occupied through public
settlement, while Source independently joins its raw FD reads and bounded queue.
Unmount/pagehide/HMR/reconnect and browser decode errors release owned URLs and
budget. Streamed surrounding Markdown preserves the image component. Capacity or
format failures show fixed unavailable guidance, with no raw path/scheme fallback
or automatic retry loop. A later visible/new connection/view is a fresh read.

Twenty-four actual typed-native React controls cover the consumer and shared
budget, including a reconnect regression that caught `readImage` missing from the
client's read-only recovery list. The additive classification now allows this
exact authorized read during hydration while mutation admission stays fenced.
Physical-document and Source task/project/group/agent read guards are unchanged.

## Skill and secret metadata recovery

Skills and secret metadata use the existing bounded snapshot reader. Accepted
create/update/delete/scope receipts invalidate held list reads; canonical rows
replace same-ID creates so an event/read preceding the receipt cannot duplicate
an entry. Writes and errors publish only into their captured document and
connection. Reconnect recovery joins only metadata caches previously requested or
populated by an accepted write, and never replays a mutation. Failed reads keep
native mutation recovery fenced until an explicit read-only retry.

One document-owned `skills:changed` subscription now also serves agent/task skill
selectors; it replaces the Skills-sidebar-only listener. The exact retained event
remains `{skillId, kind}` invalidation metadata. Source owns old/new project scope
filtering; the renderer requests no additional row or grant from the event.
Retirement/pagehide/HMR remove the listener and readers; old disposal cannot
retire a replacement cohort. The existing secret boundary returns metadata only:
this change never reads a secret value, adds credential storage, changes grants,
or starts OAuth/probe/network/sync work during recovery.

Twenty actual typed-native controls exercise accepted-write/list races,
pre-receipt canonical reads, first-write demand, scope-event invalidation,
eight-read backpressure, both failure barriers and retirement/replacement. The
existing fifteen skill-store controls are retained. These renderer controls do
not establish native credential-store or installed UI acceptance.


## Production project editor and overdue advisory

The native facade uses the published production project configuration codecs as
the final override for the same retained create/update operations. Full editor
agent, provider, limits, Captain wake-up and scheduled review fields now reach
the production lifecycle owner. Source retains the audited concurrency policy;
the renderer does not gain a second cap/pin writer.

Each save captures its editor lifetime and desktop connection, checks them before
every repository/resource effect and after each reply, and joins writes
sequentially. The form freezes during a save. Canonical project events refresh
the shared project list and live limit state without replacing unsaved drafts.
Closing and reopening even the same target retires the old save. Accepted global
project receipts cannot publish into a replacement connection or document cache.

Project saves are not atomic across the row, repositories and resources. If a
later step fails, the editor keeps any known accepted project identity, blocks a
repeat Save and offers an explicit reopen of that saved project. Reopening reads
canonical children for review; it does not recreate accepted children, roll back
other effects or replay an uncertain write. If creation itself has no accepted
receipt, no guessed identity/retry is supplied. The user must review the project
list after closing. There is no durable renderer mutation journal in this slice.

The retained `overdue:check` empty wire event maps to its no-argument typed
callback. Existing UI overdue notifications and snooze re-evaluation consume it
as an advisory only, without task/session mutations. Notification refusals are
owned and swallowed; queued effects, listener callbacks and local snooze timers
retire on pagehide/unmount. The real Source minute timer, read-scope filtering
and shutdown proofs belong to #210; these renderer controls use exact controlled
native receipts and prove no installed notification delivery or physical UI.
