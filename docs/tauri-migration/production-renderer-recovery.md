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


## MCP and task-source catalog recovery

Demanded MCP configuration and task-source catalogs join the existing bounded
snapshot reader and strict native recovery. Accepted create/update/delete
receipts invalidate held lists and same-ID creates deduplicate. First accepted
writes mark the cache as demanded; unused caches issue no recovery request.
Pagehide/HMR retires each reader and captured document generation, so late writes
and read failures cannot publish into replacement cache ownership. Recovery
replays no sync, export, plugin action, process probe or browser sign-in.

An explicit sync captures its literal source ID, checks the returned identity,
and joins canonical task and source metadata reads after acknowledgement. It
uses the stored Source timestamp rather than manufacturing `last_synced_at` in
the renderer. Duplicate in-flight UI requests join one public sync promise.
Sync-all uses the retained mutation lane sequentially and withdraws remaining
starts when the captured connection or selected project changes. Accepted
remote work remains with the Source owner; these guards cannot undo an accepted
sync and do not claim raw remote-worker cancellation or a durable UI journal.

MCP process tests, OAuth status reads and authentication probes retain captured
connection/document and metadata revision checks. Status metadata reads are
sequential; failed status reads remain unknown rather than fabricated
disconnected values. Native settings mount/recovery reads configuration and
local status metadata only. A connection test requires its explicit control and
its UI result is fenced by the original server configuration and connection.
Connection retirement clears old success state. The Source test/process owner
and its grants remain unchanged. Shipping Electron keeps its existing initial
probe behavior.

The native remote form shows browser sign-in as unavailable and does not probe
a URL or start sign-in on open, edit or creation. This reflects the current
global native OAuth-browser capability; connector-specific loopback authority
does not grant MCP browser authority. Existing explicit credential revocation
and connection tests keep their separate retained operations. Native Drop
context/receipt work is independent and remains with #215/#214.


### MCP form save receipts and draft ownership

The actual MCP settings form now waits for its exact create/update receipt. Pending fields are frozen and duplicate submissions join no additional mutation. A missing or rejected receipt keeps the draft visible and requires closing it and reviewing canonical server metadata before another save; it never assumes that a lost reply means no write occurred. Cancel remains available and does not claim to cancel already admitted Source work. Accepted current CRUD clears a prior catalog error.

Each settings dialog has a monotonically increasing local intent and a fresh keyed component lifetime. Late saves cannot close or unlock a replacement draft, including reopening the same server. Canonical metadata refresh does not reset an unsaved edit. Connection replacement, pagehide and unmount fence publication and browser followups; native browser authorization remains unavailable. Existing Electron authorization is retained only under its originating view guard, and an optional authentication failure does not undo an accepted configuration write.

The portable controls use the real typed native facade and actual settings/form components with held synthetic receipts. They cover accepted create/update, missing/refused receipts, duplicate submit, canonical refresh, replacement draft, connection replacement, pagehide and accepted error clearing. Four corrected controls fail against the previous component source and pass after the repair. Initial test selectors were repaired to match the existing empty-state wording and distinguish the form submit button from key-value editor Add controls. These controls do not establish installed native UI or durable mutation-journal reconciliation; uncertain writes still require explicit review.


### Task-source configuration receipt and unavailable general OAuth

The real integrations settings page and source form now wait for exact accepted create/update receipts. Duplicate submission is fenced synchronously, pending fields freeze and uncertain writes retain the draft with explicit close/review before another save. Each dialog captures the current project and monotonic intent; a synchronous project change retires it even when selection returns to the same project before React renders. Old replies cannot close a replacement, and canonical metadata refresh preserves edits. Creating a source passes the captured project explicitly. Accepted current CRUD clears prior errors. Cancel does not claim to revoke already admitted Source work.

Plugin list/documentation reads capture document, selected plugin and connection; replacement/late replies are ignored, reconnect refreshes metadata once per generation, and pagehide/unmount releases observers. Explicit Sync uses the source store's single canonical readback without the settings page issuing a redundant task fetch. These controls do not start or replay remote synchronization during recovery.

Published Source has no public handlers for general `oauth:startFlow`, `oauth:startLocalhostFlow`, `oauth:exchangeCode`, `oauth:getValidToken` or `oauth:revokeToken`. Native HubSpot and Linear general integration sign-in therefore stays unavailable, including direct rendering of the general OAuth dialog. Mount/recovery does not ask for a bearer token or refresh it, does not install a public callback listener and does not manufacture connected/disconnected status. Native Linear redirect registration instructions are withheld until identity/OS authority exists. Existing explicit source synchronization remains Source-owned and may independently accept or refuse its configured credentials.

The separately proven `connectors:oauthConnect` instance/source/storage loopback path depends on enabled connector runtime and a sealed captured private OAuth owner. It grants no HubSpot/Linear general integration authority, global browser capability, custom-scheme registration or installed/provider acceptance. Shipping Electron retains its existing general OAuth path. Portable actual-component controls cover save/refusal/update/refresh/project replacement/reconnect, metadata selection races/pagehide, exact sync readback, both provider forms and direct unavailable OAuth dialogs. A seven-control old-source negative fails before the repair. Remaining installed native UI, durable mutation reconciliation, drop UI and attachment CAS/orphan acceptance stay open.


## Native file-drop receipt and attachment replacement intent

The renderer activates the optional two-phase native Drop protocol only when the
captured physical document is connected and hydrated. One document observer
selects exactly one visible, ordinary-task or new-task draft owner in the current
project. Hidden/background/modal-obscured, ambiguous, busy, over-capacity and
nonordinary views refuse the offer before acceptance. Browser DOM paths remain
inert. The native physical Drop owner and private Source selection receipts are
unchanged; a displayed pathname supplies no authority.

The UI claims the original receipt synchronously, waits for acceptance before any
file save, copies files sequentially and joins metadata acknowledgement before
closing the group. A new-task draft holds its accepted group through task creation
and import; removing its pending files or retiring its project/view/document
joins close instead. There are at most16 retained groups and128 attachment/pending
records per view. A stable acknowledged context survives title edits and a busy
create; connection, project change-and-return, modal replacement, navigation,
pagehide and unmount retire it. Refused cleanup is surfaced and remains retryable
through the facade; there is no automatic import or mutation replay.

Every explicit production full-array attachment update now passes the separate
published CAS precondition. Task/detail/composer imports clone all five canonical
fields in exact order before the first asynchronous save. A draft import uses the
accepted new task's original attachment receipt. Edit forms preserve their original
baseline and unsaved fields across canonical refresh; it is never replaced with a
fresh database read to authorize stale intent. Private draft fields are stripped
before public DTO submission. A refused or uncertain form save requires close and
canonical review; a late receipt cannot close a replacement dialog. Field-only
calls still use two arguments, and shipping Electron retains its existing path.

Portable actual-component controls use the real typed native facade with held
synthetic receipts, plus controlled viewport rectangles because happy-dom has no
layout engine. They do not establish installed physical drag delivery or a full
Wry-to-production-Source graph. Native/backend ownership and actual OS Drop proofs
remain separately revision-bound under #214/#215. The published Source CAS proof
covers accepted metadata replacement, not a durable copy/orphan journal. The old
native remove-then-replacement callsite remains a known gap in this slice; E2's
separate metadata-first exact-ID removal contract is agreed but unpublished here.
Its next renderer integration must eliminate the second full-array write and
reconcile canonical state even when post-unlink cleanup reports partial failure.
No filesystem/SQLite rollback or atomic-removal guarantee is made.


## Task hierarchy observation and mutation receipts

The real task workspace reads only the captured literal parent and validates its
returned identity/project before displaying navigation. View replacement, project
change-and-return, pagehide and connection retirement fence old replies. Parent
reads clear old navigation and rehydrate once per ready connection generation;
repeated notifications for the same generation issue no additional reads. Each
view releases its connection/project/DOM lifetime listeners.

Subtask creation keeps the entered title visible and frozen until the exact
accepted child receipt and canonical task snapshot settle. Reorder waits for a
true acknowledgement and canonical readback; it does not optimistically replace
order or treat a false receipt as success. One synchronous UI lane covers create
and reorder, and Source retains the actual task exclusion/scheduler authority.
The child receipt must retain the original parent/project. Retired views issue
no follow-up readback and cannot clear a replacement task's draft.

Missing/refused/uncertain replies retain the subtask draft and require reopening
the saved task for review before a new native mutation. There is no automatic
retry, rollback or assumption that a lost reply means no write occurred. Cancel
only retires the local draft; it does not claim to cancel admitted Source work.
Native Captain/shared-group rows expose no ordinary subtask mutation control.
Shipping Electron uses the same awaited UI callbacks with its existing contract.

The portable controls use the actual typed native facade, stores and workspace
components with controlled private results. Reorder tests invoke the real finite
UI handler through a controlled DndContext; physical keyboard/pointer dragging
and installed platform acceptance are not claimed. Two corrected old-source
controls reproduce parent-reply replacement and discarded pending-title defects.
No Source/native/public operation, policy, grant or voice availability changes.


## Canonical native attachment removal and draft review

The native UI consumes the metadata-first exact-ID `attachments.remove` semantics
published by #214 at8244c0ad. It invokes removal once, then joins read-only canonical
task snapshot reconciliation after either acknowledgement or raw cleanup refusal.
It never follows native removal with `db.updateTask`, a replacement attachment
array or automatic unlink replay. Source remains the metadata delta/filesystem
owner and emits its accepted canonical event before later cleanup can refuse.
Electron retains its existing remove plus explicit metadata update behavior.

If canonical state still references the target, is unavailable, or cleanup refused,
the UI shows fixed review guidance and blocks further attachment mutation in that
view. It never invents a successful removal or filesystem rollback. Read-only
Open/Download remain separate authorized operations. Closing/reopening the saved
task permits explicit review; reconnect does not replay removal. View replacement,
project/modal change-and-return, pagehide and connection replacement fence pending
readback/publication and release per-request subscriptions.

An edit draft preserves its unsaved text and original CAS baseline after a native
removal attempt. It applies only the confirmed removed ID locally and retains other known unsaved
import receipts until explicit draft close, without merging concurrent canonical
records or adopting a fresh baseline. It locks Save and requires close/canonical review before submitting other edits.
Admission fences synchronously before React paints disabled controls, including
an already queued native Drop delivered after raw readback. It never silently
adopts that new readback as a baseline to authorize a stale full-array intent. Native forms also fence idle or pending Save intent on
connection or project replacement, retaining the draft for explicit review.

The actual typed-native UI controls cover success, cleanup refusal, pre-unlink
refusal, missing/unchanged canonical state, readback failure, late view/readback
retirement and form review. These use controlled receipts; the separately executed
Source backend/CAS regressions use actual protected files/SQLite/AgentManager.
Only pre-unlink refusal can guarantee retained bytes. Raw unlink may already have
succeeded before later cancellation/verification failure, so no SQLite/filesystem
atomicity or manufactured rollback is claimed. Durable orphan/removal journaling,
unknown receipt recovery and installed supported-platform acceptance remain open.


### Awaited task metadata receipts

The TaskWorkspace fallback for title, description, lifecycle status and recurrence flags previously called `taskApi.update` and then the store's `updateTask`, which sends the same Source mutation a second time. These controls now use one awaited store call, or one supplied parent callback. The parent app/canvas callbacks reject a missing accepted task receipt. Native store writes validate the returned task ID and captured connection before publishing cache/error state or launching the existing background export.

Inline title and description editors keep their local text through pending replies and same-task canonical refreshes. A synchronous admission guard prevents Enter/blur, keyboard/button and submit/Escape races. Missing, foreign, refused or retired native receipts retain the draft and require the user to reopen and review the canonical task, without automatic retry or rollback. Status, recurrence flags, next-subtask choices and explicit skill-default changes own their asynchronous failures and use the same finite receipt guard; completion retains the existing feedback owner. Task replacement keys retire the old inline editors, and connection/project/pagehide retirement releases their listeners and fences late callbacks.

These are renderer consumers of the existing retained `db:updateTask` operation. They add no Source operation, grant or native availability. Attachment full-array CAS and exact-ID removal semantics remain unchanged. Triage/start/resume/agent assignment and other task actions have separate lifecycle owners; this metadata slice does not establish their complete installed receipt/recovery behavior. Controlled typed-native UI regressions are separate from installed WebView/platform acceptance, which remains blocked while repository Actions is disabled.

### Native manual session actions

Native Triage sends one awaited canonical status mutation before one explicit
session start. An uncertain start never rolls that accepted status back. Start,
Resume, Triage and assignment share a synchronous view-owned lane; task,
project, connection and pagehide retirement fence subsequent calls. An uncertain
reply locks that view for explicit canonical review instead of replaying it.
Unassignment joins a finite successful Stop before its field update. Handoff
uses the manager-owned switch and read-only task reconciliation, without a second
assignment write after success or failure. A known-ended Resume joins canonical
task reconciliation and never starts a fresh session automatically.

Start, Resume and Switch retain a local session identity across transcript and
status copies. Their pending cleanup cannot end a replacement request/session,
and an old connection reply cannot publish into the new connection. Stop also
checks its finite success receipt and exact current session before clearing local
state. Abort and approval refuse a finite false acknowledgement; approval still
requires the existing exact request ID and hydrated transcript authority.
Typed heartbeat/disconnect observations do not trigger AutoRun idle/triage work.
This change does not establish every delayed AutoRun or send/completion lifetime.

Native Fresh/Restart is explicitly unavailable before Stop, local session
removal or runtime-field writes. The retained Source task codec refuses renderer
`session_id` writes, and ordinary `startTask` has a selected-child policy that
cannot substitute for exact-root Fresh. A finite Source restart owner/contract
is separate #212 work. Electron retains its existing Fresh behavior.

The regression graph uses actual renderer hooks, stores, typed native codecs and
workspace controls with controlled native results. It proves local receipt and
listener behavior, not installed WebView input, provider effects or complete
crash recovery. No operation, grant, Source backend or native availability is
added. Installed supported-platform acceptance remains blocked while repository
Actions is disabled.

### Native message intent ownership

Plain native task messages use the retained Source `send`/`sendByTaskId` owner
directly. The renderer does not pre-start or resume a session before sending;
Source retains its established exact task/agent authorization, resume/create,
saved-file execution and durable intent nonce policy. Native answers require a
current live session and the exact current question/permission request ID/type.
Historical questions cannot resume or create a session just to receive an answer.
Source remains the final authorization owner for every prompt/decision.

An acknowledgement can precede its agent-status event. While that cache identity
is incomplete, the next explicit instruction continues through `sendByTaskId`;
the renderer neither invents an agent ID nor submits an invalid empty one.

One synchronous view lane covers messages alongside manual task actions. Retired
task/project/document/connection callbacks refuse before new effects. Unknown
results retain review state, preventing another send or a new nonce from that
view. View retirement cannot undo an already admitted raw prompt; the Source
delivery receipt remains durable. There is no renderer retry, merge, filesystem
fallback, accepted-copy rollback or substitute Fresh operation.

Send acknowledgements validate the captured connection and local send owner
before changing session identity or clearing a pending indicator. Actual
transcript/status copies preserve that ownership. Explicit session replacement
retires it, so a late result/failure cannot overwrite or clear a newer live or
pending session. Each task has one owned indicator timer; replacement, cleanup
and physical-document listener retirement cancel the old timer. A stale timeout
cannot clear the next send's indicator. These are local observations, never a
runtime Stop or Source delivery cancellation.

Native kickoff text remains visible through pending/unknown replies, and a reply
for a replaced task cannot clear its new draft. The real transcript composer
restores refused text while the workspace requires canonical review before
another send. Optional voice expectation housekeeping is invoked only when the
host declares the operation, and its asynchronous failure is owned. Native
voice remains unavailable; text sends do not invoke its unsupported operation.
Electron retains its existing send/start orchestration. Controlled renderer
results establish UI ownership; installed WebView/provider/platform acceptance
and the separate completion/CRUD lifetimes remain open.

### Native create, delete and project-move receipts

Task cache mutations capture their document cohort and connection before raw
work. A retired cohort cannot publish an old success/error or invalidate the
replacement snapshot. Native create checks the accepted parent/project identity;
move checks the exact root, destination and unique canonical rows before cache
publication. Existing typed Source events remain the canonical global updates;
a retired local view cannot undo accepted Source work.

Project moves use a synchronous view lane and await the retained manager-owned
subtree move. False/missing/foreign results require explicit reopen/review,
without optimistic order, retry or an extra Stop. Task/project replacement,
pagehide and reconnect fence selection/preview/toast followups. Native Captain
and shared-group rows expose no ordinary project-move picker.

Native task deletion uses one retained Source deletion operation. The renderer
does not first stop/remove a local session or start worktree cleanup. Its real
confirmation stays open through the raw receipt; duplicate clicks are fenced,
and a false/unknown result keeps fixed review wording. Same-kind replacement
dialogs have a distinct intent, so late acknowledgements cannot close them or
clear their canvas/preview state. Cancel retires UI followups and does not claim
to cancel admitted Source deletion. Workspace directories remain for separately
owned cleanup. Electron retains its established delete/cleanup orchestration.

These controls establish renderer receipt ownership, not atomic Source deletion
or filesystem authority. E2 separately reproduced DatabaseManager whole-task recursive attachment cleanup
deleting an outside synthetic canary after an attachment-root rename/symlink
(on3b215ebd/43016075). Current journal/CAS/exact-ID removal work does not certify
that path. E2's private Source retention policy (`956c5d07`, evidence `d928a12d`) now
retains protected directories and journal facts during logical task/subtree/source
deletion. A separately restaged integration run passed161 Source/compiled Root,
private-peer and native CRUD cases with zero skips (evidence
`issue-209-task-deletion-retention-integration-20261018.json`). This establishes
no recursive cleanup authority, atomic filesystem/SQLite deletion or reclaimed
space. Installed native input and platform acceptance remain open.


### Native completion receipts

Native completion captures the original task, project, agent, Source/external
binding, completion action and mounted view. One synchronous lane owns the
choice and raw operations through completion or review. A Source choice uses
that captured intent; it cannot be retargeted by replacing the observed task.
Project withdrawal and return, pagehide, unmount, view replacement and reconnect
fence later writes/actions/readback callbacks. Already admitted Source work
cannot be undone by disposing a view.

Manual completion requires the accepted canonical completed row. Source
completion requires its accepted local marker, finite successful action and
strict canonical completed readback. A refused or uncertain step publishes
fixed review wording without exposing private errors, manufacturing a completed
row, reverting an accepted marker or replaying the action. Closing review does
not readmit that same view's intent. Successful callbacks receive the canonical
row, including authoritative changes to its title. Native coordinator rows
cannot use ordinary completion.

Native board completion routes through this same completion owner. Other board
status moves require a canonical destination row from the existing lifecycle
owner; the renderer no longer performs an extra recovery read/Stop before that
owner's locked transition. Electron keeps its established completion and board
orchestration. This is not full board drag/view receipt acceptance or a new
exact-root Fresh operation. Feedback/learning submission, delayed AutoRun and
installed supported-platform interaction remain separate work.

Twenty-six actual typed-facade completion/board controls reproduce and repair
15 published-hook failures. The complete host-neutral renderer gate passed
2101/159files; affected UI/Source/staged/private-peer gate passed542/18files,
both with zero skips. The latter independently exercises actual production
feedback and protected task deletion owners; the new UI hook harness uses
controlled canonical task/action receipts and does not establish remote Source
mutation or installed UI delivery. Evidence:
`issue-209-native-task-completion-local-20261018.json`.
