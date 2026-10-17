# Production transcript actions (#218, #212)

The Source production owner can now consume a **final text transcript** without a
microphone, renderer registration or native voice availability. This is a private
owner factory, `ProductionOwner.createVoiceActions(authority)`, retained by the
existing profile owner. It adds no desktop operation, native callback or grant.
Production `voice:startTurn`, `voice:confirm` and `voice:dismiss` remain unavailable.
Hosted voice (#92) remains deferred.

## Captured intent and confirmation

A trusted Source caller begins one lease with its engine/profile caller, project,
selected task, optional visible tasks, mode and a captured `beforeEffect` fence.
The consumer supplies its captured event recipient, which must recheck the
provided `beforePublish` fence immediately before a deferred publication. Dictation also supplies one
focused-control target which must recheck the supplied fence immediately before
writing. A future native binding must supply real physical-document authority;
synthetic caller receipts in these regressions do not establish it.

Each lease has unpredictable turn ID and epoch, one final transcript, a monotonic
30-second default timeout (maximum 120 seconds), and atomic confirmation or
dismissal. There are at most 16 active turns and 4096 admissions per owner epoch.
Text is bounded to 65,536 UTF-8 bytes. Unknown commands reject; spoken yes never
confirms. Dictation and conversation remain literal text, including command words.
The existing deterministic intent parser and shared `VoiceActionService` retain
the closed intent set, quick-create setting and confirmation policy. Fuzzy agent
names now require confirmation as fuzzy task targets already did.

A visual confirmation captures the resolved task, offered choices and current
records. Only the exact turn pair and offered choice can consume it. A changed
record, revoked grant, replaced intent or expired turn rejects. Ambiguous task
and agent choices are separate cards; no hidden agent choice follows a task
choice. Approve/deny always require a second visual confirmation with the exact
pending task/session/request/type still owned by the actual adapter. A stale
request never retargets a newer question. Denying a question uses the same strict
acknowledged abort as the UI, and provider refusal remains a failure.

## Same domain services and event owner

The shared resolver delegates effects rather than writing a second database
path. Its legacy write/notify facade is deliberately refused in this owner.

| Intent | Existing production domain owner |
| --- | --- |
| Create task | `TaskLifecycleBackend` / `db:createTask`, captured project |
| Assign agent | `TaskLifecycleBackend` / `db:updateTask`, normal user-update rules |
| Start task | `ProductionAgentBackend` / `agentSession:startTask` → `AgentManager.startTask` |
| Reply | Existing `agentSession:sendByTaskId` managed delivery, per-turn delivery ID |
| Approve / deny | Existing `agentSession:approve` → ownership-checked `respondToScopedPermission` |
| Navigate | Strict event to the captured Source recipient and task |
| Dictate / converse | Literal text to the one captured focused control |
| Read last answer | Existing live/durable transcript reader for the scoped task |

Canonical `task:created` and `task:updated` events use the actual production owner
bridge and private peer. Admission, per-agent caps, project pause/daily limits,
and durable FIFO remain owned by the existing manager. Disposing a turn after a
queued acceptance cannot remove or replay that durable start. This establishes
the Source voice-start branch of #212 criterion 2; it does not establish every
entry point or whole-issue acceptance.

Manager request scopes recheck the captured intent throughout asynchronous
startup and domain mutations. Cancel, timeout and owner shutdown fence new work
synchronously. Raw promises are admitted before captured callbacks can run, so
a synchronous reentrant turn close cannot acknowledge an unjoined write. Raw
provider, focused-write and publication promises remain owned
until they settle; a blocked parent drain retains ownership for retry. Accepted
external effects are not rolled back or replayed when a reply becomes stale.
Events use the finite local voice schema and a 256-KiB serialized ceiling. This
owner sends no audio or local voice events to mobile.

## Evidence and remaining integration

The regressions instantiate the real `ProductionService`, SQLite, single
`AgentManager`, task/agent domain backends and fragmented `ServicePeer`. The same
suite also imports the actual staged `production-engine.mjs` with standalone
bundled Node. Controlled Pi runs use only an isolated executable and synthetic
HOME, receipt and PATH; no account, model request, API key or microphone is used.
Both acknowledged and refused cancellation are exercised. Separate staged-entry
production proofs retain the real stdio launch/credential/resource checks.

This owner is intentionally unregistered while voice availability is off. Native
microphone permission and revocation, capture/playback/global shortcut lifetime,
renderer hookup and installed platform/device proof depend on #215 and the
agreed [private voice authority](voice-native-authority.md). Actual local model
inference, reviewed all-platform optional runtime installation and custom-dir
selection remain open. No live profile, release, identity/scheme selection,
hosted provider or provider-account run is authorized here. Hosted Verify
unavailable: repository Actions disabled, awaiting user decision.
