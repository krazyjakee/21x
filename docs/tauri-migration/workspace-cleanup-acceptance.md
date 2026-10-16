# Production workspace cleanup acceptance

This continuation addresses the actual nonempty cleanup consumer in issue #210. It is
one part of that issue's task/project/configuration/settings acceptance, not a
claim that the whole issue or the migration is complete. The explicit #202
closure dependency remains in force. A reviewed process-observation code subset
from #213/#215 can be integrated without waiting for those umbrella issues to
close; unrelated native services are not prerequisites for this cleanup change.

## Evidence boundaries

The Node proof uses the actual `ProductionService`, sealed construction,
`ProductionOwner`, SQLite, private `ServicePeer`, `WorktreeRuntimeBackend`,
`WorktreeManager` and `WorkspaceCleanupSchedulerCore`. Its files, task rows,
workspace directories and retained child/PTY handles are newly created synthetic
fixtures. It never selects a user's profile, remote repository or live workspace.
The fixture host callback is controlled authority for these tests, **not a claim
of OS-wide idle visibility**. Its real handle/descriptor receipts establish raw
lifetime and effect ordering in the actual Node consumers.

The native supplement owns physical workspace roots and a bounded Linux procfs
observation. The finite private `host.workspace.cleanupObservation` callback
accepts only version 1, `action` and a task ID; `check`/`release` additionally
require the minted UUID lease. There is no request path, process ID, command,
termination privilege or public observation opener. Acquire returns idle with a
lease or busy/unknown; check returns idle/busy/unknown; release acknowledges
released. The optional launch capability is `workspaceCleanup: host|unsupported`.
Missing capability and unsupported OS stay unavailable. Missing, inaccessible,
partial or unreadable process information is unknown and must refuse cleanup.

Full-host procfs visibility is an actual limitation: unrelated inaccessible
process entries also prevent an idle result. The retained-native-child test can
prove busy, but after reaping it must record unknown rather than invent idle
when complete visibility is unavailable. A scan cannot prevent an unrelated
external process entering a directory afterward. A lease requires rechecks
around effects and protects managed starts/PTYs through actual owner locks; it
does not freeze every process on the machine. The native observer covers the
current visible procfs namespace only. Hidepid, foreign mount namespaces,
process/thread inventory churn, limits/deadlines and unresolved bind/subtree
mount aliases (mountinfo root other than `/`) also produce unknown. After-reap
unknown with zero tickets is explicit refusal evidence, not idle-removal proof.

## Reproduction and expected receipts

The source harness is `scripts/production-workspace-cleanup-proof.ts`. Its
adjacent test covers fixture guards. The actual-owner wrapper is
`src/service/production-workspace-cleanup-acceptance.test.ts`, already included
by the standalone configuration's service-test wildcard. It requires Linux and
the existing explicitly staged terminal-proof flag; it does not change the
runner or dependency set. The primary runs, after all owners freeze:

```sh
rtk pnpm test:tauri -- --terminal-proofs src/service/production-workspace-cleanup-acceptance.test.ts --reporter=default --reporter=json
```

Retain `PRODUCTION_WORKSPACE_CLEANUP_REPORT`, actual exit status, command,
implementation revision, log checksum and any skips. JSON-only reporting may
suppress the console receipt. The report records exact source/runtime/addon
SHA-256, Node/OS/architecture, fixture version, every expected/actual numeric
counter, controlled observation scope/counts, retained directory FD maximum and
acknowledged cleanup. WebView is null because this is a source/Node run. It
does not inherit the preceding payload harness's successful results.

Expected acceptance scenarios (actual results come only from the executed log):

| Scenario | Required result |
| --- | --- |
| Manual public and actual scheduled owner | Each removes a completed old fixture workspace after retained controlled observation and fresh checks |
| Withdrawn caller authority | `INVALID_REQUEST` before any observation or mutation |
| Actual retained cwd child | `BACKPRESSURE`; scheduled pass also preserves exact workspace bytes; no signal to the child |
| Unknown callback observation | `UNKNOWN_OPERATION`; scheduled pass also preserves bytes; unknown is not idle |
| Cleanup holds actual admission/lifecycle lease | Same-task and cross-task starts refuse and no adapter session is created inside the exclusion |
| Real staged PTY, live Manager session, durable queued start and unacknowledged adapter creation | Manual busy refusal and scheduled preservation; only their actual acknowledged stop/reap permits removal |
| Actual filesystem FD and source mutation | Busy cleanup refusal; accepted reads/jobs remain owned; held cleanup prevents new source work |
| Actual heartbeat run | Real scheduler owns the task while its adapter creation is held; both cleanup owners preserve workspace; cancelled raw heartbeat startup drains before ownership releases |
| Task session-generation substitution | Current task binding refuses late effect and preserves selected bytes |
| Task-directory and workspace-root inode substitution | Controlled observer loses physical visibility, refuses with unavailable; both original and replacement generations remain intact |
| Cancellation during raw acquire followed by held release | Public reply cancels; real observer directory FDs and profile writer remain open until raw release acknowledges; writer closes afterward |
| Unrelated retained child | Survives all cleanup passes without being signaled; exits only when fixture closes its own stdin |
| Rowless aged orphan, manual and scheduled | Server-discovered literal directory ID has no task before or after removal; scheduled whole flag is honored, explicit manual removal remains available |
| Orphan busy/unknown, age refresh and physical replacement | Retained actual child yields busy, unknown refuses, changed age refuses late effect, and both displaced/replacement generations retain exact bytes |
| Independent nested dependency cleanup | With whole cleanup disabled, enabled scheduled GC removes only aged `node_modules`; recent modules and exact workspace bytes remain; disabled dependency GC preserves the old candidate |
| Dependency manual result and active task | `nodeModulesCleaned` counts the exact removed target and `cleaned` stays zero; an active task is excluded from selection without borrowing an idle observation |
| Dependency unknown, inventory/target replacement and cancellation | Unknown refuses; changed bounded child metadata or target identity refuses late effect; cancellation retains raw directory FDs until acknowledged release and preserves bytes |
| Dependency GC on a rowless directory | Existing literal-ID absence lease allows dependency-only pruning without creating a task, while preserving its workspace root |
| Independent automatic cadence | A recent dependency run does not suppress due whole cleanup, and a recent whole run does not suppress due dependencies; skipped-phase timestamps stay unchanged; manual ignores cadence and preserves both automatic timestamps |
| Two actual committed local Git worktrees | Actual public manual cleanup reaches production `WorktreeManager` and `GitProviderProcessOwner`; both successful Git removals, absent bare metadata entries, absent worktree paths and final task directory removal are required |
| Held real Git completion | Actual callback received and child/stdout/stderr closed before delivery is held; global start exclusion and SQLite writer remain retained until delivery; every raw receipt drains before profile/root release |

The scheduled trigger reflectively calls the actual private `runCleanup()`
method on the real singleton scheduler. It adds no RPC and uses no fake clock or
fixed sleep. Public cleanup commands cross actual fragmented private-peer frames.
Race barriers acknowledge actual observer/read/start callbacks. Peer drain and
owner close join raw work before subsequent scenarios or profile release. No
query runs on SQLite while it is concurrently closing. The final writer-open
observation happens while the explicitly held raw native release blocks shutdown.

Ordinary scheduled scenarios explicitly set both
`workspace_autocleanup_last_run` and `workspace_nodemodules_gc_last_run` to the
ancient fixture timestamp before triggering a pass. They do not depend on the
last scenario's successful automatic cadence. Dedicated cadence cases set one
recent and one ancient value and leave those values untouched before the actual
scheduled trigger. Retention settings are explicit (`1` day) for reproducibility;
both production default retention values are seven days. Dependency GC defaults
enabled when its setting is absent; otherwise only the literal `true` enables it.

Orphan names come from the real scheduler's bounded directory scan, match its
literal ID policy and remain without a database task. Whole-orphan eligibility
uses the directory's own mtime and is rechecked after yielded observations.
The service owner's separate regression deletes/restores an exact captured real
task row during observation to test reappearance; the Node proof's replacement
and mtime races do not claim to execute that row-reappearance case. Dependency
selection uses each candidate directory's own mtime, skips symlink directories
and `.git`, stops at an accepted `node_modules`, and retains bounded descendant
metadata plus physical ancestor identity. Source regressions supplement cases
not independently executed by the actual-owner harness.

`scripts/production-workspace-cleanup-git-fixture.ts` creates only new local
committed repositories, bare clones and linked worktrees inside the synthetic
root. Setup is fixture work, not production setup/fetch acceptance. The actual
task and project repository records authorize `cleanup-fixture/alpha` and
`cleanup-fixture/beta`; removal uses the unchanged public cleanup owner. The
helper instruments the real process owner's `execFile`, never stubs removal or
fabricates success. Its callback gate opens only after actual callback, child
and stdio close receipts. The report retains system Git path/version/SHA-256,
per-command receipt booleans and removal metadata verification. No network
transport, user Git config, credential helper or hooks are used. Teardown closes
ProductionOwner first, joins the helper's real raw process work and then removes
its private setup sandbox. Any failed drain preserves the fixture root and
records the original workload failure together with cleanup failure.

Every directory and child belongs to the newly created fixture root. Shells use
the staged node-pty addon with no profile/history and a minimal environment;
ordinary children use staged Node and hold a real workspace FD until stdin ends.
The fixture never signals numeric PIDs or invokes ambient shell/ps/lsof cleanup.
Real native handles own PTY Stop. Raw observation directory FDs close on exact
lease release; failed drain retains the synthetic profile instead of deleting
it under unfinished work. Controlled adapter callbacks prove Manager admission
ownership, not vendor SDK behavior. Native acquire/check/release source-wire
and Linux procfs tests independently supplement these Node receipts.

## Whole issue #210 acceptance map

Historical issue descriptions and older domain documents describe their original
revisions. Current source and later evidence supersede statements such as Agent
CRUD remaining unbound or agent API-key writes remaining plaintext-only.

| Fresh issue criterion | Runtime binding and codec | Authorization and actual consumer | Proof / remaining acceptance |
| --- | --- | --- | --- |
| Skills/projects/repos/resources | `ConfigurationBackend` content operations, configuration codecs, production binding composition | Current task/project/global/reference grants; actual shared SQLite writer and owned configuration effects | Configuration/service/private-pipe evidence covers content mutations, conflicts, reorder and durability. Installed current production UI/scope/event delivery still needs target receipts; old synthetic proof is not production scope acceptance |
| Task lifecycle, subtasks/order, checkpoints, feedback/learning | `TaskLifecycleBackend` and production agent codecs | Actual AgentManager lifecycle/send/admission, child ordering and subtree teardown; live approval/request ownership; feedback reaches `updateTaskFromUser` and existing learning/skill-sync path | Existing owner tests use actual SQLite/manager with controlled adapter. Full real-provider feedback-to-learning-to-skill-sync and durable checkpoint semantics must have their own explicit acceptance, not a stored status or cleanup result |
| Recurrence/snooze/overdue and project limits | Actual recurrence/heartbeat/automation/reminder owners; `ProjectRuntimeBackend` finite codecs | Current project/task/agent grants and actual bounded manager/queue reads; audited limits/pins/pause and scheduler cadence | Published lifecycle/project/group/heartbeat evidence covers its exact scenarios. Full installed background/cadence/reconnect and real provider effects remain separately unproven |
| Source-completion effects | Task lifecycle/source/plugin/connector finite codecs | Current source association and plugin-declared action; actual SyncManager source leases, external acceptance and local reconciliation | Existing controlled source acceptance/refusal evidence; actual configured external source completion must be demonstrated with authorized fixtures. Local completion choice is not an external update receipt |
| Agent CRUD/config/model listing | `AgentConfigurationBackend`, finite agent configuration codecs, actual production composition | Current global/agent/project/reference scope; manager Stop/config notification, queue reconciliation and raw provider/listing lifetime | Published foundation/lifecycle/record-credential evidence. Actual five-backend SDK/CLI and installed lifecycle parity remain their own acceptance; successful controlled adapter callback is insufficient |
| Settings credential formats/masking | `ProductionSettingsBackend`, record-credential codecs and protected startup preflight | Actual authenticated setting/record storage; finite key/environment names; derived affected owners and current mutation fences; marker preservation and omission/empty distinctions | Later record-credential source encrypts agent API keys, MCP and declared source fields. Historical credential conversion and installed OS-store acceptance remain separate; no silent conversion or plaintext echo |
| Lifecycle-dependent settings | Settings backend plus actual owned scheduling/native consumers | Global admission/pause immediate effects; whole-workspace and dependency cleanup use independent enable/retention/23h automatic cadence settings; other preferences remain on their real cadence | Batch32 validated retained strict plain-task cleanup. This continuation authors actual orphan/dependency/Git acceptance and independent cadence receipts; results remain UNRUN until primary validates. It does not replace unsupported settings owners with no-ops or make unrelated native feature work part of this bounded acceptance |
| Every retained command/event reconciled with #202 | `src/shared/desktop-operations.ts`, generated contract inventory, exact `PRODUCTION_COMMAND_CODECS` / `PRODUCTION_EVENT_CODECS`, finite native policy and request corpus | Codec membership, native grant, runtime handler, current authorization and actual effect are separate facts | Use existing inventory/contract/corpus checks and owner evidence at the validated revision. No blanket parity claim from a count; remaining unbound/unsupported operations and installed event routes stay explicit under #202 |

The canonical production map composes database, configuration, task/agent,
Commander, settings, terminal, MCP, sources/plugins/connectors, session context,
marketplace, mobile, installer, artifact, voice management, Git, filesystem,
groups, project, heartbeat, worktree, CLI MCP, attachment, tray and UI domains.
Only the actual `operationSchemas` composition grants handlers; disabled
connectors and unsupported native capabilities do not gain implementations from
the codec map. The finite native policy and renderer transport must independently
accept each retained route. Published evidence remains tied to its recorded
revision and source hashes, not retroactively to this batch.

The emitted `contracts` array reconciles **each retained manifest row** rather
than reporting only aggregate counts. It separately records declared
owner/caller/destination, source codec membership, actual attached runtime
handler/event-route presence in this capability-limited launch, attempted
commands and successful replies/observed events. Handler presence comes from
read-only inspection of the already attached binding's actual `operationSchemas`,
not by creating a second registry. Native grants and denied-scope parity are
explicitly marked unassessed for each row. Cleanup counters provide the exact
attempt/refusal/effect evidence; zero attempts and absent optional capability
stay visible. This mapping is not a claim to have exercised every retained
command, proved each domain's authorization or completed #202.

The new source supports explicit captured absent-ID orphan removal and independent
aged dependency pruning through retained physical observation and managed-work
exclusion. Their newly authored scenarios and successful production Git removal
are **source-ready acceptance work, UNRUN by the engineer**; only primary's actual
report can establish passing results at the new source hashes. Batch32's 94
validated counters remain the baseline, not retrospective evidence for these new
paths. Protected group/coordinator workspace deletion remains excluded. Native
visibility, arbitrary external processes entering after a scan, installed
platform/event routes and the whole issue's provider/source/learning/checkpoint
acceptance remain separate. The explicit #202 closure prerequisite remains open.

Relevant accepted source histories include production foundation/lifecycle,
native terminal/settings, sources/MCP credentials, connector/plugin forms,
context/marketplace, record credentials, project/group runtime and
heartbeat/worktrees. Their reports are retained under
`docs/tauri-migration/evidence/issue-closing-*.json`; broader counts and optional
skips are not substitutes for a criterion-specific receipt. This cleanup
continuation does not erase any exact remaining defect or explicit dependency.

## Validation ownership

The engineer authors source/tests without running checks. The primary freezes
all actual inputs, executes the focused proof and native supplement, retains
default console plus JSON reporter output, and publishes only verified source.
A source-ready handoff, controlled callback, skipped integration case or test
compilation failure is not accepted installed evidence. No live release,
workspace termination, historical profile conversion or data cutover is
authorized by this proof.
