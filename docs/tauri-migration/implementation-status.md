# Migration implementation status

Updated 2026-10-14 with four-target installed diagnostic acceptance, the scheduler service matrix at `251685c`, hosted Verify at `aeb8951`, and local plugin manager ownership validation. **The shipping application still uses Electron, and G0–G5 remain open.** The [overall migration tracker, #193](https://github.com/krazyjakee/21x/issues/193), links nineteen open remaining-work issues (#205–#223); bounded diagnostic issue #204 is closed and #202 retains complete contract ownership. Completed scoped issues and successful fixtures establish the behavior they exercised; they do not establish a finished migration or authorize live cutover.

This page describes current work. Earlier batch notes and reports retain their original source revisions and limits; their former platform failures or unimplemented-agent statements are historical.

## Latest continuation

#209 native titlebar theme continuation: the renderer consumes the published exact RGB/current-document operation after successful durable hydration and repaints once per new theme or ready replacement connection. It catches unsupported/refused/late results without a retry loop, rejects non-RGB native computed tokens, and retires connection observers on pagehide/unmount/effect replacement. Electron keeps its color contract and macOS leaves chrome to its native owner. Sixteen actual typed-native/compatibility hook controls, full renderer1760/151files and staged427/22files pass; raw forced typecheck, lint0errors165baselinewarnings, both frontends and contract unit tests pass. The inventory records the captured host API call replacing the previous late-bound facade expression; retained operation policy is unchanged. [Renderer recovery](production-renderer-recovery.md) records scope; revision-bound evidence follows. Installed/non-Linux chrome and remaining global shortcut/login/voice/platform acceptance stay open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

#209 Commander renderer continuation: list reads coalesce and retry changed search/archive filters, accepted create/rename/archive receipts and session observations using authoritative Source title/body search. Document/connection/selection generations fence stale history before publication or report-read effects. Reference-counted cohorts dispose on last release/pagehide/HMR; late terminals cannot clear a newer turn. Recovery restores durable messages and live turns without selecting a service session, reading reports or sending a model turn. Twenty actual typed-native controls replace the five mocked recovery controls. Full renderer1740 and staged408 baseline passed; final affected51 app/20 staged, forced typecheck, lint0errors165baselinewarnings and both frontends pass. Rebase onto E2's native window source passes142 app/142 staged controls, raw forced typecheck/lint/both frontends and inventory905/contracts freshness. [Renderer recovery](production-renderer-recovery.md) records scope; revision-bound evidence follows. Installed/native platform acceptance and remaining retained operations remain open; hosted Verify unavailable: repository Actions disabled, awaiting user decision.

The #215/#214 native window continuation adds profile-owned private geometry
load/save, bounded monitor/DPI restoration, normal-bounds preservation across
maximize/fullscreen, finite focused menus/zoom/editing, and exact current-document
six-digit titlebar colors. Hidden startup records its physical document before
page completion; reload invalidates old tickets before dispatch. Raw writes and
native actions remain retained through waiter loss and are joined before Source
profile shutdown. Actual isolated Wry/GTK/Openbox regressions exercise menu
editing/zoom, symbol repaint, hide/reopen/reload, foreign-window and navigation
denial. Controlled fixtures do not establish installed Source/window or
multimonitor/platform acceptance. Nonordinary file imports now refuse before
selection claim because no retained metadata append exists for those roles.
Native viewer/drop, durable unreferenced-copy reconciliation, general global
shortcuts, login items and native voice permission/stream revocation remain
open. Final identity/schemes and hosted Actions await user decisions; no enablement
or release is made. See [native window services](native-window-services.md).

Renderer agent collection/document continuation (`8024737a`, #209): agent snapshots coalesce and retry bounded invalidation across accepted CRUD, stale document/connection reads cannot publish, and strict recovery keeps mutations fenced on failure. One status/transcript cohort disposes on pagehide/HMR; retired transcript reads cannot project artifacts or start another page. Existing heartbeat/disconnect early return preserved. Eighteen typed-native controls plus thirty-five legacy agent-store controls pass; full renderer1727/staged389, raw forced typecheck/lint0errors165baselinewarnings/both frontends pass. [Revision-bound evidence](evidence/issue-209-agent-collection-local-20261017.json) records exact commands and limits. Installed native lifecycle/platform proof and remaining retained operations stay open; hosted Verify unavailable: repository Actions disabled, awaiting user decision.

The #218 local voice continuation repairs actual synthesis-worker ownership:
system voice commands remain captured through buffered callback and native
close; cancellation, worker TERM and IPC disconnect join owned descendants,
including TERM refusal. Private request epochs prevent late same-speech-ID
messages from completing a replacement. PCM is emitted in ordered fragments of
at most 128 KiB with strict portable bounds. A finite optional Source voice lease
SDK adds exact turn/speech pairs, raw cleanup retention/retry, canonical audio
budgets and a real fragmented-peer revocation regression. The SDK is not wired
as a production capability: native microphone/capture/playback/shortcuts remain
unavailable pending #215 physical-document permission and raw stream-revocation
proof. Existing management controls remain governed by optional-runtime policy;
no voice action writer or hosted provider is enabled. Linux evidence uses only
synthetic audio and private fixture executables. Actual inference, hard-crash
process trees, production scoped actions, custom directory/native selection and
installed supported platforms remain open. Hosted Verify unavailable: repository
Actions disabled, awaiting user decision. See
[private voice authority](voice-native-authority.md) and
[speech ownership](voice-speech-owner.md).

#209 native attachment UI continuation: ordinary task/draft picker imports use E2’s published private one-shot selection contract with unchanged typed signatures. Native saves are sequential, explicit metadata append preserves accepted partial receipts, and failures/withdrawn intent/task replacement do not replay writes or target a replacement task. DOM drops stay non-authoritative and show chooser guidance. Nonordinary group/Captain file pickers are absent because no supported metadata mutation exists; saved reads remain, atomic chat images unchanged. Twenty-one actual typed-native attachment UI controls and two native browser-retirement controls pass, retaining four existing retirement controls. Full renderer1714/150files and staged341/19files baseline pass; final late-feedback delta73app/73staged, forced raw typecheck, lint0/165existingwarnings, both frontends and inventory900/736IPC/contracts pass. [Revision-bound evidence](evidence/issue-209-native-attachment-ui-local-20261017.json) records exact scope and failure repairs. Existing retirement source policy keeps saved browser/webpage records inert and new creation/control paths absent. No installed GUI/platform claim or #202 scope change.

The #215/#214 attachment continuation adds a Linux GTK picker whose private
selection receipts hold the original regular-file FD and physical document.
Public path strings only select an already-owned receipt. Source claims it once
under the exact task/project/group/agent scope, streams bounded chunks, verifies
bytes and namespace, joins native retirement and returns metadata without
appending task attachments. Reload/cancellation cannot release raw reads or
failed cleanup ownership early. The retained picker/save APIs and native typed
transport carry current document receipts; forged paths and late results do not
replay. See [native attachment selection](native-attachment-selection.md).
Controlled real GTK/Xvfb, FD, SQLite/private-peer and staged Node evidence is
separate from installed Wry/platform acceptance. Native drop receipts/viewer,
keyboard/focus and the remaining window/chrome/menu/shortcut/login services
remain open. No final identity/scheme choice, live profile or release is made.
Hosted Verify is unavailable: repository Actions disabled
(actions/permissions enabled:false), awaiting user decision.

#209 native general-preferences and activity continuation: supported notification/tray reads settle independently of unavailable login-at-startup; native reconnect re-reads each generation and ignores retired publications, and writes use accepted receipts without replay. The always-mounted update dialog and General settings read the existing native app version and show updater actions unavailable; no updater/feed policy was added. Eight actual typed-native React controls and eight agent-store heartbeat/disconnect/reconnect/disposal controls pass without preload, retaining the early return before session/turn/transcript transitions. Full renderer1681/staged258 baseline and final affected161app/126staged pass, raw forced typecheck and lint0errors/165existingwarnings pass, both full frontends build. [Domain and limits](production-renderer-recovery.md); [Revision-bound evidence](evidence/issue-209-native-preferences-activity-local-20261017.json) records the final source and limits. Notification-off remains local UI state; Captain prewarm remains native-disabled. Installed OS/UI acceptance and other209 criteria remain open; hosted Verify unavailable: repository Actions disabled, awaiting user decision.


The #209 renderer continuation makes task/project/settings recovery read-only
and preserves events crossing pending snapshots. Reads coalesce and retry a
bounded number of times; replacement bootstrap retires old reads immediately,
even when the engine epoch is unchanged. Failed/busy recovery keeps native
mutations fenced. Saved project restoration does not persist a selection, and
native canvas/drawing restoration reads legacy Default data without copying
settings or writing migration markers. Task/project listener cohorts retire on
pagehide/HMR. The historical 368 direct preload references were already reduced
to the central Electron compatibility reader by the production foundation;
this continuation repairs actual typed-client behavior. See
[renderer recovery](production-renderer-recovery.md). Native installed UI and
unsupported operation/platform acceptance remain open; Actions is disabled
pending the user's decision.

The #216 Source continuation binds connector loopback OAuth to the private native
flow owner captured at runtime construction. Only the connector binding gains
browser availability; global MCP/Linear OAuth stays unavailable. The actual
localhost listener, PKCE/state, token exchange and encrypted/session credential
intent remain Source-owned. Captured scope checks fence register/open/redemption
and prewrite; listener and per-flow retirement receipts retain raw work and
credential admission across cancellation or failed cleanup. A synchronous SDK
ownership observer also retains a lease when post-acknowledgement registration
fails; browser opening stays fenced until the receipt and scope check succeed.
Controlled SDK/HTTP-loopback/SQLite regressions and staged Node entry checks do
not establish installed browser callbacks or live provider authorization. See
[connector controls](connector-production.md) and
[private loopback evidence](evidence/issue-216-native-loopback-local-20261017.json).
#216 remains open for #208/#215 prerequisites, final identity/handler decisions,
representative provider and installed platform evidence, and redistribution
review. Hosted Verify is unavailable while Actions awaits the user's decision.

The #212 background continuation carries actual AgentManager poll freshness to
an owned portable desktop activity subscription without an Electron window.
Existing polling, five-second rate, epoch/sequence and retirement fences remain
in force. The private peer applies current read authority; periodic observations
bypass status-transition/mobile/voice fanout and leave tasks, project events,
admission and all six scheduler starts unchanged. Finite TypeScript and native
validators now agree on heartbeat/disconnect and terminal outcome metadata.
A real Pi adapter with a controlled child proves detach/regrant, one prompt,
queued admission and joined teardown. Existing #208 interrupted-profile
reconciliation remains the sole startup no-replay policy. This is Linux service
and native validator evidence, not installed WebView/window/crash acceptance.
#212 remains open for #208/#210 prerequisites, retained local voice starts
under #218, installed platforms and approved real-provider evidence. Hosted
Verify is unavailable: repository Actions disabled, awaiting user decision.
See [background activity ownership](production-background-activity.md) and
[local evidence](evidence/issue-212-background-activity-local-20261017.json).

The #208 Windows continuation adds an atomic kill-on-close Job and captured
private asynchronous pipe handles to the production launcher. The bounded
stdin descriptor prefix preserves pipelined RPC bytes; Linux retains fd3 and
its delegated-cgroup guardian. Both launchers share one owner initialization
and recovery path, with #215 native OAuth authority preserved. See
[Windows production containment](production-windows-containment.md).
Engine cross-compilation and a Linux inherited-stdin proof are not Windows
runtime acceptance. macOS containment remains unavailable; installed platform
proof and hosted Verify await hardware/runners and the Actions user decision.

The October 17 #211 agent continuation joins ACP/Codex/Pi raw child-close
receipts, retains failed-create native cleanup, and keeps Pi busy until an
actual abort settlement event. CLI discovery also works when a restricted PATH
contains an executable but no system lookup utility. Controlled protocol children under bundled Node
exercise native scoped permission/questions, tool failure, compaction observation,
manual recap switch, pending reload, quota fallback, synthetic secret injection
and acknowledged teardown with restricted PATH. All retained 14 session and two
agent-configuration commands were already production-bound. The explicit
five-backend account harness builds against staged SDKs; filesystem-only detection
ran without provider sessions. Live account/auth/model/HITL runs await user
approval; Cursor is absent, and installed platform acceptance remains pending.
Hosted Verify is unavailable because repository Actions is disabled, awaiting the
user's decision. #211 and G3 remain open. See
[agent lifecycle](production-agent-lifecycle.md) and
[local evidence](evidence/issue-211-agent-process-local-20261017.json).


The #215 OAuth continuation adds finite private register/open/retire leases,
a one-shot native state/URI authority, sanitized denial outcomes and a Source
lease owner. Private delivery acknowledges atomic Source claim before async
exchange; retirement joins raw native opening/delivery work. Linux now installs
a native-only single-instance session-bus handler before Source/profile startup,
using the configured identifier to derive a valid private bus name. Exact
callback argv, current/legacy scheme parsing and one-shot claims are exercised
through the actual plugin under an isolated session bus and Tauri MockRuntime.
Cold callbacks receive a fixed fresh-Connect diagnostic; lost PKCE/intent is
never reconstructed. Native retirement registers its notification waiter before
checking raw work, preventing a lost completion wakeup.
Retirement also reserves closed flow IDs so a delayed registration cannot
recreate a lease after its close acknowledgement.

The preview refuses custom-scheme registration and retains unavailable global
production `oauthBrowser`; no callback code/state becomes a renderer event.
The plugin's absent-session-bus startup fallback does not attest callback
availability. See the [agreed callback contract and identity decision](native-oauth-authority.md)
and [Linux ingress evidence](evidence/batch35-215-linux-callback-ingress.json).
Installed OS registration/routing, real provider credential consumers and
supported-platform acceptance remain open. The user must approve final app
identity and handler ownership; preview identifiers are unchanged. Hosted Verify
remains unavailable while repository Actions is disabled.

The #208 restart continuation reconciles old durable effect authority in one
SQLite transaction before production constructs APIs, adapters or schedulers.
Interrupted starts, unaccepted deliveries and provider retries require explicit
continuation. Backend/session IDs, receipts and saved output remain evidence;
recovery neither sends a backend prompt nor signals a saved PID. Affected task
and parent-chain automation pauses for review. See
[production restart reconciliation](production-restart-recovery.md).
Installed forced-crash and supported-platform runtime acceptance remain open;
hosted Verify is unavailable while Actions awaits the user decision.

The #208 startup continuation carries finite owner failure metadata through a
private read after failed initialization and the existing native status path.
Fixed renderer guidance distinguishes missing resources/CLI, unavailable store,
profile/database ownership or corruption, low disk and blocked cleanup. Real
SQLite busy refusal preserves rows and permits only a later explicit launch;
observing state never retries initialization. See
[startup recovery states](production-startup-recovery.md). Cross-target engine
checks are compile evidence only; Actions remains disabled pending user decision.

The October 17 connector continuation stages call-scoped KV edits until a
successful worker result. Import accepts that result inside one synchronous
SQLite transaction with task upserts, sync state and the worker checkpoint;
trigger initialization and its durable enable marker also commit together.
Failed, timed-out, cancelled and crashed calls discard their staged edits.
Node worker retirement escalates from SIGTERM to SIGKILL after 250 ms and still
requires the actual close acknowledgement before owner release.

See [production connector controls](connector-production.md) for the regression
scope and limitations. Native external OAuth remains unavailable, installed
representative-provider acceptance remains open, and hosted Verify is unavailable:
repository Actions disabled, awaiting user decision. No workflow is dispatched.
The public command/event surface and shipping Electron entry are unchanged.

The #213 production stdio continuation forwards both tool listing and every
retained tool call to the exact app-issued signed loopback MCP endpoint. It
does not substitute legacy environment/body pins or plain JSON routes. The
production entry excludes retired browser tools independently of the server's
advertised list. Accepted fetch/read/cancel work stays owned through timeout,
shutdown and failed-close retry. Production staging now selects this entry;
the legacy shipping entry remains separate.

The actual bundled standalone child proof uses empty PATH, the real task API
and synthetic SQLite/projects. It rejects forged scope and wrong tokens,
preserves project/artifact pins despite conflicting legacy environment fields,
and leaves an unrelated child alive after close. See
[task API ownership](task-api-owner.md) and
[stdio evidence](evidence/batch35-213-task-stdio.json). This is local bundled
integration evidence. Native OAuth (#215), prerequisites #208/#202 and installed
supported-target production acceptance remain open. Hosted Verify awaits the
user decision on repository Actions; no CI or issue closure is claimed.

The preceding terminal continuation retains its tested scope:


The #214 terminal continuation preserves logical recent text and escape-parser
state across PTY callbacks. Production buffer reads select a Unicode-safe recent
suffix within the existing encoded JSON limit, including long lines. Native PTY
subscriptions retire only at actual exit, before the core releases ownership.
Live output, six terminal commands, process identities and shell policy retain
their existing contracts. See [streaming terminal recovery](terminal-streaming-recovery.md).
Installed keyboard/focus and supported-OS production lifecycle acceptance remain
open; non-Linux production launch still requires #208 containment work. Hosted
Verify is unavailable while repository Actions is disabled, awaiting user decision.

The #213 continuation completes bounded Streamable HTTP MCP probe replies for
JSON and SSE. A successful non-JSON HTTP response alone no longer counts as a
connected server. SSE initialization and tools discovery require the matching
RPC response, own reader cancellation through acknowledgement, and recheck
current configuration/server/task/environment/transport authority between
protocol effects. Existing saved tools survive rejected probes. Verify now
watches `master` as well as `main`; hosted execution awaits the user decision
on enabling repository Actions.

See [MCP probe ownership](mcp-probe-owner.md) and the
[batch35 evidence](evidence/batch35-213-mcp-sse.json) for commands, revisions,
results and limits. Legacy HTTP+SSE endpoint fallback and native OAuth are not
implemented by this continuation. Native warm/cold callbacks still depend on
#215 and remain unavailable; installed production integrations, prerequisites
#208/#202 and complete G3 acceptance remain open.


The preceding energy continuation retains its tested revision:

The energy continuation connects the existing Manager session aggregate to a
captured optional Linux suspend-inhibition owner. Source tickets describe
intent; only the native portal acknowledgement describes an applied grant.
The existing private sleep callback carries exact boolean state. Native owns
its request and private session-bus connection, and cleanup can cancel pending
portal interaction after ordinary admission closes. Missing/refused inhibition
remains optional while durable work continues.

The public surface remains 228 service commands, six direct native commands
and 30 events. See [native energy ownership](native-energy-bindings.md).
Installed permission, suspend and crash behavior and other platforms remain
acceptance gates. Hosted voice stays deferred; Electron remains the shipping
application.

The preceding tray continuation retains its tested revision:

The tray continuation restores the durable close-to-tray preference through
the actual Source database owner and adds fixed native Open/Quit actions on
Linux. Close reads the preference independently of renderer document state;
public preference controls require the current document. Before hiding, native
checks a registered StatusNotifier host and its captured unique identity. An
unavailable host leaves the main window visible with a fixed local message.
Open and Quit remain app-owned when Source fails. Shutdown fences actions and
joins tray/menu/dialog retirement before Source profile release.

The finite surface has 228 service commands, six direct native commands and
30 events. See [tray preference ownership](tray-preference-bindings.md).
Building an icon and checking a registered host do not prove panel visibility.
Installed tray/menu/close behavior, other platforms and G0–G5 acceptance remain
open. Hosted voice remains deferred; Electron remains the shipping app.

The preceding notification continuation retains its tested revision:

The notification continuation restores local Linux OS alerts through an owned
session-bus connection and captured notification server. Agent status alerts
check the actual main window's focus; optional refusal does not stop durable
work. Fixed click actions reopen the current trusted app window. Direct display
and permission routes require current document authority. Native callbacks,
notification IDs and subscriptions drain before owner release.

The finite surface has 226 service commands, six direct native commands and
30 events. See [native notification ownership](native-notification-bindings.md).
Permission results describe server availability; they do not prove visible
presentation under do-not-disturb settings. Installed notifications, clicks,
other platforms and full migration acceptance remain open. Hosted voice stays
deferred; Electron remains the shipping application.

The preceding artifact clipboard continuation retains its tested revision:

The artifact clipboard continuation binds the retained Copy file action to a
Linux file URI clipboard owner. Source holds the authorized regular-file FD
through actual handoff. A separate private capability and current physical
document are required, and native checks the original live read scope before
publication. Missing files or capability return unavailable. Shutdown clears
only the app's own clipboard offer and waits for its real callback retirement.

The finite surface has 226 service commands, three direct native commands and
30 events. See [artifact clipboard ownership](artifact-clipboard-bindings.md).
Later external paste depends on the referenced file remaining available.
Installed GTK/file-manager acceptance and other platforms remain open. Hosted
voice remains deferred; Electron is still the shipping application.

The preceding download continuation retains its tested revision:

The download continuation binds saved attachment IDs to a native Linux Save
dialog and descriptor-owned file copying. Its independent private capability
requires current document authority. Read-only task/group/agent scopes keep live
agents running; the Source service retains its attachment FD and sends metadata
only. Native copying checks the pinned source, destination directory and current
document around effects, then publishes a new file without replacing an existing
destination. Cancel retains the existing void result and claims no save.

The finite surface has 225 service commands, three direct native commands and
30 events. See [attachment download ownership](attachment-download-bindings.md).
Installed GTK interaction, unsupported target filesystems, other platforms and
complete migration gates remain open. Hosted voice remains deferred; Electron
is still the shipping application.

The preceding clipboard continuation retains its tested revision:

The clipboard continuation adds document-bound native PNG reading for Linux.
GTK target and content callbacks stay owned through their actual completion;
empty and text clipboards return no images, while copied-file offers return a
fixed message without reading paths. Native byte bounds and a strict renderer
codec limit each result to one PNG of at most 512 KiB. Reload and hydration fence
delivery and prevent replay.

The finite surface has 224 service commands, three direct native commands and
30 events. See [clipboard image ownership](clipboard-image-bindings.md).
Copied-file import, other formats/platforms, installed graphical clipboard
acceptance and complete migration gates remain open. Hosted voice remains
deferred; the shipping application still uses Electron.

The preceding attachment continuation retains its tested revision:

The attachment opening continuation resolves the exact saved file through the
production task/group scope and a separate native attachment-root descriptor.
Read grants suffice while the task agent is active. The service retains its
file descriptor through native acknowledgement; current document, root, task,
file and metadata bindings are rechecked before and after effects. Namespace
deletion and profile release remain fenced by raw file/callback ownership.

The finite surface has 224 service commands, two direct native commands and
30 events. See [attachment opening](attachment-opening-bindings.md).
Linux native callbacks use the existing pinned system opener. Installed OS
launch, other platform file authority, pick/save/download/viewer workflows and
complete migration acceptance remain open. Hosted voice remains deferred.

The preceding installation continuation retains its tested revision:

The installation continuation adds five fixed, profile-owned npm CLI plans using
selected standalone Node and a captured npm entry. Actual package metadata,
physical executable receipts and detection must agree before success. Backend
installation borrows admission/configuration ownership and retains a failure
fence after partial writes. Fixed progress receipts target the native document
that requested the work; reload cannot redirect them to a replacement window.

The finite surface has 223 service commands, two direct native commands and
30 events. See [installation ownership](agent-installation-bindings.md) and
the [verification record](evidence/issue-closing-20261014-agent-installation.json).
Windows execution, unsupported system-tool plans, external Pi configuration
conversion and live vendor installation remain open. The shipping application
still uses Electron; hosted voice remains deferred by user decision.

The preceding UI continuation retains its tested revision:

The UI continuation binds passive state publication and the seven retained UI
intents to the actual production service and native main document. Physical
window attachment, document generation, engine epoch and visibility gate each
publication and native delivery. Reload/destruction revokes old receipts;
missing or hidden windows report unavailable while application services continue.
The renderer stamps native bootstrap authority separately from state arguments
and rejects retired document events. Task API responses distinguish accepted
transport from renderer application and enforce signed task/project scope.

The finite surface now has 222 service commands, two direct native commands and
29 events. See [UI ownership](ui-state-bindings.md) and the
[verification record](evidence/issue-closing-20261014-ui-state.json). Actual installed
production UI interaction, platform controls, all-platform acceptance and the
remaining migration work are still open. Hosted voice remains deferred.

The preceding CLI/attachment continuation retains its tested revision:

The CLI/attachment continuation binds six CLI MCP configuration controls and
two task image/file controls to the captured production owners. Constructor
paths and environment references stay outside RPC. Bounded descriptor reads,
verified publication receipts and exact configuration fingerprints preserve
external edits; comments and unrelated settings survive supported edits. CLI
mutations borrow the real manager's admission/configuration lease and refuse
while the affected runtime is in use. Probe authority is rechecked before each
protocol effect; actual child and HTTP cleanup remains owned through closure.

Task image publication uses the captured attachment root and ordinary task
metadata/event flow. Failed writes roll back only proven owned bytes. Accepted
metadata and files survive later caller loss. Exact descriptor-close failures
retain the profile until cleanup succeeds. The finite surface now has 221 service
commands, two direct native commands and 28 events. Installed native UI, arbitrary
file pickers/viewers, live providers, all-platform and complete migration
acceptance remain open. Hosted voice remains deferred by user decision. See
[CLI bindings](cli-mcp-bindings.md), [attachment bindings](task-attachment-bindings.md)
and the [verification record](evidence/issue-closing-20261014-cli-attachments.json).

The preceding heartbeat/worktree continuation retains its tested revision:

The heartbeat/worktree continuation binds eight heartbeat controls and six
worktree/cleanup controls to the captured production owners. Heartbeat files use
fixed physical workspace identities and retained descriptors; admitted checks
continue under application ownership after the requesting call ends. Immutable
task/resource bindings fence reassignment during monitoring and forwarding.
Periodic preflight uses the captured, bounded GitHub CLI owner.

Worktree mutations borrow the actual task/source lifecycle leases. File previews
use retained descriptor reads, binary detection and explicit truncation at the
portable 128 KiB cap. The exact untracked-file diff command accepts Git's normal
exit-one receipt without forwarding diagnostics. Acknowledged physical cleanup
retires only its matching file/process directory identities.

Manual and automatic portable cleanup share a bounded planner. Empty passes
return actual zero counts. Removing completed workspaces requires a captured
process-observation authority, which production does not yet have; that work is
explicitly unavailable before removal. Orphan deletion and dependency pruning
also remain unavailable. The finite surface has 213 service commands, two direct
native commands and 28 events. The shipping application remains Electron; installed
native, live-provider, full background and migration acceptance remain open.
Hosted voice remains deferred by user decision. See
[heartbeat bindings](heartbeat-bindings.md) and
[worktree bindings](worktree-runtime-bindings.md) and the
[verification record](evidence/issue-closing-20261014-heartbeat-worktrees.json).

The preceding project/group continuation retains its tested revision:

The project/group continuation binds nine retained task-group controls and ten
project status, history, Captain memory, limits and concurrency controls to their
actual protected-profile owners. Narrow bounded scalar projections reuse the
existing live admission/status algorithms; group source completion, starts and
review feedback retain raw work and recheck caller authority through nested
worktree, configuration, credential-refresh and provider boundaries. Background
work and accepted cleanup use explicit manager ownership rather than inherited
completed-request authority.

Captain memory reads a real bounded descriptor-backed prefix with an explicit
truncation flag. Finite history limits retain the existing floor/clamp semantics.
Global pause and overview require all relevant current grants, and user pin/control
writes use the actual manager's audit and queue scheduling. The finite surface has
199 service commands, two separate direct native commands and 23 events. Existing
Electron behavior remains the default for unscoped core callers. Installed native
UI, provider/platform and full migration acceptance remain open. See
[project runtime bindings](project-runtime-bindings.md),
[task group bindings](task-group-bindings.md) and
[request authority](task-group-request-authority.md).

The preceding workspace-file continuation retains its tested revision:

The workspace-file continuation binds four existing task workspace, text preview,
open and reveal controls to the actual protected-profile owner. Task/project/group
and repository/session scopes are shared with artifact reads and rechecked through
raw I/O and native acknowledgement. Exact file-close failures retain the descriptor
and block profile release. Trusted worktree cleanup retires only the captured
directory identity, so later workspace creation remains usable.

The Linux native callback borrows metadata-only, directory-relative no-follow
handles from its own trusted workspace root and rechecks every captured identity
before using the existing pinned opener. Callback drain closes the native root
handles before acknowledging Node's profile release. Other platforms and older
artifacts without the optional capability report unavailability. The current
surface has 180 service commands, two separate direct native commands, and 23
events. File pickers, arbitrary path grants, attachments/viewers and installed
all-platform acceptance remain open. See [workspace ownership](workspace-file-owner.md),
[bindings](workspace-file-bindings.md) and
[native authority](workspace-native-file-authority.md).

The preceding repository-control continuation retains its tested revision:

The repository-control continuation shares one captured CLI process owner across
the actual GitHub, GitLab and Forgejo managers, task sources and worktrees. It adds
fifteen retained provider discovery, login selection and repository-map controls.
Accepted commands retain their raw callbacks and child/stream close receipts;
shutdown holds the protected profile until these finish. Worktree paths are checked
against captured directory identities before commands and fallback removals.
The current surface has 176 finite service commands, two separate native commands
and 23 events. See [provider ownership](git-provider-owner.md),
[bindings](git-provider-bindings.md) and
[native contracts](git-provider-native-contracts.md).
CLI installation, native authentication flows and installed cross-platform
acceptance remain open. This continuation does not complete #202, #208 or #213.

The previous local-model continuation retains its tested revision:

The next local model continuation adds authenticated synthesis publication
receipts using the production profile's existing protected key. Committed
receipts survive an owner restart and authorize removal only when the exact
model, roots, file identities and hashes still match. Prepared, retiring,
tampered, historical and changed trees remain protected. Recognition downloads
follow a finite publisher/CDN policy tied to the pinned catalogue revision and
resource metadata; every final file still requires its exact catalogue size
and checksum. These changes add no native or hosted voice capability.
The retained contract surface remains 161 service commands, two separate native
commands and 23 events. See the
[model continuation evidence](evidence/issue-closing-20261014-local-model-receipts.json)
for tested source, artifact and scope limits.

The local voice continuation adds actual portable recognition, speech, model
and optional-runtime owners, plus 21 finite management commands and four
desktop-only management events. Both existing isolated worker scripts join the
verified resource closure and use the selected standalone Node runtime. Older
artifacts without the complete worker pair keep voice management unavailable.
Model publication and deletion retain raw download/file work and current
management grants; service teardown retains the profile until voice owners
acknowledge shutdown. Electron also awaits this drain before database teardown.

This batch keeps native microphone capture, permission requests, playback,
global shortcuts, command actions and arbitrary model-directory grants
unavailable. The portable runtime installer refuses before npm or filesystem
effects until its pinned acquisition manifest and installation inventory are
reviewed. Hosted voice #92 remains deferred by the user. These scoped owners and
management controls do not establish complete #218 or installed voice parity.
See [recognition ownership](voice-recognition-owner.md),
[speech ownership](voice-speech-owner.md),
[management bindings](voice-management-bindings.md) and
[batch evidence](evidence/issue-closing-20261014-local-voice-ownership.json).

The next October 14 local continuation adds actual portable installed-CLI detection
and retained task artifact scan/read services, plus two direct native host routes
for system URL opening and the actual native package version. There are 140
finite service command contracts, two separate native service commands and 19
events. Detection retains raw child/stream/file work under captured host paths
and a finite environment; installer execution stays unavailable. Artifact reads
retain the requested task workspace and exact current task/group/repository
bindings, with bounded no-follow file reads and explicit preview capacity errors.
Tauri HTML previews show an unavailable state until the separate native viewer is
bound; the main-window iframe does not activate HTML content.

The production preview uses the pinned native opener without direct plugin IPC
grants or injected link handlers. Native launch invocations drain before Node
profile release and application exit; the externally launched browser has its
own lifetime. OAuth flows remain unavailable until the native callback receiver
and scheme registration are implemented. See [CLI detection](agent-installer-production.md),
[artifact services](artifact-production.md), [native services](native-services-production.md)
and [batch evidence](evidence/issue-closing-20261014-cli-artifact-native-services.json).
Full native/retained-viewer/installer and installed platform criteria remain open.

The preceding mobile and record-credential batch retains its tested revision:

The October 14 mobile and credential continuation connects ten mobile controls
and two notifier events to the actual optional production HTTP/WebSocket owner.
There are 137 finite production command contracts and 19 events. New private
staging includes the mobile web build and verifies its entire resource closure;
older artifacts without that reviewed entry keep mobile controls unavailable.
Mobile access and LAN exposure remain opt-in. Pairing, hashed sessions, revocation,
projection and task/session control share the actual database, agents and task
schedulers; PIN reads require management write authority. Native quick tunnels
remain unavailable until a binary is explicitly staged, while the portable
process owner retains raw child close and configuration ownership.

The copied-profile credential rehearsal now converts every currently protected
JSON field with explicit leaf provenance, exact noncredential representation
preservation and authenticated recovery. It uses the existing credential formats;
installed arbitrary historical profiles, native scalar setting-envelope import,
nonempty connector configurations, final identity and live cutover remain open.
See [mobile ownership](mobile-production.md),
[record credential conversion](profile-record-credential-conversion.md) and
[batch evidence](evidence/issue-closing-20261014-mobile-record-credentials.json).
The prior [context and marketplace controls](evidence/issue-closing-20261014-context-marketplace.json)
retain their tested revision and platform limits.


- Installed artifact policy v3 and the twenty-receipt synthetic-agent diagnostic passed on all four targets, completing [#204](https://github.com/krazyjakee/21x/issues/204). See [artifact provenance](evidence/installed-artifact-v3-four-target-scenarios.json) and [agent provenance](evidence/installed-agent-08d495f-four-target-scenarios.json).
- [Recurrence](recurrence-owner.md), [scheduled coordination](scheduled-coordination-owner.md), [heartbeat](heartbeat-owner.md), [workspace cleanup](workspace-cleanup-owner.md) and [overdue reminders](overdue-notifier.md) have portable owners and explicit host boundaries. The [four-target scheduler matrix](evidence/schedulers-four-target-scenarios.json) passed 1,436 default standalone cases with zero skips in 92 files per target at `251685c`; it predates terminal and chat ownership.
- [Terminal ownership](terminal-owner.md) retains native close and cwd work, bounds replay, supports host reattachment and applies trusted IPC checks. The staged native PTY fixture passed on hosted Linux and both Macs at `97c7054`; Windows resize then passed at `e247073` after enabling raw TTY input and resampling when the notification races input; installed behavior and descendant cleanup remain open. The [matrix and failed Windows assertion](evidence/commander-terminal-platform-scenarios.json) retain their exact source and artifact provenance.
- [Chat runtime ownership](chat-runtime-owner.md) joins raw providers/tools and iterator cleanup before source teardown. [Commander ownership](commander-owner.md) now also retains accepted turn bookkeeping, title/summary work, Captain delivery and startup issue-write recovery; late writes remain held before source close.
- [Secret broker ownership](secret-broker-owner.md) now isolates listener generations, coalesces startup, joins native close and rejects final source revival. Shell generation accepts an explicit profile and quotes log paths literally; error logs redact credentials. Production Tauri bootstrap remains open.
- [MCP probes](mcp-probe-owner.md) now own child close and every HTTP request/body cleanup, bound active operations/output, cancel on shutdown and suppress late tool-list SQLite writes. Real local child/HTTP controls pass; production MCP integration remains open.
- [Plugin manager ownership](plugin-owner.md) now requires an explicit profile, retains catalog/download work, cancels source requests and blocks late plugin publication. Existing marketplace/resource tests run under standalone SQLite; top-level name/collision controls preserve directory ownership. Nested filesystem containment, atomic staging and production bootstrap remain open. Runtime Electron imports are now 44.
- Latest [local validation](evidence/plugin-owner-local.json): 1,599 standalone/private-pipe tests with zero skips in 110 files, and 5,392 application tests with 20 optional skips in 402 files. Both commands exited zero without unhandled errors. Forced typecheck, changed-source lint, source freshness and desktop/mobile build passed. Hosted Verify passed `aeb8951`. The preceding `97c7054` service matrix passed Linux and both Macs (1,519 default cases each) and failed Windows (1,518 passed, one native terminal resize failure). Earlier `4605298` fixture failures remain retained. The [Windows retry at `e247073`](evidence/secret-broker-windows-scenarios.json) subsequently passed all 1,530 default portable cases, including native terminal resize and actual PowerShell wrappers. Those results cover different source revisions; no single latest all-target matrix or installed terminal acceptance is claimed.

## Completed scoped platform evidence

[Installed package proof #200](https://github.com/krazyjakee/21x/issues/200) and [real OS credential conversion proof #201](https://github.com/krazyjakee/21x/issues/201) are closed. All four requested targets have successful retained evidence.

| Target | Installed package evidence | Real OS synthetic credential evidence |
| --- | --- | --- |
| macOS x64 | [Installed DMG report](evidence/macos-x64-installed-gui.json) | [Credential report](evidence/macos-x64-credential-proof.json) |
| macOS arm64 | [Installed DMG report](evidence/macos-arm64-installed-gui.json) | [Credential report](evidence/macos-arm64-credential-proof.json) |
| Windows x64 | [Installed NSIS report](evidence/windows-x64-installed-gui.json) | Windows target in the [retained credential evidence](credential-proof-evidence.json) |
| Linux x64 | [Installed AppImage report](evidence/linux-appimage-x64-installed-gui.json), earlier [Debian report](evidence/linux-x64-installed-gui.json) | Linux target in the [retained credential evidence](credential-proof-evidence.json) |

The package reports exercise installed resources with system Node hidden, trusted WebView invocation, explicit operation/navigation restrictions, bundled SQLite/PTY/worker and representative SDK import probes, normal shutdown and absence of a surviving owned running service. SDK imports do not exercise model-provider integrations. These are debug feasibility packages; release signing, updater compatibility, production feature parity and complete abrupt-death/process-tree guarantees remain open.

The [credential evidence manifest](credential-proof-evidence.json) records per-target workflow URLs, source commits, runtime versions and synthetic scenario results. Real OS-store conversion exercised current credential classes, destination reload/tamper rejection and preservation/reopening of original Electron credentials. It used isolated synthetic profiles and private pipes. Existing signed-installation permissions, arbitrary historical profiles and live import remain unproven. See [credential proof scope](credential-native-proof.md).

## Implemented domain and contract work

| Area | Current implementation | Remaining boundary |
| --- | --- | --- |
| Inventory and contracts | [Current inventory](inventory.json): 705 source files, 705 IPC references; nine dynamic sites retain unresolved AST expressions and have explicit manual owner/name maps. The [manifest](operations.json) contains 311 retained operations: 259 commands and 52 events | 38 scoped command declarations are now composed in the packaged synthetic-agent slice; 221 retained commands remain absent. Most operations/native callbacks still need actual owners, validators and authority |
| Private service transport | Version/epoch checks, UTF-8 NDJSON framing, bounded queues/requests, deadlines, cancellation, redacted errors, disconnect and no blind mutation replay; [protocol](protocol-foundation.md). [Transcript pages](transcript-pages.md) bound reads to 64 parts/256 KiB, recover captured-watermark races and handle oversized live updates through durable invalidations | General attachments/binary/audio/terminal chunking, transport saturation and broad installed load/recovery evidence remain open |
| Database and configuration | Actual schema-32 `DatabaseManager` extracted with explicit paths/runtime data and an Electron wrapper; real task/project/settings/transcript slice plus 18 content bindings composed into the service/native boundary; [database foundation](portable-database.md), [configuration integration](configuration-integration.md) | Production configuration UI/scope grants, full settings/credential semantics, lifecycle-dependent configuration effects and remaining domain operations |
| Profile ownership | Shared writer-process lifetime lock precedes database/provider startup; standalone service uses the same guard; [lock contract](profile-lock.md) | Installed live-profile cutover, filesystem support decisions and backup/import ownership |
| Actual agent lifecycle | Portable actual `AgentManager` core, explicit host seams and Electron wrapper; five bindings over the real deterministic fixture adapter: selected-Agent listing, start, resume, approve and stop; [owner extraction](portable-agent-manager.md), [desktop boundary](agent-desktop-boundary.md) | No Agent CRUD/send/general-session grant, production SDK parity or full retained agent feature coverage |
| Renderer boundary | Typed client, epoch/sequence checks, listener disposal and durable rehydration; isolated task/agent UI uses native/service transport; [client contract](renderer-client.md) | Full production renderer and every direct preload consumer |
| Credential candidate/recovery | Encrypted original/journal, staged candidate publication, interruption recovery, rollback and resource preservation checks; format-compatible reopening through the real `DatabaseManager` implemented and locally tested; [rehearsal](profile-import-rehearsal.md) | Bounded fixture/copy rehearsal only: no source activation, live-profile discovery/import, signed-installation access or release cutover |

The actual agent slice starts an assigned task through admission control, persists polled output into the durable projection, displays a genuine pending permission, confirms the real adapter's decision, reaches completion/review, resumes/recreates the owner and acknowledges stop/shutdown. Approval requires a nonempty request ID, exact task/project/session/adapter association and a current persisted running request. An in-flight claim rejects concurrent duplicates before an owner await. Live resume publishes the owner's current status for a reloaded renderer without inventing a provider-health observation. Shutdown bounds the drain of tracked startup/poll/idle work, raw adapter startup flights and late cleanup, and transcript backfill/history reads, then flushes pending projection notifications before successful return. Failed provider cleanup, other asynchronous provider calls and complete process-tree teardown remain open.

Browser removal is approved: T02 is cancelled and T11 covers removal/data compatibility. Tauri canvas browser/webpage surfaces and legacy controls are inert; saved metadata/edges and recording files are preserved without navigation or replay. Shipping Electron behavior remains until cutover. External OAuth, external links, sandboxed artifact previews and trusted app WebView security remain required. Historical migration-only browser policy modules/tests were removed. See the [scope decision](README.md#approved-browser-removal).

## Earlier validation batch

Latest [local batch evidence](evidence/gate-batch-local.json) passed: 54 credential/rehearsal cases including actual candidate `DatabaseManager` reopen, 67 shared contract/schema cases, full TypeScript typecheck, lint for 18 changed TypeScript files, isolated frontend build, locked Rust metadata and formatting. The actual bundled service wire proof passed with 14 events. The standalone actual agent boundary proof passed with 85 portable modules, 30 validated events and zero warnings/errors, including current/stale/duplicate approval, pending live-resume status, owner recreation, durable delta and acknowledged teardown. These are focused local results, not a new installed-platform acceptance report.

| Implemented proof | Current evidence state |
| --- | --- |
| Actual Electron performance baseline | [Hosted run](https://github.com/krazyjakee/21x/actions/runs/38301839412) passed three sequential starts against built main/preload/full renderer with isolated profiles and private reporting; [retained report](evidence/linux-x64-electron-baseline.json). No matched Tauri/Electron performance decision; [measurement limits](performance-baseline.md) |
| Hostile artifact WebView authorization | [Installed Linux run](https://github.com/krazyjakee/21x/actions/runs/38300023337) passed native positive controls, excluded-label command/event denial, bounded sandbox relay checks and shutdown after the packaged URL correction; [retained report](evidence/linux-x64-artifact-authorization-installed-gui.json). Other targets and production viewer integration remain open; [boundary and limits](artifact-authorization.md) |
| Installed synthetic-agent UI | [Latest installed matrix](https://github.com/krazyjakee/21x/actions/runs/38323026423) passed all twenty actual start/HITL/projection/pending reload/live resume receipts and normal shutdown on macOS x64, macOS arm64 and Linux AppImage x64; [retained reports/checksums](evidence/installed-agent-unix-23109a4.json). Windows failed before packaging; its retry passed the standalone suite but stopped during service initialization. Windows acceptance remains open |
| Candidate journal/import/recovery | Local fixture tests and real format-compatible database reopening passed; installed historical/live-profile migration and platform durability remain open |

The [final application Verify](https://github.com/krazyjakee/21x/actions/runs/38300673519) passed at `711dd21`: lint/typecheck, desktop/mobile builds, **5,093 tests passed / 8 skipped**, 26 subprocess regressions, seven supervisor tests and both desktop UI regressions. Its [retained summary](evidence/gate-batch-verify.json) records a corrected test expectation for the new bounded shutdown contract. The native agent/artifact reports exercised application source `a4a980f`; the later commit changes only that regression test. Hosted native/baseline runs are serialized to limit hardware load, and dependencies/native staging are reused. Reports identify the revision they actually exercised.

Historical evidence remains useful within its scope: [Verify at `0946d24`](https://github.com/krazyjakee/21x/actions/runs/38267753614) passed lint/typecheck/builds and 5,007 tests; the [first installed Debian workflow](https://github.com/krazyjakee/21x/actions/runs/38267769673) passed independently. The later [thirteen-check installed Linux database/task flow](evidence/linux-x64-synthetic-desktop-installed-gui.json) proved persistence across a real WebView reload before the actual agent boundary was added. Those historical runs do not prove the latest twenty-check agent UI or complete production renderer.

## Local continuation — shutdown ownership and platform proof modes

The portable manager now retains raw initialization, health/readiness, create/resume and late teardown promises after public startup deadlines expire. Transcript snapshot/delta operations remain owned through backfill and their final database query; debug/coordination history reads retain the adapter flight after session removal. Shutdown refuses new history reads before database access. Eight regressions hold these operations open and verify incomplete shutdown until the raw work and late teardown settle. This does not establish production SDK process cleanup or every asynchronous agent operation.

The packaged-platform workflow now selects `feasibility`, `synthetic-desktop`, `synthetic-agent` or `artifact-authorization-proof` on the four existing targets, serially. Synthetic modes stage the actual database service; agent mode runs the actual desktop/private-pipe proofs against standalone SQLite before packaging. The installed runner validates the requested mode, exact thirteen/twenty receipts, artifact positive/negative controls, host architecture, installed resource paths, owned temporary profile and shutdown acknowledgement. Evidence/package names include the proof mode. Eleven evidence-policy tests run in Verify and each platform job. The workflow is prepared for the outstanding non-Linux agent/artifact evidence; those hosted runs have not been performed for this continuation.

The [local continuation report](evidence/continuation-local.json) records 331 passing TypeScript regression cases (including the two opt-in standalone proof tests and seventeen inventory/contract cases), the eleven Python evidence-policy cases, full typecheck, changed-source lint and the isolated frontend build. Pinned Node 22.23.2 / SQLite 13.0.3 passed the actual lifecycle, desktop boundary and bundled private-pipe proofs with 18, 30 and 14 observed events respectively; all fixture dependency warnings/errors were zero. Staged SQLite, PTY, worker and representative SDK import preflight also passed. The native host compiled with both agent/artifact features; sixteen engine unit cases and the actual staged Rust database roundtrip passed. These local checks do not close any acceptance gate or replace installed platform reports.

## Earlier continuation records

These paragraphs preserve the evidence and pending state at their named historical revisions. The latest continuation above supplies current platform and validation status.

[Hosted Verify at `23109a4`](evidence/continuation-hosted-verify.json) passed 5,149 application cases with ten recorded skips, the default 460-case standalone suite, builds/typecheck/lint/freshness, native/service tests and the real navigation/Commander desktop regressions. [Verify at `8b9954a`](https://github.com/krazyjakee/21x/actions/runs/38326133274) also passed after the runner/checkout fixes. The three successful installed agent targets above ran `23109a4`; the matrix conclusion is failure because Windows did not reach installed execution. [Windows retry](https://github.com/krazyjakee/21x/actions/runs/38326153468) fixed its scanner failures and JSON capture, then exposed a bundled-service startup disconnect. The [artifact matrix](https://github.com/krazyjakee/21x/actions/runs/38326219903) is separate in-progress evidence at `8b9954a`.

The provider-listing continuation additionally retains configuration-refresh, provider and model-listing flights even when there is no live session. Shutdown refuses new listings before database/adapter access, avoids starting a provider read after a late configuration refresh, and discards results arriving during shutdown. Six owner/normal-operation regressions passed; the manager/admission/concurrency suite passed 274 cases across three files. Startup prerequisites now emit fixed redacted classifications. A service-only workflow mode stages and tests the actual platform service without Rust/GUI builds; its evidence names explicitly distinguish it from installed acceptance.

The [Windows service retry at `1174b11`](evidence/windows-service-1174b11.json) passed after correcting inherited stdio validation. It ran 462 portable cases, all five actual startup-denial controls plus transcript recovery (six cases, zero skips), and the configuration/agent private-pipe proofs. Native compilation/GUI execution were intentionally omitted; the installed Windows agent retry is queued/running separately. [Windows stdio and Interrupt/reaper lifetime](windows-service-stdio.md) documents the correction and eight further races; the manager/admission/concurrency suite passed 282 cases, and the subsequent full application recheck passed 5,174 with four recorded skips.

Installed separate-WebView artifact authorization passed on both macOS architectures at `8b9954a`; [x64 evidence](evidence/installed-artifact-macos-x64-8b9954a.json), [arm64 evidence](evidence/installed-artifact-macos-arm64-8b9954a.json). Their original reports preserve the explicit same-main-iframe limitation. The old Windows source failed before packaging, and its corrected installed retry remains required. The current source's [owning Node worker selector](node-worker-runtime.md) reuses the bundled executable on every platform, strips inherited Electron mode aliases and rejects relative executable names. A real IPC child runs with PATH empty and is joined on exit. Production worker/voice/provider integration remains separate work.

The subsequent [standalone portable suite](standalone-tests.md) runs under staged Node 22.23.2 and its SQLite addon, with Vitest-resolved Electron imports rejected. It includes all 29 shared files/393 cases; **463 cases/44 files** passed with portable and bundled proof wrappers enabled (default CI mode: 460/41), alongside 28 affected legacy database cases, forced typecheck and changed-source lint. Verify/native platform jobs now reuse native staging for these tests. This advances #222 test tooling; the production test launcher/UI regressions and complete Electron retirement remain open.

The latest [approval/Stop lifetime evidence](evidence/approval-lifetime-local.json) records **5,155 full application cases passed / 4 skipped in 363 files** after seven further owner regressions. In-flight responses and previously-started user Stops retain shutdown ownership; late responses cannot revive stopped/replaced sessions. The 268 manager/admission/concurrency cases, real bundled service proofs, six staged native cases, typecheck and desktop/mobile build passed. Earlier batch reports keep their earlier source hashes and totals.

The latest [issue continuation evidence](evidence/issue-continuation-local.json) passed **5,148 TypeScript cases / 4 skipped across 363 files**, with opt-in standalone proofs enabled, plus 20 native unit and 6 staged tests. It records source/resource hashes, configuration persistence/conflicts, 642-part transcript recovery after 21 bounded invalidations, actual fixture-agent approval/completion, typecheck, builds and the 26 subprocess regressions. Full lint passed with the same 165 warnings. Three workflow files/38 shell steps passed syntax checks. These supersede earlier local validation claims for the latest working tree; earlier installed reports retain their original revisions.

This continuation addresses #207 live transcript overflow, #210 content configuration integration, #208 raw handler ownership and #222 verification tooling. Peer disconnect no longer discards raw handlers; terminal cleanup joins them before releasing writer resources, and a closing database owner rejects work after authorization. A stale standalone proof expecting an Electron wrapper for the authenticated Node provider was corrected and extended with ciphertext/tamper/mislabel checks. Prepared platform workflows include the new proofs but have not run against this uncommitted source.

The [readiness audit](readiness-audit.md) records the full local recheck (5,101 tests passed / 8 skipped, builds/typecheck passed, lint passed with 165 warnings, 26 subprocess and 21 Rust unit/staged cases). It corrected stale source inventory/review coordinates and added Verify freshness checks. The [retirement plan](electron-retirement.md) inventories eight Electron packages, 47 runtime imports and 368 direct preload references in 34 files, with ordered removal after G0–G4 acceptance. This prepares the work; no production entrypoint, release feed or live profile was switched.

## Remaining acceptance gates

| Gate | What still prevents acceptance |
| --- | --- |
| **G0 — feasibility** | Matched resource/performance baseline and regression budgets, accepted supported platform/WebView minimums, app identity/path and redistribution decisions. Four package and OS credential proofs are completed scoped evidence, not the entire gate |
| **G1 — contracts** | Complete runtime schemas, real command/event/native callback bindings, caller/task/project/path authority and capability review; remaining decisions and general stream limits. The typed 311-operation framework and nine current dynamic-site reviews do not make every operation implemented |
| **G2 — working vertical slice** | Production slice integration and review of lifecycle/recovery/large-data limits. Bounded installed agent/HITL/reload and artifact diagnostic acceptance passed on all four targets under #204; the full gate remains open |
| **G3 — retained feature parity** | Full production renderer, all five real agent providers, Captain/admission/handoff, background/mobile/API services, terminals/workers, voice, connectors/OAuth, native host services and retained canvas/artifact behavior across the [parity matrix](validation.md#feature-parity-matrix). Complete browser retirement/data-preservation checks remain required |
| **G4 — release rehearsal** | Signed/installed historical-profile conversion, live import and credential rollback boundaries, release signing/notarization, first framework-transition install, second update, uninstall and recovery/cutover rehearsals; accepted updater/manual-update policy |
| **G5 — retirement** | Switch the shipping application only after prior acceptance, remove Electron shipping dependencies/artifacts/host assumptions and complete final native/service/security/documentation audits |

No live migration release has been published. The next evidence batch closes only its scoped proof work; [#193](https://github.com/krazyjakee/21x/issues/193) and the remaining gates stay open until their complete exit criteria are reviewed.
