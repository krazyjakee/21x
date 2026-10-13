# Production agent lifecycle bindings

`ProductionAgentBackend` binds 17 retained agent-session, admission/recovery and
Captain-runtime commands to the production owner's actual AgentManager and
SQLite connection. It has no deterministic-fixture allowlist, secondary writer,
transport retry loop or simulated success counter. The coordinator registers
its finite operation schemas and synchronous `shutdown()` / raw `close()` drain
with the production owner. Configuration/model discovery and transcript
pagination remain separate domains.

The native host supplies trusted caller identity, engine epoch and task,
project and agent access checks. None are request fields. Start requests accept
no workspace path; AgentManager derives the workspace and retains admission,
FIFO, pause/daily caps, triage and coordinator exemptions, feedback, fallback,
rollover and lost-session recap behavior. High-level `startTask` handles ordinary
and grouped tasks through the existing subtask/triage selection. Captain starts
use the session APIs with the project's configured Captain agent; Captain
switch/retry/rollback use the actual runtime owner and return its real phase,
including failed or rolled-back readiness.

Task-group member commands resolve to the active execution anchor and require
access to the anchor and all current members in its project. A group remains
counted ordinary work. Member send instructions keep the manager's explicit
member prefix. Attachments must match the execution task's persisted ID, name,
size and MIME metadata; member attachment sends are refused because their files
belong to another workspace owner. A session-addressed command requires the
exact live native key and matching persisted task binding. Old redirect keys,
foreign task/agent combinations and stale native identities never authorize a
new turn or another pending approval.

Permission/question replies require the actual pending adapter request ID and
response type. Async pending-request reads remain owned through close, and the
manager rechecks exact native/task/agent/request identity at dispatch. Overlapping
confirmations claim that exact decision once. Persisted transcript cards alone
cannot authorize a provider callback after restart. The result must be actually
handled; stale/no-handler replies fail instead of sending a continuation.
Questions preserve structured/free-form answer parsing and acknowledged denial.
Abort and stop use acknowledgement-required manager paths, so refused provider
cleanup does not become a fabricated successful idle/stopped result.

Send commands pass durable intent ownership to the existing DeliveryStore. A
client-supplied delivery nonce is namespaced by trusted caller identity and the
execution task, stable across service epochs within that profile. Reusing the
nonce with changed instructions or attachments is rejected. An accepted replay
returns its original durable destination without another provider send. A caller
omitting a nonce submits a new intent; the backend never automatically retries a
mutation after disconnect, cancellation or an uncertain provider outcome.
Native resource and current ownership checks still apply to any returned
session identity. Session start/resume/switch return the actual native session,
queued start, ended conversation or manager error.

Codecs reject extra fields, absent request identities, foreign path fields,
non-JSON/cyclic values and oversized inputs/results. Instructions are limited to
65,536 UTF-16 units plus a 256 KiB UTF-8 JSON budget; attachment lists cap at 16,
queue replies at 512 rows, and raw diagnostic replies at 100 messages / 512 parts
per message. An oversized reply is refused, not silently clipped by transport.
The manager's existing diagnostic field previews remain unchanged, and durable
transcript pages remain the bounded hydration path. Terminal recovery rows retain
position zero and actual classification/state; provider error details are
projected to a fixed notice rather than exposing request bodies or local paths.

Backend shutdown fences new operations but retains raw authorization reads and
accepted manager effects, including ignored abort signals. A short close deadline
reports incomplete work and leaves its database/profile lease with the parent
owner. The coordinator must drain the backend before releasing that owner; it
must not replace drain with disposal or retry the original mutation. A late reply
may be suppressed while the durable accepted effect remains available to reload.

Focused tests use real portable SQLite/schema, AgentManager, admission and durable
outbox paths with controlled external coding-adapter behavior. They cover queued
and terminal recovery, subtask/triage selection, group ownership, foreign/stale
identities, native permission/questions, concurrent confirmation, denied abort/
stop, manual recap switching, strict diagnostic reads, Captain failure/retry/
rollback and accepted-send cancellation/reconnect. They do not establish real
SDK/CLI sessions, auth/model/secret injection, packaged native resource resolution,
provider compaction/background behavior or process-tree teardown on supported
platforms. Those require credentialed isolated/copied-profile integration evidence
under [the validation contract](validation.md); #211, G3 and live cutover are not
claimed complete by these imports or fixtures.
