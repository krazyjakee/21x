# Migration validation, rollout, and recovery

Status: acceptance plan; matrix rows below are unexecuted until implementation evidence is attached. Use the [task cards](workstreams.md) and [architecture](architecture.md) for ownership and prerequisites.

## Platform and fixture matrix

Match current release architecture coverage, then set minimum OS/WebView versions from tested compatibility rather than relying on the development machine:

| Target | Required environment and artifact |
| --- | --- |
| macOS x64 | Intel machine/runner, packaged app/DMG and selected update/download artifact; native permissions, workers and WebKit tests |
| macOS arm64 | Apple Silicon machine/runner, architecture-correct native resources and workers; same scenarios as Intel |
| Windows x64 | NSIS install on a clean user account; WebView2 bootstrap/availability, PTY, paths, permissions and child-process teardown |
| Linux x64 | AppImage on the chosen supported distribution/desktop; WebKitGTK dependencies, executable permissions, PTY and secret-store availability |

Each target runs development and packaged smoke checks; native parity must be demonstrated in the packaged app. Built-in runtime tests remove system Node from PATH. Installed agent CLIs, Git/provider CLIs, optional speech runtime/models, and integrations retain their existing explicit prerequisites.

Fixtures cover: fresh profile; current schema-32 profile; representative supported older schemas and old 20x identity; multiple projects/Captains; large transcripts; active/queued tasks; skills/secrets/MCP configuration; attachments/worktrees/artifacts; connected sources and encrypted credentials; connector instance KV; voice installed/uninstalled states; and paired mobile clients. Validate fixtures with the current application before using them as migration evidence. Keep real account credentials out of repository fixtures and use local synthetic secrets for native encryption tests.

## Feature parity matrix

For every row attach test/report location, OS/architecture, build version, fixture, and result. A blank cell is not a pass. Deterministic stubs establish contract regressions; installed backend/provider smoke checks establish actual integration compatibility.

| Area | Required scenarios and assertions | Task owner |
| --- | --- | --- |
| Profile/database | Open current/older profiles; run supported migrations; preserve task/project/skill IDs and settings; WAL/foreign keys/busy timeout; detect corrupt/locked data; no concurrent host writer | T10 |
| Credentials | Round-trip every stored format; OAuth refresh remains usable; API keys/secrets injected correctly; connector session/persistent modes; locked/unavailable/corrupt store errors; legacy plaintext upgraded by explicit policy; no leakage | T03/T10 |
| Desktop/task UX | Window state/chrome, navigation rail, theme/zoom, shortcuts, tray/menu, close/reopen/quit; create/edit/delete/search tasks and projects; drag/drop/subtasks, priorities, recurrence/snooze/overdue behavior | T07/T08/T13 |
| Agent backends | OpenCode, Claude Code, Codex app-server, Cursor ACP, Pi: create/resume/send/abort/stop/status/health; configuration/models/auth; stream parts and tool errors under bundled runtime | T09 |
| Approval and handoff | Approve/reject/questions bound to correct request/session; reload while pending; manual switch and quota fallback retain recap; no automatic mutation replay on disconnect | T09/T13 |
| Admission/background | Per-agent/global/project limits, FIFO starts, pause/daily caps, project scope, Captain/triage/heartbeat exemptions; hidden/recreated window does not suspend or duplicate engine work | T05/T09 |
| Durable transcript | Snapshot plus delta race, repeated/out-of-order revisions, `reloadRequired`, large record/chunk recovery, engine epoch change, idle/completion state, reload/reconnect without duplicate/lost parts | T06/T08/T13 |
| Projects/Captain/skills | Durable per-project Captain and recovery; no coordinator rows in task lists; project repos/resources/skill scoping; triage; feedback/learning writes preserved | T09 |
| Schedulers/lifecycle | Recurrence, heartbeat, automation, coordination/wakeups, cleanup start once; survive hidden UI; stop on quit; no second owner after restart; interrupted shutdown recovers | T05/T09 |
| Git/workspaces | GitHub/GitLab/Forgejo CLI sessions and mapping, multi-repo worktrees, failures/fallback, compatible paths, safe workspace cleanup; unrelated processes/directories untouched | T09/T10 |
| MCP/task APIs | Authenticated HTTP and stdio task tools; rejected missing/wrong launch token; local/remote MCP tool scopes/OAuth; correct app-managed runtime paths; preserve user MCP entries | T06/T09/T10 |
| Task sources/connectors | Sync/import/export/actions, OAuth warm/cold callbacks, allowlist/pins, call-scoped KV/credentials, timeout/cancel/crash restart, minimal child environment and redacted diagnostics | T09/T13 |
| Terminals/Commander/chat | PTY create/write/resize/reconnect/buffer/exit/kill; ownership and PID guards; CLI resolution and shell environment; Commander/chat sessions and image attachments | T09 |
| Canvas/artifacts/files | Retained terminal/task panel lifecycle and layering; drawing/canvas persistence; sandboxed artifact previews; attachment URLs/drag-drop; read/open/reveal/download; image and file clipboard behavior | T07/T08/T11 |
| Browser retirement | No browser/webpage creation or live embedding, browser tools/routes/controls absent, retired operations fail explicitly; inert saved panel IDs/layout/URLs/edges survive repeated load/save; recording files and rollback backup unchanged | T10/T11 |
| Voice recognition/TTS | Optional runtime visibility/install/remove, model selection, microphone denial, global shortcut, dictation/commands, progressive recognition, speech cancellation/epochs, system/downloaded TTS, no audio to mobile | T07/T09 |
| Mobile/tunnel | Existing mobile build, pairing/auth/session revoke, task/session controls, WebSocket projection rehydrate, settings/tunnel lifecycle; no desktop bridge requirement | T09/T12 |
| Distribution/updates | Install/open on clean target; all native binaries/workers/resources present; system Node absent; framework install transition; second Tauri update/manual path; version/signature policy; uninstall preserves documented data | T12/T14 |

## Contract, security, and failure tests

Test the real privileged boundary in a packaged build, including attempted remote main-WebView navigation and sandboxed artifact frames. Verify denial for custom app commands as well as plugin calls; checking only a generated capability JSON is insufficient.

Required adversarial/failure cases:

- Unknown command, malformed/oversized frame, wrong protocol version, forged task/project context, attempted retired browser commands, path traversal/symlink escape, and unsupported external URL scheme.
- Main WebView navigation to remote content, iframe/artifact command attempts, untrusted popup/window creation, and remote-page attempts to read task/terminal/secret/native event data.
- Partial stdio frames, simultaneous requests in both directions, cancellation/timeout, late response after engine restart, queue saturation and channel teardown during component unmount.
- Host/service/worker crash and forced quit; process tree cleanup on each OS; next-start cleanup preserves unrelated user processes. Blocked keychain, missing native resource, denied microphone, missing agent CLI, low disk, locked database, and invalid import journal yield useful failure states.
- Interrupted/repeated credential conversion; interrupted update; downgrade attempted with incompatible credential format; a second Electron/Tauri process attempts to open the same live profile.

Verify that logs, error payloads, process arguments, exported reports, retained recording archives, and temporary migration storage do not expose synthetic canary secrets. Preserve existing connector security tests and bundle checks.

## Test tooling and evidence

Current scripts run Vitest under Electron with `ELECTRON_RUN_AS_NODE`, and `test/setup-main.ts` mocks Electron. T12 migrates host-neutral tests to ordinary Node and adds real Rust/transport/native integration checks. Keep existing renderer/mobile regression coverage and redesign Electron-launch UI checks such as navigation-rail and Commander-input tests for the chosen Tauri harness.

Tauri's current WebDriver documentation describes embedded WebdriverIO testing across Windows, Linux, and macOS; direct `tauri-driver` coverage differs. Select and pin the harness after a small packaged-app prototype. Do not count browser-only tests as native desktop evidence. Disable test/debug automation endpoints in production packages. [Tauri WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/).

Build CI should run lint/typecheck, host-neutral service/renderer/mobile suites, Rust checks, transport contract tests, connector allowlist/license/audit checks, packaged native smoke checks and the selected UI regressions. Exact new script names are implementation deliverables; until added, do not document hypothetical commands as runnable.

Performance evidence includes cold and warm start to interactive task list, total process-tree memory at idle and under multiple agent sessions, transcript/terminal latency and throughput, hidden-window behavior, shutdown time, installer/download size, and disk usage including bundled Node/native resources. Run Electron and Tauri against the same fixture, hardware, work, and repetition count; publish distributions and methodology. T00/T04 set regression budgets before claiming gains.

Each gate report records base/head commit, artifact checksums, OS/WebView/Node versions, fixture source/schema, command/harness, expected result, actual result, logs/screenshots where useful, and unresolved defects. Never attach live secrets. Keep separate evidence for each macOS architecture and packaged native integrations.

## Cutover and rollback

### Rehearsal and preparation

1. Retain the exact current Electron installer, any transitional credential-export/import build, matching profile fixtures, and Tauri release-candidate artifacts. Confirm that recovery can decrypt the retained legacy ciphertext under the existing identity/account.
2. Decide first-install mechanism, app identifier/schemes, native and update signing policy, manual/update feed routing, supported minimum platforms, and credential compatibility. Do not reuse an Electron release feed for Tauri binaries without a tested bridge.
3. Test against an isolated profile copy produced with SQLite's backup mechanism or after a clean stop/checkpoint. Preserve attachments/resources and path-sensitive worktree data; do not copy an active `.db` alone.
4. Rehearse current Electron → transitional build if required → Tauri candidate. Cover repeat launch, blocked/corrupt store, power/process interruption, and all credential classes on each OS.

### First live install procedure to document and test

1. Stop new starts and all running sessions/schedulers; shut down the old app and its owned workers/APIs/tunnel. Require an exclusive cross-host profile lock before opening data. A transitional Electron build must honor the lock or the procedure must prove the old host is stopped and cannot relaunch during conversion.
2. Create a consistent, access-restricted backup of the stopped profile and an import journal recording versions, source/destination, stages, and checksums without plaintext credentials. Keep the backup immutable.
3. Convert credentials through the proven private import path and open the candidate with compatible profile paths. Commit conversion and completion marker only after database integrity, critical row counts/IDs, resources, and credential verification pass. On failure, preserve the original and provide recovery instructions.
4. Verify task/project lists, transcript snapshot/delta, representative agent session/approval, worktree/attachment access, OAuth refresh, browser retirement/data preservation, voice state, and mobile reconnect before allowing new live work. A successful launch alone is not enough.
5. Enable normal work, record the cutover point, and retain backups and the supported transition tooling for the defined recovery window. Keep logs free of decrypted values.

### Rollback boundaries

| Situation | Supported recovery to prove |
| --- | --- |
| Before conversion commits | Stop candidate/children and restore the intact original profile; relaunch the matching Electron build |
| Conversion committed, no new live writes | Stop Tauri; atomically restore the complete pre-cutover profile and original credential format; relaunch retained Electron; verify schemes and resources |
| New live tasks/transcripts/source writes exist | Prefer forward repair or a tested reverse data/credential migration. Restoring the old snapshot loses local post-cutover changes and requires an explicit product/user recovery decision |
| Lost/unavailable OS credential store | Preserve ciphertext and backup; unlock/recover the original store or use the accepted reconnect path. Do not label unreadable credentials as successfully migrated |

External side effects such as source comments, issue status changes, git pushes, and agent actions are not undone by restoring SQLite. Record these boundaries in the recovery runbook. If reverse conversion is not implemented, label post-write rollback as unsupported; do not promise lossless downgrade.

### Release/update rehearsal

Test a second Tauri version independently of the initial framework transition. Signed updater delivery must cover valid, invalid, and missing signatures, wrong target/architecture, failed downloads, install/restart, and interrupted updates. A manual update policy must give a working download/install route and must not present unavailable in-app install controls. OS distribution signatures/notarization are tested separately from updater signatures.

Release only after G4 evidence and concrete artifacts have been reviewed through the normal release process. Publishing is a separate operational action from preparing or validating this migration. After the selected observation/recovery period, retire Electron shipping code through T15 while retaining required historical fixtures and transitional artifacts.

## Completion criteria

The migration is complete when all supported targets pass the feature, data, authorization, lifecycle, and distribution matrix; profile/credential transition and recovery are rehearsed; performance is measured against agreed budgets; the existing mobile client remains compatible; and production bundles/tests no longer require Electron. Update current architecture/setup docs to describe what was delivered, including any explicitly accepted scope or update-policy changes.
