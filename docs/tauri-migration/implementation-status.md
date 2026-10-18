# Migration implementation status

Updated 2026-10-14 with four-target installed diagnostic acceptance, the scheduler service matrix at `251685c`, hosted Verify at `aeb8951`, and local plugin manager ownership validation. **The shipping application still uses Electron, and G0–G5 remain open.** The [overall migration tracker, #193](https://github.com/krazyjakee/21x/issues/193), links nineteen open remaining-work issues (#205–#223); bounded diagnostic issue #204 is closed and #202 retains complete contract ownership. Completed scoped issues and successful fixtures establish the behavior they exercised; they do not establish a finished migration or authorize live cutover.

This page describes current work. Earlier batch notes and reports retain their original source revisions and limits; their former platform failures or unimplemented-agent statements are historical.

## Latest continuation

#214/#215 protected directory syscall continuation (`80b77216`): an actual Source exact-ID removal regression reproduced outside-canary deletion when the attachment root swapped inside the final kernel unlink; held directory descriptors now anchor Linux mkdir/open/link/unlink/rollback to verified physical roots/tasks. Canonical metadata, private journal facts and native file receipts retain canonical identities; cleanup reacquires authority rather than persisting numeric FD capabilities. Actual directory-close acknowledgements remain owned through cancellation, late/refused close, explicit retry and profile shutdown; two real ProductionOwner controls retain the profile lock until acknowledged close. Expanded runtime gate441passed/13files0skip plus four actual schema/FileOwner SIGKILL checkpoints pass; final168passed/5files0skip, forced typecheck, lint0errors165baselinewarnings, both frontends and inventory923/contracts pass after one fixture-path expectation and one own lint declaration repair. Two separate actual staged stdio entries are included; SIGKILL fixtures are not whole installed Root/power-loss proof. Missing Linux/proc-FD authority refuses before protected file effects; macOS/Windows protected read/copy/cleanup remains unavailable pending equivalent proven native authority. Whole-task deletion still retains directories; metadata-only save, ordered-array CAS, exact-ID metadata-first delta and manual review remain unchanged. No automatic GC, filesystem/SQLite atomicity, complete hostile same-directory leaf/inode-reuse immunity, installed native/all-platform, viewer/voice/public operation/grant claim. [Directory authority](native-attachment-directory-authority.md) and revision-bound issue-214-protected-directory-authority-local-20261018.json record scope (evidence follows). Hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

Native feedback receipt continuation (#209): one captured task/Source/conversation and view owns the feedback form, marker and retained send. The draft remains visible while raw work is pending; the canonical learning receipt is required before one send, without renderer pre-resume/create. A retired or changed binding fences later effects; uncertain delivery stays in review without replay or accepted-marker rollback. Skip transfers its original choice once to the completion owner; Electron behavior is preserved. The existing marker and message remain separately acknowledged, not an atomic Source transaction. Own final gate passes2127renderer/160files,593affected/21files and153directory/journal/profile-owner cases/4files, all zero skips, including26 actual typed-feedback controls and2 actual staged stdio entries. Forced no-emit typecheck, lint0errors165baselinewarnings, restaging, both frontends and923inventory/contracts pass. Thirteen published-hook failures and four own unpublished follow-up failures are repaired without weakening assertions; revision evidence: issue-209-native-task-feedback-local-20261018.json. Inherits E2's verified Linux directory authority (`80b77216`/`ce601682`); the final local gate restages and repeats actual Source/compiled-root controls. Installed provider/platform, AutoRun/full-board/202/208 acceptance remains open. Viewer/voice availability unchanged. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

Native completion receipt continuation (#209): manual completion now requires the canonical completed task, while linked Source completion retains the original task/Source choice through its marker, action and strict completed readback. One mounted view owns admission; retirement fences later effects and unknown results remain in review without replay or rollback. Native board status transitions use the existing lifecycle owner without a second renderer Stop. Electron orchestration and unavailable exact-root Fresh remain unchanged. Inherits B217 canvas/drawing recovery (`1dd35a9f`/`81a27abe`) and E2 protected deletion retention (`956c5d07`/`d928a12d`); no viewer/voice/public availability added. Own full local gate passed2101renderer/159files and542affected/18files, zero skips, including26 new actual typed-facade completion/board controls, real/compiled Source deletion controls, the actual feedback-owner proof and2 staged stdio entry controls. Forced typecheck, lint0errors/165baseline warnings, production+shipping frontends and923-source inventory/contracts pass. Revision-bound evidence: issue-209-native-task-completion-local-20261018.json. Installed/platform/202 acceptance, feedback/AutoRun and complete board view receipts remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

#217 canvas/browser/artifact continuation: native canvas/drawing saves now require a successful scoped read on the captured current connection; failed/corrupt/oversized/malformed recovery stays fenced, reconnect withdraws timers and retries read-only, and pagehide retires reads/writes. Eleven actual typed-facade old-source controls reproduce the lost-data paths; thirteen repaired controls also cover held old replies. Actual Source and staged Root preserve exact dormant panel/drawing JSON, recording hashes/inodes and immutable encrypted rollback backups without navigation/replay/deletion, and refuse retired private commands plus authenticated loopback HTTP/MCP tools. The optional private viewer Source owner captures bounded immutable HTML through the actual artifact backend, exposes early cleanup ownership, permits one validated/scoped open and joins held read/register/open/retire work; it remains unregistered/unavailable with synthetic native receipts only. Final adopted runner passes2075renderer/158files and 329affected cases/19files0skip; forced no-emit typecheck, lint0errors165baselinewarnings, staging, both frontends and923inventory/contracts pass. Inherits956c5d07/d928a12d protected deletion retention and repeats actual Root/private-peer canaries. [Canvas/browser preservation](canvas-browser-retirement.md), [private viewer contract](artifact-production.md) and issue-217-canvas-artifact-source-local-20261018.json record commands, hashes, initial fixture/type/lint failures and scope. No public operation/grant, native viewer/iframe authority, identity, release/profile cutover or Electron retirement change. Native separately excluded viewer/UI binding, current hostile native viewer tests, installed supported-target matrix and209/215/202 prerequisites remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

Production task-deletion retention continuation (#214/#215): an actual retained db:deleteTask removed an outside synthetic canary after the protected attachment root was replaced by a symlink. Production now captures a private DatabaseManager retention policy, returning from byte cleanup before path construction/traversal; logical task/subtree/source deletion keeps its existing grants, exclusion, Stop and canonical event owner while protected directories and existing journal facts survive. No recursive cleanup authority or automatic reclamation is inferred from a task ID/root check/ledger record. Captured-policy mutation/default/invalid-value controls and actual Source plus compiled-root/private-peer canaries pass; ordinary subtree/source positives retain copies/facts after accepted row deletion. Initial pinned gate349cases/12files0skip, forced no-emit typecheck, lint0errors165baselinewarnings, staging and both frontends pass; the merged rerun exposed and repaired an own assertion that imposed unspecified delete-event ordering, preserving exact IDs/counts. Final merge onto a6001e1a passes171cases/6files0skip, including34actual native CRUD controls, both Source/compiled-root canaries and two staged stdio entry controls; forced typecheck, lint, staging, both frontends and921inventory/contracts pass. [Private journal](native-attachment-journal.md) records retained legacy files without invented inventory, cleanup/reconciliation and filesystem/SQLite atomicity limits; revision evidence follows in issue-214-task-deletion-retention-local-20261018.json. No public operation/DTO/grant, native voice, identity/scheme, mobile incoming-file policy, release/cutover or Electron behavior change. Supported-target installed acceptance and202/208 prerequisites remain open. Hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

Native task CRUD receipt continuation (#209): create/delete/project-move cache publication observes the captured document cohort and connection without reinstalling task subscriptions; create validates accepted parent/project, and move validates its root/destination/canonical rows. Native project moves use one synchronous lane, canonical subtree receipts and current-view selection/preview followups; coordinator rows expose no ordinary move/delete mutation. Real delete confirmation stays open through one retained Source operation, with no renderer pre-Stop/local session removal/worktree cleanup, and unknown/false receipts require close/review without replay. Same-kind modal replacement, project-return, pagehide and reconnect fence late UI effects; idle retirement explains review, and workspace directories are explicitly retained for separate cleanup. Six published old-source controls reproduce the receipt failures. Own fixture setup/snapshot errors and eight full-renderer regressions from accidental subscription reinstallation were repaired with original assertions intact; focused165 passes before the last four availability controls. Final34actual native CRUD controls, full2062renderer/157files and503affectedUI/Source/14files0skip (two actual staged stdio cases), forced typecheck, lint0errors165baselinewarnings, staging, both frontends and921inventory/contracts pass. [Renderer recovery](production-renderer-recovery.md) and issue-209-native-task-crud-receipts-local-20261018.json record exact scope. No Source/native/public operation/grant change or deletion atomicity claim: E2 separately reproduced whole-task recursive attachment cleanup escaping into an outside synthetic canary on3b/430 and owns its private retention-policy fix. B217 owns the separately audited failed-load canvas/drawing persistence fence. Completion/feedback/board/AutoRun receipt audits, installed supported-platform UI and202 prerequisite remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

Protected attachment journal continuation (#214/#215, linked #213): the production profile/FileOwner now captures bounded private publication, verification, metadata-detachment and exact-ID removal facts before acknowledgement, with original profile/root/task scope and digest checkpoints. Metadata-only copy and pure post-commit receipt bookkeeping remain unchanged; CAS observations and removal intents join their existing SQLite transactions. Persisted IDs cannot recreate live file authority or replay cleanup. Actual protected-profile restart, canonical-reference preservation, private settings exclusion, refused unlink and post-unlink SQLite retirement failure are covered. The authenticated task-API audit reproduced a stale array erasing another accepted record; production HTTP/MCP now captures attachment-array unavailability before route effects, while field-only and legacy-host controls pass. The adopted pinned runner passes622cases/17files0skip, including actual Source/mobile/private-peer/staged-entry graphs; four real SIGKILL checkpoints reopen physical SQLite without automatic file mutation. Final rebase onto63171393 passes366affected cases/8files0skip, forced no-emit typecheck, lint0errors165baselinewarnings, staging, both frontends and combined921inventory/contracts. [Private journal](native-attachment-journal.md) records facts versus capabilities, capacity/refusal and proof limits; revision evidence follows in issue-214-protected-attachment-journal-local-20261018.json. The scoped Linux mobile handoff bd898f99 is preserved; incoming payload/full-array and non-Linux execution refusals remain. Automatic orphan collection, the separately audited whole-task recursive-cleanup bridge, installed supported-target acceptance and202/208 prerequisites remain open. No public operation/grant, native voice, identity/scheme, release/profile cutover or Electron retirement change. Hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

Native message-intent receipt continuation (#209): plain task messages now invoke one retained Source send owner with the original nonce, without renderer pre-start/resume; incomplete cached agent identity continues through sendByTaskId until actual status supplies it. Current question answers require exact live session/request/type and cannot resume historical questions. Captured view/connection/send tokens fence late acknowledgements and raw failures; one owned timer cannot clear a replacement send, and document retirement releases indicators without claiming to undo admitted Source prompts. Kickoff/composer text survives uncertain receipts with explicit review rather than replay; optional unavailable voice housekeeping is omitted and its promise is owned. Eleven old-source behavior controls fail before repair, plus an actual composer run exposes two unsupported-voice unhandled rejections; own fixture typing and incomplete-cache failure were repaired. Final adopted runner passes2028renderer cases/156files and152affected cases/6files without skips, including actual Source/protected-file owners and two staged stdio entry proofs; the earlier563-case/18file integration baseline is recorded separately before the last UI-only cache guard. Forced typecheck, lint0errors165baselinewarnings, staging, production+shipping/mobile builds and920inventory/contracts pass. [Renderer recovery](production-renderer-recovery.md) and issue-209-native-message-intents-local-20261018.json record exact receipts and limits. Existing test commands retain their meanings. No Source/native/public operation/grant or voice availability change; scoped Linux mobile execution remains with #219. Completion/feedback/create/delete/move and delayed AutoRun receipt audits, exact-root Fresh, durable unknown delivery review, installed supported-platform UI and #202 prerequisite remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

Mobile protected attachment execution continuation (#219): Linux saved-file start, routed subtask/group start, resume, send and current permission/question replies now delegate through the retained desktop session backend and the same captured manager/FileOwner execution path. The original paired request, task/project/agent/parent graph, ordered metadata, active memberships and live session identity remain fenced across raw awaits. Incoming nonempty file payloads and attachment-array writes remain refused; macOS/Windows saved execution stays unavailable. Acknowledged admission queues keep their existing Source lifetime; raw HTTP/FD cleanup remains joined after disconnect and failed bounded close. Complete canonical manager task-update records now use the existing public task projection before the unchanged strict event codec, repairing group/subtask root shutdown without exposing private columns or accepting malformed partials. The adopted pinned runner passes 237 Source/staged/host cases in ten files, including 71 mobile-root variants and two actual entry cases, plus 121 mobile-client cases in eleven files, all without skips. Forced typecheck, lint (zero errors/165 baseline warnings), staging, mobile/diagnostic/production frontend builds and 920-file inventory/contracts pass. Two old-code behavioral controls fail as expected; initial fixture/type/event/guard-cost and inherited parallel-deadline failures are retained in revision evidence. The final gate serializes workers without changing assertions or deadlines. [Mobile ownership](mobile-production.md) and issue-219-mobile-attachment-execution-local-20261018.json record scope; installed/device/LAN/public tunnel, native tunnel authority, platform and #208/#210/#202 prerequisites remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

Native manual task/session receipt continuation (#209): actual typed-native controls reproduced duplicate Triage writes, rollback after an uncertain accepted status, assignment after failed switch, unassignment before Stop and old connection/Stop replies clearing replacements. Start/Resume/Triage/assignment now share a synchronous captured-view lane; Triage sends one canonical status write, handoff uses manager-owned switch plus readback without another assignment, and unassignment joins finite true Stop. Unknown receipts require canonical review without replay/rollback. A local session identity survives actual transcript hydration and preserves newer live/pending requests; finite false Stop/abort/approval are refused. Native Fresh/Restart is explicitly unavailable before Stop, local session removal or runtime-field writes pending an exact-root Source contract (#212); Electron keeps its existing Fresh behavior. Enabled AutoRun observes poll/disconnect heartbeats without idle/triage work. Eleven old-source negative controls fail before repair;61native workspace and36activity/session controls pass. New published/reviewed host-neutral runner passes the full renderer project2004cases/156files and402affected cases/15files0skip, including actual protected-profile Source owners and two actual staged stdio entry proofs; forced typecheck, lint0errors165baselinewarnings, staging, production+shipping/mobile builds and920inventory/contracts pass. Existing test:run/test:tauri meanings remain unchanged; eligible574-file runner graph is not claimed as fully executed by these project/filtered runs. Domain details in [renderer recovery](production-renderer-recovery.md); revision evidence follows in issue-209-native-task-session-actions-local-20261018.json. Send/completion/delete/move and delayed AutoRun lifetimes, durable unknown mutation reconciliation, installed supported-platform UI and #202 prerequisite remain open; no Source/native/public operation/grant or mobile saved-file/voice availability change. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

#222 standalone test continuation: an additive full-cohort launcher audits every test's literal Electron dependency graph, runs main/shared/renderer/mobile under physical pinned Node22.23.2/ABI127 with actual staged SQLite/PTY loads, and isolates reviewed historical Electron host/credential/transition tests. Eighteen domain suites now use the existing portable fixture without changing assertions. The complete local baseline on inherited2563e3c9 plus this tooling passes7080cases/3optional installed speech-runtime skips in569files,30foundation cases/0skip and923historical cases/1Linux-unavailable PowerShell case in60files. The unchanged original command independently passes193affected cases/21files. Actual Source and staged-engine peers plus a hashed production stdio child reject27diagnostic requests; normal reads/ping/shutdown remain usable. Built production frontend and Source manifest hashes are checked against the diagnostic positive control. Native handler/feature/plugin checks are source policy, not installed-binary proof. After inheritingf24d70e0,144affected Source/production/private-peer controls pass0skip with refreshed staged artifacts, forced typecheck/lint and920inventory/contracts; the reviewed cohort is now574host-neutral files (571Vitest+3node:test) and60historical files. Existing test commands/configuration meanings remain unchanged pending published replacement review by both peers. The new four-target workflow is manual/master-only, explicitly source-scoped and has not run. [Standalone tests](standalone-tests.md) records pins, receipts, exclusions and provenance; revision-bound evidence follows in issue-222-host-neutral-local-20261018.json. Installed native UI harness/production-native artifact acceptance, platform execution and CI remain open. Hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

Source protected attachment execution continuation (#214): actual production-owner negatives reproduced saved-file/workspace symlink copying and workspace preview reads; a retained-agent caller-withdrawal control also observed a prompt before late reply refusal. The production manager now captures a private Source execution port: saved bytes stay behind held no-follow FDs, Linux destination publication uses held directory FDs/exclusive staging/readback verification, and previews use bounded protected saved bytes. Original task/project/agent/parent/group/metadata request scopes fence raw work and queued intents; admitted prompt acknowledgements preserve durable nonce receipts after cancellation. Start/resume/send/question paths share this owner; no ambient-path fallback or public operation/grant is added. Unsupported platform saved-file execution and mobile saved-file start/resume/send remain refused pending equivalent authority/review. Eighteen direct owner controls,10actual production-root controls and the private selection/CAS/execution graph pass, including the actual staged production engine. Final combined1063app/44files and582bundledNode/23files0skip, forced typecheck, lint0errors165baselinewarnings, staging, bothfrontends and inventory/contracts pass. Existing stale heartbeat delivery and ordinary accepted-send nonce controls both remain green after the recorded compatibility repair. Peer rebase onto2563e3c9 also passes201app/201bundledNode, forced typecheck, lint, bothfrontends and combined920inventory/contracts; revision evidence follows in issue-214-protected-attachment-execution-local-20261018.json. [Execution authority](native-attachment-execution.md) records accepted-copy/raw drain limits, caller/metadata capture and remaining orphan/hard-crash/platform proof; no whole issue acceptance or live provider/native voice enablement is claimed. Hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

#209 task metadata receipt continuation: actual typed-native rename, description and lifecycle-status controls reproduced two db:updateTask requests for each single fallback intent. These and recurrence flags now use one awaited store mutation, while supplied app/canvas callbacks reject missing receipts. Native store publication validates the captured connection and exact returned task ID. Inline title/description preserve local text during pending replies and canonical refresh; synchronous admission covers Enter/blur, keyboard/button and submit/Escape races. Uncertain/refused/retired replies require explicit reopen/review without replay. Status, recurrence flags, next-subtask and skill-default choices own their asynchronous outcomes; fallback skill selection now persists. Task replacement keys, project/pagehide/connection retirement fence late callbacks and release observations. Own raw gate1999renderer/158files and255standalone/7files0skip includes41actual typed-native hierarchy/metadata controls (24new), forced typecheck, lint0errors165baselinewarnings, staging and production/shipping/mobile builds pass. Combined inventory919/contracts is checked after serialized metadata release. [Renderer recovery](production-renderer-recovery.md) and issue-209-native-task-metadata-local-20261018.json record the three old-source failures and initial alert/fixture repairs. No Source/native/public operation/grant or attachment CAS/removal semantic change. Separate triage/start/resume/assignment receipt audit, installed/platform/unknown mutation acceptance and202 prerequisite remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

#209 native removal UI continuation: the existing exact-ID remove published by E2 at8244c0ad is consumed once, followed by canonical read-only snapshot reconciliation after acknowledgement or partial cleanup refusal. Native UI issues no second full-array update or unlink replay; unchanged/unknown canonical state and cleanup refusal require review. View/project/modal/pagehide/connection retirement fences followups and releases observers. Edit drafts retain text, original CAS baseline and other known unsaved copy receipts until explicit close; only the confirmed removed ID changes locally, and Save requires canonical review. Admission closes synchronously before React paints disabled controls: a real coalesced native-offer regression reproduced one unexpected save and now proves zero accept/save. Sixty-one actual typed-native attachment controls pass (16new), with three old-UI failures plus own draft-receipt/race repairs recorded. Baseline full1972renderer/158files and292standalone passed before those last repairs; final86affectedapp/295standalone0skip on inheriteda8b01ede/fea7040e, forced typecheck, lint0errors165baselinewarnings, staging, both frontends and inventory918/contracts pass. [Renderer recovery](production-renderer-recovery.md) and issue-209-native-attachment-removal-ui-local-20261018.json distinguish controlled UI receipts from actual protected-file Source tests. Electron legacy remove/metadata behavior remains; no Source/native/public DTO/grant change. Only pre-unlink refusal guarantees retained bytes; no filesystem/SQLite rollback or orphan/removal journal claim. Installed/platform/unknown receipt acceptance, fallback metadata duplicate-write repair and202 prerequisite remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

#219 mobile source/configuration continuation: authenticated legacy source create/configuration/options and explicit sync now use the same production TaskSourceBackend/TaskSourcePluginBackend, encrypted storage and SyncManager as desktop. Returned source rows omit config; masked secret round-trips and resolver redaction retain the exact paired request through held raw work. Sync-all starts sequentially and stops later work on withdrawal; parent edits use the real task exclusion/reference owner. E2 established that saved metadata is not protected attachment execution authority: mobile start/resume/send now refuse saved attachments even with empty arguments, including routed subtasks/current group members, and recheck the captured graph across manager awaits. No FileOwner bridge or global desktop/manager policy is invented; nonempty create/send and incoming arrays remain refused pending #214. Own full raw gate203app/121mobile/258bundledNode0skip,2actual entry/14contract-resource controls, forced typecheck, lint0errors165baselinewarnings, all three mobile/preview/production frontend builds and918inventory/contracts pass. Fifteen actual Source-root cases and29bundled-run cases include14compiled-root variants; seven old-code controls fail. A final plain-language refusal wording change repeats the affected source/staged peers and resource closure. Exact scope and receipts are recorded in issue-219-mobile-source-effects-local-20261018.json. The first continuation's independent client/pairing/projection/tunnel evidence remains scoped; installed/device/LAN/public tunnel/Actions and #208/#210/#202 prerequisites remain open. Native voice and hosted voice availability stay unchanged. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

#209 task hierarchy continuation: parent navigation validates the captured literal parent/project, retires replacement/project-return/pagehide replies and rehydrates once per ready connection generation with listener disposal. Subtask create retains and freezes its title through the exact child receipt and canonical readback; reorder requires a true receipt and readback without optimistic order. One synchronous UI lane prevents duplicate add/reorder, and missing/refused/uncertain replies require explicit reopen/review without replay; a cancelled draft cannot unlock another unknown create. Native Captain/shared-group rows expose no ordinary subtask mutation control. Seventeen actual typed-native component controls pass, including two corrected old-source failures; full1959renderer/158files and225standalone/6files0skip, forced typecheck, lint0errors165baselinewarnings and both frontends pass. Reconnect test exposed and repaired duplicate ready-notification reads; an initial ambiguous Add selector was repaired before the old-source proof. Combined inventory918/contracts freshness is repaired after serialized metadata release. [Renderer recovery](production-renderer-recovery.md) and issue-209-native-task-hierarchy-local-20261018.json record controlled DndContext/receipt limits; no installed physical drag/UI claim or Source/native/grant change. Inherits E2 metadata-first removal8244c0ad; A native no-second-write/readback/form-review integration follows separately, and orphan journaling remains open. Installed/platform/unavailable-operation acceptance and202 prerequisite stay open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

Source exact-ID attachment removal continuation (#214): a separate actual Source/SQLite regression reproduced bytes deleted before a later stale metadata CAS refused, leaving a dangling record. Production retains attachments.remove(taskId,attachmentId):Promise<void> but owns its exact-ID logical metadata delta under the existing task exclusion, publishes accepted canonical metadata before raw cleanup, and joins actual unlink without inventing rollback or replay. Other records/fields survive; full-array CAS and metadata-only save remain unchanged. Direct protected-filesystem controls cover rejection before deletion, held unlink/cancellation/drain and siblings; private-peer controls include actual kernel unlink permission denial and canonical event/readback after the partial cleanup error. Existing last-activity events are kept distinct from the exact removal metadata event. Raw local gate335app/338standalone0skip, forced typecheck, lint0errors165baselinewarnings, staging, both frontends and inventory918/contracts pass; revision-bound evidence follows in issue-214-source-attachment-removal-local-20261018.json and [removal receipts](native-attachment-removal.md). A owns native removal UI canonical readback/manual review and removal of the second metadata write after publication; orphan/removal journaling, hard-crash and installed/platform acceptance remain open. No new API/operation/grant/native authority or atomic filesystem+SQLite claim. Hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

#209 native Drop/CAS UI continuation: one captured document observer selects exactly one visible ordinary task/draft context, takes receipt ownership synchronously, waits for acceptance and joins sequential copies plus explicit metadata before group close. Draft groups survive task creation/import; ambiguous, hidden, modal-obscured, busy, over-capacity, nonordinary and retired contexts cannot consume. Native DOM paths stay inert. Exact full canonical attachment baselines are cloned before asynchronous saves and passed separately through detail/composer/draft/edit callsites; canonical refresh never silently refreshes a stale replacement intent. Uncertain form saves require close/review, and late acknowledgements cannot close same-task replacement dialogs. Forty-five actual typed-native UI controls pass (24new), full1942renderer/157files and281standalone/10files0skip, forced no-emit typecheck, lint0errors165baselinewarnings, both frontends and inventory918/contracts pass. Actual protected-profile CAS9controls are included separately from controlled UI receipts; no installed Wry-to-Source/UI graph is claimed. The staging gate initially lacked this worktree's credential helper; actual helper build/staging and corrected Cargo target path repaired it. [Renderer recovery](production-renderer-recovery.md) and issue-209-native-drop-cas-ui-local-20261018.json record limits. Source metadata-only save is unchanged; native remove-then-full-array replacement remains a known separate interleaving gap awaiting E2 metadata-first exact-ID Source publication, with no atomic-removal/rollback or orphan-journal claim. Installed/platform/native unavailable operations and202 prerequisite stay open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

#219 production mobile continuation: a private HTTP adapter delegates ordinary task create/update/order and explicit source completion to the same production task backend, borrowing the single SQLite/AgentManager/SyncManager/scheduler graph. Paired token and exact server lifetime fence raw effects; scoped HITL requires a current handled permission/question receipt, fixing stale-ID HTTP success. Public task projection excludes private MCP/checklist storage, canonical task events publish once, and direct speech/TTS broadcasts are excluded. Actual protected-profile production peers plus loopback HTTP/WebSockets exercise controlled Pi processes, admission, source refusal/withdrawal, disable/quit and durable restart without blind session replay. A real contained tunnel process is tested both at its core and composed into the Source root; native quick-tunnel authority remains unavailable, with no public tunnel. The independent web client keeps exact production HTTP(S) origin/ports and rejects late callbacks from replaced sockets. Mobile attachment arrays remain refused rather than inventing a CAS baseline; inherited `8679abc5` preserves metadata-only save and explicit replacement semantics. Revision-bound counts, raw gates and repaired validation mistakes are in issue-219-production-mobile-local-20261018.json; the initial selected legacy tests briefly bound synthetic all-interface listeners, then were corrected to assert requested LAN policy through actual loopback-only sockets and rerun. LAN/device/public-tunnel/installed-platform and disabled hosted Actions acceptance remain open, as do #208/#210/#202. Native voice and hosted voice availability stay unchanged.

Attachment metadata CAS continuation (#214/#210): an actual Source/SQLite regression reproduced loss of the first acknowledged metadata append when a second editor submitted its stale full array after both metadata-only imports succeeded. The existing db:updateTask now accepts a separate optional `{attachmentsBaseline: FileAttachment[]}` precondition, required for production attachment-array replacement. Source compares every canonical field and exact array order under the existing task exclusion before Stop/prepare and again inside the write transaction; malformed/missing baselines reject, stale baselines reject without accepted task/scheduler events, copy rollback, merge or replay. Field-only writes and metadata-only save remain unchanged. Native request validation and generated signature carry the same finite contract, with no new retained operation/grant. [Attachment selection](native-attachment-selection.md) records error semantics and raw Stop limits. Own raw gate passes308app/311staged0skip (including2existing actual staged-entry controls),152engine with6existing opt-in ignores and production-only compile; final affected rerun308app/73staged0skip, forced raw typecheck, lint0errors165baselinewarnings, both frontends and inventory916/contracts pass. Initial new test typing and incorrect lock-queue fixtures were repaired without changing manager semantics or weakening checks; revision evidence follows in issue-214-210-attachment-metadata-cas-local-20261018.json. A owns captured-baseline UI integration after publication; protected orphan-copy reconciliation and installed/platform acceptance remain open. Hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

#209 task-source form continuation (`93d658bc`): actual integrations create/update waits for exact accepted receipts, captures the original project/dialog intent and fences duplicate or uncertain saves. Project change/return retires the draft synchronously; late replies cannot close a replacement and canonical refresh preserves edits. Plugin list/documentation reads retain selection/document/connection and release observers on pagehide/unmount; explicit sync uses one store-owned canonical readback. Published Source has no general OAuth public handlers: native HubSpot/Linear forms and direct OAuth dialogs show unknown/unavailable without bearer refresh, callback registration, browser start or exchange. Separate captured connector OAuth authority is unchanged. Nineteen new actual typed-native controls pass (57catalog/form total); seven old-source negative controls fail. Full1918renderer/157files and77staged/4files, forced typecheck, lint0errors165baselinewarnings, both frontends and regenerated inventory916/contracts pass. Existing interaction fixtures now acknowledge asynchronous receipt; invalid cross-plugin fixtures and stale inventory were repaired without weakening checks. [Renderer recovery](production-renderer-recovery.md) and issue-209-native-task-source-form-local-20261018.json record exact scope. No Source/native/DTO/grant change or installed UI claim; Drop UI, attachment CAS integration/orphan reconciliation, platform and202 prerequisites remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

MCP form receipt continuation (a0153cce, #209): actual MCP settings create/update waits for the exact accepted receipt, freezes pending fields and blocks duplicate or uncertain replay while retaining the draft. Monotonic dialog intent/key plus document/connection guards prevent old replies closing or unlocking a replacement; canonical refresh preserves unsaved edits. Cancel never claims to cancel admitted Source work. Accepted current CRUD clears prior errors; native browser authorization remains unavailable. Ten new actual typed-native controls cover create/update/refusal/unknown receipt/duplicate submit/refresh/replacement/reconnect/pagehide/error clearing; corrected four-control old-source negative fails and repaired source passes. Full1882renderer/55staged baseline and inherited native Drop affected164app/166staged, forced typecheck, lint0errors165baselinewarnings, both frontends and inventory916/contracts pass; revision evidence records the gate wrapper repair and late combined verification in issue-209-native-mcp-form-local-20261018.json. Installed supported-platform lifecycle, Source durable mutation reconciliation, attachment full-array CAS reproducer/contract and #202 prerequisite remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

Native attachment Drop continuation (#215/#214): an actual OS drop captures the original acknowledged opaque UI context and physical document before awaits, then retains no-follow file descriptors and offers only private one-shot Source selections. A document-bound monotonic revision rejects delayed registration arrival and completion; replacement/null synchronously fences old admission and joins per-group Source/native cleanup before acknowledgement. Facade-local accept records ownership synchronously and native reads remain denied until its exact receipt; ignored/ambiguous/failed observers and the real15s unaccepted deadline retire offers. Close joins raw capture/accept/import/timer/FD work, remains usable for its old receipt, retains failed cleanup for retry and preserves accepted destination copies/unrelated flows. Separate stamped native event/optional API audit adds no retained Source operation/event/grant; all331existing operation rows/references/policies remain identical. Own raw gate305app/328staged0skip,151engine with6existing ignores,94host with4explicit GUI ignores, separate actual Linux GTK/Wry OS-drop and window proofs each1pass, forced typecheck/lint0errors165baselinewarnings/Linux+MSVC/both frontends/inventory916/contracts pass. The OS proof exposed and repaired a keyboard-focus assumption: the actual drop target remains valid while focus stays with the drag source. It uses a synthetic Source epoch/cleanup bridge; installed Wry-to-production-Source/UI acceptance is not claimed. A owns UI activation after publication. [Native Drop authority](native-attachment-drop.md) records limits; revision-bound evidence follows in issue-215-214-native-drop-local-20261018.json. Explicit full-array attachment metadata CAS remains A audit/E2 actual Source reproducer pending, and orphan-copy reconciliation remains open; metadata-only save semantics stay unchanged. Native voice/identity/installed platform and whole214/215 criteria remain open. Hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

#210 production domain-effects continuation: actual protected-profile ProductionService/private peers now retain caller grants across each raw agent/secret/subtree Stop, preserve CANCELLED replies, await real configuration notification while retaining every not-yet-refreshed backend fence, and refuse stale default-endpoint model replies/cache publication. Codex model-list spawn failure rejects pending RPCs and joins cleanup; recurrence task creation projects public fields before exact events so a private MCP nonce cannot disconnect the service. Actual learning syncs a workspace skill before completion; recurrence/snooze, source acceptance/refusal/withdrawal, daily session FIFO and real Chat/Commander/briefing credential drains are proven with controlled providers and synthetic profiles. Own raw gate passes258application/264bundledNode tests without skips,108actual checkpoint/source assertions,5resource-staging,2actual production-entry and7contract tests, forced typecheck, lint0errors165baselinewarnings, both frontend builds and inventory/contracts freshness. Revision-bound evidence follows in [domain effects](production-domain-effects.md) and issue-210-production-domain-effects-local-20261018.json. Agent CRUD/configuration/model-list Source is complete on Linux for the retained contract; full-array attachment CAS/receipt reconciliation (#214/E2 reproducer pending) and daily_token_cap accounting remain exact Source gaps and native-dependent settings remain refused pending #215/#218 authority. Installed/platform/authenticated-provider/remote-source acceptance and #202 remain open. Native voice stays unavailable. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

#209 demanded resource-catalog continuation (`926552c5`): MCP and task-source metadata use bounded snapshot/read-only reconnect owners with accepted CRUD invalidation, same-ID dedup and document/connection retirement. Native MCP mount/recovery never automatically probes, spawns a test or starts browser sign-in; explicit tests retain original configuration revision, including masked-credential rotation with identical public fields/timestamp. Status metadata reads are sequential and unknown on failure. Explicit source sync joins one public request and canonical task/source readback with stored timestamp; sync-all is sequential and withdraws later starts on project/connection change. Twenty-eight actual typed-native controls plus seventeen legacy controls pass; full1871renderer/156files and668staged/38files baseline, final45app45staged plus exact-owner cleanup28app/28staged, forced typecheck, lint0errors165baselinewarnings, both frontends and inventory914/contracts pass. Exact final counts/revision/proof limits are in issue-209-native-resource-catalog-local-20261018.json (evidence follows). A carries only E2 authorized future portable include paths for native Drop helper/DTO; no Drop/UI activation or Source/native/public DTO/grant change. [Renderer recovery](production-renderer-recovery.md) records scope; installed supported-target lifecycle and202 prerequisites remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

#209 production project/overdue renderer continuation (`b6bfe258`): the native facade applies published production project configuration codecs last, retaining full editor agent/provider/limits/Captain wake-up/review fields and the existing Source concurrency owner. Saves capture editor+connection lifetime, join child writes sequentially and stop follow-up effects on replacement; canonical events preserve unsaved drafts. Accepted project identity survives partial failure; Save remains fenced until explicit canonical reopen/review, without uncertain write replay or guessed ID. Actual retained overdue empty event now reaches typed snooze/notification consumers; pagehide/unmount retires queued effects/timers/subscriptions and notification refusal is owned. Sixteen actual typed-native project controls and eight advisory controls pass; full1844renderer/155files,624staged/35files,21contracts, forced typecheck, lint0errors165baselinewarnings, both frontends and inventory914/contracts pass. [Renderer recovery](production-renderer-recovery.md) records non-atomic save/review limits; revision-bound evidence follows in issue-209-native-project-overdue-local-20261018.json. No Source/native/public DTO/grant/voice availability change or installed physical UI claim. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

Private attachment selection-group retirement continuation (#215/#214): native cleanup names only the original document lease and up to16 exact selection IDs. Source synchronously fences the entire validated group, tombstones late offers, joins actual raw read/native retirement and preserves unrelated selections; failed retirement stays cancelled for retry. Native validates exact private receipts and refuses public dispatch. A producer scope refusal now survives protected destination rollback with its finite error instead of becoming an I/O failure. Actual private-peer/SQLite controls prove unchanged task metadata and an empty rolled-back destination. Own raw gate162app/183staged0skip,150engine with6existing ignores,86host with3explicit GUI ignores,forced typecheck/lint0errors165baselinewarnings/MSVC/freshness pass; the additional native stopping-cleanup regression passes separately (1case). No GUI case is newly claimed here. Evidence follows in issue-215-214-selection-group-retirement-local-20261018.json. Public native Drop stays unavailable pending exact original UI-context capture, acceptance/close receipts and bounded ignored-drop cleanup agreed with renderer owner A; browser paths grant no authority. Remaining attachment journaling, native services and installed platform criteria stay open; hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

#209 skill/secret metadata continuation uses bounded coalesced list snapshots, accepted-receipt invalidation and same-ID create deduplication. Only the captured document/connection publishes writes/errors; demanded metadata caches join strict read-only native recovery, while unused caches issue no reads. One document-owned exact `skills:changed` subscription replaces the sidebar-only listener and serves task/agent selectors, preserving Source old/new project-scope filtering. Twenty actual typed-native controls plus fifteen existing skill controls cover list/receipt/event races, first-write demand, bounded invalidation, both failure barriers and retirement/replacement. No credential values, OAuth/probe/sync, Source/native/grant change or mutation replay; [renderer recovery](production-renderer-recovery.md) records scope. Source `cf260669`; full renderer1820/153files, staged583/31files and21contract controls pass; rebase159app/159staged, forced typecheck, lint0/165existingwarnings, both frontend builds and combined inventory914/contracts pass. [Revision-bound evidence](evidence/issue-209-renderer-metadata-local-20261018.json) records failure repairs and proof limits. Installed native UI/credential/platform acceptance remains open; hosted Verify unavailable: repository Actions disabled, awaiting user decision.


The #210 production project continuation accepts the existing full editor fields
through a separate bounded codec and the actual SQLite/AgentManager owners.
Captain edits join exact teardown before changing selection, preserve audited
concurrency, recheck current task/session/agent/project authority and reconcile
the real start queue. Private old/new skill scope receipts preserve project-only
invalidation, deletion and scope moves without expanding the public event DTO.
The existing single overdue timer now delivers a scoped, exact empty advisory
through the private peer, with no task transition/start/replay and clean shutdown.
Every current retained #202 row is listed separately by runtime, codec,
authorization and observed proof in the revision-bound reconciliation evidence;
registration is not parity. See [production project configuration](production-project-configuration.md).
Renderer facade/editor integration is a #209 handoff; installed supported-target,
live-provider and remaining native/settings effects and #202 remain open.
Hosted Verify is unavailable: repository Actions disabled, awaiting user decision.

Linux native media denial continuation (`21b85e14`, #215/#214): the production WebView first commits a fixed inert blank URL, verifies no active native capture, disables MediaStream/WebRTC, then navigates to trusted app code with physical-window/admission rechecks. Blank pages mint no document lease; failure shows fixed native wording and post-settings close joins raw work without app navigation. Actual isolated Wry uses mock devices only: live capture/stop positive control, first-app-script denial, failure and close controls pass. Own gate306app/306staged/73entry,148engine with6existing ignores,86host with3explicit GUI ignores; media/window Wry each pass separately, raw forced typecheck/lint0errors165baselinewarnings/Linux+MSVC/both frontends/freshness pass. Inherits A saved-image read-only hydration repair and repeats its real facade/transport/Markdown controls. Evidence follows in issue-215-214-native-media-denial-local-20261017.json. Native voice stays unavailable; existing stream/persisted-grant ownership and installed supported-platform acceptance remain open. Hosted Verify unavailable: repository Actions disabled (actions/permissions enabled:false), awaiting user decision.

#209 saved-raster Markdown continuation consumes the published optional native image read using literal saved IDs and the current physical-document receipt. The renderer creates only validated bounded raster blob URLs, keeps native legacy links inert with existing Open/Download guidance, and preserves Electron scheme behavior. One document-wide pool bounds concurrent/queued reads, resident images, encoded bytes and admitted canvas/frame pixels; visibility, generation, unmount/pagehide/HMR/reconnect and decode-failure cleanup release owned previews. Twenty-four actual typed-native React controls include a reconnect consumer regression that found and repaired the missing read-only client classification, while native mutation recovery remains fenced. [Renderer recovery](production-renderer-recovery.md) records exact budgets and limits. No raw scheme/native voice authority enabled; installed WebView decode and platform acceptance remain open. Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

The #209 active-view continuation joins mounted overview/project-group lists and retained group snapshots in the native durable recovery barrier. Reference-counted sources retire listeners/timers and queued reads on last release, pagehide and HMR; replacement cohorts are joined in bounded passes, failed reads keep mutations fenced, and accepted group writes invalidate snapshots without replay. The existing overview debounce/poll and heartbeat early return remain. Thirteen new typed-native controls (27 total collection recovery controls) cover all three read-failure paths, accepted-write/list races, replacement/unmounted views and shared-reader publication/disposal races. Full1773 renderer/447 staged/20 contract tests, forced raw typecheck, lint0errors165baselinewarnings, both frontends and inventory906/contracts freshness passed; rebase inherits raster4fd1780a and reruns affected inputs. [Renderer recovery](production-renderer-recovery.md) records scope; revision-bound evidence follows. Installed/native/platform acceptance remains open; hosted Verify unavailable: repository Actions disabled, awaiting user decision.

The #215/#214 saved-raster continuation adds optional native-only
`attachments.readImage(taskId, attachmentId)`, with exact saved metadata/read
scope and held no-follow FD authority. Native stamps and rechecks its current
physical document; Source obtains the exact native snapshot before/after each
bounded read and rechecks captured task/project/group/agent scope after awaits.
Cancellation and queued reads remain owned through native callbacks and FD close.
Full PNG/JPEG/GIF/WebP container checks bound compressed bytes, canvas/frame
pixels and parser work before browser decoding; SVG/HTML, APNG, animated WebP,
unknown/compressed PNG metadata and raw scheme fallback remain unavailable.
The reviewed catalog adds one native-only optional operation without invented
Electron IPC evidence or changed existing policies. Engineer A owns bounded
Markdown/UI integration after publication. See [saved raster authority](native-saved-raster.md).
Native drop, metadata-only orphan reconciliation, global shortcuts/login items,
voice permission/raw-stream revocation and installed/platform acceptance remain
open; identity/schemes and hosted Actions await user decisions.

The #218 final-transcript continuation adds a Source-only production action
owner: deterministic intent, exact turn/epoch confirmation and dismissal,
bounded timeouts, offered choices, captured dictation/navigation and exact
native HITL request scope. Effects delegate to the same task/agent backends as
the UI; canonical task events cross the actual private peer, and starts use the
single manager's admission, durable FIFO and project limits. Accepted queued
starts survive turn disposal. Raw startup/write work remains owned through
cancellation and failed drain. This closes the Source voice-start branch of
#212 criterion 2, with no whole-criterion claim. The entry point is unregistered;
production voice/native permission/capture/playback/shortcuts remain unavailable.
See [transcript action ownership](voice-transcript-actions.md). Linux regressions
use synthetic transcripts, isolated controlled Pi processes and the actual
staged bundled engine; no microphone, hosted provider or live account is used.
Hosted Verify unavailable: repository Actions disabled, awaiting user decision.

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
process trees, native action binding, custom directory/native selection and
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
