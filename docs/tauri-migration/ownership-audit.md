# IPC ownership audit

Reviewed against `500fbbd` on 2026-10-12. This supplements the syntactic
[inventory](inventory.md); it assigns migration responsibilities without
granting permissions or declaring a complete command contract. Each family
below contains the literal channels in `inventory.json` with that prefix.

| Channel families | Accountable workstream | Proposed destination | Required validation |
| --- | --- | --- | --- |
| `db`, `task`, `tasks`, `project`, `projectRepo`, `projectResource`, `projectLimits`, `concurrency`, `captainRuntime` | Bridge, with Data for persistence and Integrations for scheduling | Node domain dispatch and durable event sink | Project/task scope, coordinator exclusion, admission controls, single writer, reload/refetch ordering |
| `agent`, `agentSession`, `agentConfig`, `transcript` | Bridge + Integrations | Node agent manager and transcript projection | Queued starts, approval identity, cancellation, reconnect deltas, recovery notifications, bounded output |
| `agent-installer`, `cliMcp`, `claudePlugin`, `mcp` | Integrations | Node CLI/MCP/plugin services; native callback for external authentication | CLI discovery without a system Node dependency, subprocess cleanup, tool permissions, credential redaction |
| `chat`, `commander` | Bridge + Integrations | Node chat/Commander runtimes, caller-scoped event sinks | Trusted caller, turn ownership/cancel, tool approval, session persistence, no cross-window transcript leakage |
| `settings`, `skills`, `secrets`, `connectors`, `plugin`, `taskSource`, `oauth` | Data + Integrations | Node domain services and injected credential/native URL callbacks | Masked settings, project skill scope, connector isolation, OAuth state/redirect validation, corrupt or locked credential stores |
| `github`, `gitlab`, `forgejo`, `git`, `worktree`, `workspace`, `env`, `heartbeat`, `overdue` | Integrations | Node repository/workspace/scheduler services | Repository/path boundaries, restricted environment reads, task ownership, cleanup progress and completion, no duplicate schedulers |
| `terminal` | Integrations | Node PTY service and caller-scoped streams | Session/task ownership, resize/write validation, output backpressure, process-tree cleanup |
| `artifacts`, `artifact`, `attachments` | Data + Runtime | Node scoped file services with native pick/open/copy callbacks | Canonical path containment, size limits, URL scope, attachment lifecycle, safe clipboard formats |
| `chatImages` | Runtime + Data | Native clipboard read, Node task attachment persistence | Image type/size, task scope, clipboard permission, temporary file cleanup |
| `browser` | Renderer + Bridge + Data | Removed from Tauri by approved scope decision; no native browser adapter | No tool/command/control registrations; preserve inert panel metadata, edges and recording files under T11 |
| `voice` | Integrations + Runtime | Node recognition/TTS services with native permission/hotkey callbacks | Optional install, microphone permission, cancellation, worker cleanup, desktop-only speech audio |
| `mobile` | Integrations | Node mobile pairing/tunnel service | Authentication, pairing/session revocation, bounded broadcasts, desktop capability isolation |
| `app`, `shell`, `notifications` | Runtime | Explicit native commands; Node scoped file reads where appropriate | Trusted app frame, path/URL validation, permission prompts, close/tray/reopen behavior |
| `updater`, `menu` | Release + Runtime | Native menu/update services | Current manual release policy, installer identity, framework transition and rollback; no Electron update feed reuse |
| `ui` | Bridge + Renderer | Validated Node UI-state publication and trusted renderer event sink | Command identity, navigation scope, listener disposal, cleared state when window closes |

The coordinator owns handler-registration assembly. These assignments cover
the observed prefixes, including mixed native/domain families; implementation
must split those families into explicit validated operations. A namespace is
not an authorization boundary, and remote pages receive no matching grants.
Complete payload schemas, result schemas, caller permissions, routing and
listener disposal remain T04 acceptance work.

## Fourteen unresolved syntactic references

Five references use constants whose declarations can be inspected directly:

| Source reference | Declaration | Resolved channel | Owner |
| --- | --- | --- | --- |
| `src/main/ipc/chat.ts`: `CHAT_EVENT_CHANNEL` | Same file | `chat:event` | Bridge + Integrations |
| `src/main/ipc/commander.ts`: `COMMANDER_EVENT_CHANNEL` | `src/shared/commander.ts` | `commander:event` | Bridge + Integrations |
| `src/main/ipc/projects.ts`: `PROJECT_CHANGED_CHANNEL` | Same file | `project:changed` | Bridge + Data |
| `src/main/ipc/settings.ts`: `SKILLS_CHANGED_CHANNEL` | Same file | `skills:changed` | Bridge + Data |
| `src/preload/index.ts`: `UI_COMMAND_CHANNEL` | `src/shared/ui-commands.ts` | `ui:command` | Bridge + Renderer |

The other nine records are wrapper/callback parameters rather than unknown
constants. Keep their source references unresolved in the AST report: a
literal-only scanner cannot prove their full runtime channel sets.

| Source and occurrences | Review finding | Follow-up |
| --- | --- | --- |
| `src/main/agent-manager.ts` (1) | `broadcast(channel, payload)` also reaches external listeners; `sendToRenderer` calls it | Bridge/Integrations must enumerate all callers and preserve desktop/mobile destinations |
| `src/main/auto-updater.ts` (1) | Local `send` calls currently send `updater:status` | Release owns status payload/state compatibility |
| `src/main/guarded-ipc-send.ts` (2) | Generic send plus serialization fallback; this is transport, not a domain owner | Bridge owns bounded serialization/fallback behavior and caller review |
| `src/main/heartbeat-scheduler.ts` (1) | Local helper sends task updates, heartbeat alerts/disable and task refresh | Integrations owns scheduler event parity |
| `src/main/index.ts` (2) | Task API and mobile API notifier callbacks accept channel arguments | Bridge/Integrations must audit their producers and desktop/mobile routing independently |
| `src/main/voice/voice-bridge.ts` (1) | Desktop-only sender is also reused by desktop/mobile notifications | Integrations must retain desktop-only speech routing |
| `src/main/workspace-cleanup-scheduler.ts` (1) | Local helper sends cleanup progress and completion | Integrations must include completion and background behavior |

This review also finds literal channels outside the scanner's recognized
wrapper call forms: `agent:output`, `agent:output-batch`,
`agent:recoveryStateChanged` in agent-manager, `workspace:cleanup-complete`
in workspace cleanup, and `ui:command` through the imported preload constant.
They belong to the corresponding rows above and must appear in the eventual
typed event map. Counts of AST references are therefore not counts of all
runtime channels. Do not use the generated report alone as a dispatch or ACL
allowlist.

T00 remains open for full resource/process ownership, runtime measurements
and platform close/tray/reopen evidence. This audit does not close G1.
