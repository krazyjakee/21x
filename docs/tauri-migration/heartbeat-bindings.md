# Production heartbeat bindings

The production backend borrows the actual `DatabaseManager`, `AgentManager`,
`HeartbeatSchedulerCore`, and captured `HeartbeatFileOwner`. It binds the eight
existing controls: enable, disable, run now, logs, status, interval, read file,
and write file. It uses the existing scheduler and session admission paths;
there is no second heartbeat loop or task writer.

Requests require a current trusted main-window identity and engine epoch. Reads
and writes have separate task/project grants. Literal workspace reads include
the actual execution anchor and relevant current/former group-member scope;
they never substitute another task's workspace. Coordinator and grouped rows
cannot acquire an independent heartbeat through these mutation controls.
Runtime effects also check the selected/default and fallback agents, scoped
skills, secrets, MCP servers, source references, and project resources. SQLite
inspects stored byte lengths before full task/config/log getters or JSON
materialization. A saved oversized row is refused without changing its bytes.

Wire codecs retain missing tasks, nullable status/files, optional task results,
five run statuses, and boolean file-write results. Intervals are whole minutes
from 1 to 525,600; log limits are 1–128. File bodies are valid Unicode, NUL-free,
and at most 128 KiB UTF-8. Stored scope/log batches are limited to 128,000 bytes;
the public response ceiling is 900,000 bytes. Public tasks select the existing
declared lifecycle fields. Logs preserve human summaries and replace provider
failure diagnostics with a fixed message. Alert and disabled events carry only
their existing task/title/summary or task/reason fields. Truncation preserves
surrogate pairs. Model findings are bounded before a follow-up prompt is built.

The scheduler captures application `beforeTaskEffect` and `captureTaskBinding`
callbacks, independent of an RPC caller. The binding fingerprint excludes
heartbeat timestamps and session-pointer updates but includes task/project,
group, agent, and runtime-resource bindings. The scheduler separately retains
and rechecks the exact file instructions through the same file owner before
each effect. A moved, grouped, reassigned, or
reconfigured task cannot forward stale findings. Portable preflight uses the
host's captured bounded `gh` process owner. The Electron constructor retains
its existing default preflight and filesystem behavior when no portable host
is supplied.

Caller authorization remains active through nested session creation and prompt
admission. After send acceptance, result monitoring is explicitly detached into
the actual scheduler and manager lifetime; closing the request backend does not
cancel that accepted background check. Application shutdown cancels polling and
joins raw sends, preflight, forwarding, and exact session cleanup. A rejected
post-send guard does not prove the prompt was unaccepted: the scheduler retains
busy state until acknowledged cleanup, reports failure, and never resends it.
Dedicated heartbeat sessions keep their virtual runtime IDs; their durable
delivery records reference the actual task row, with the exact session/task
alias checked before enqueueing. Abandoned, expired and uncertain heartbeat
intents cannot be replayed by delivery recovery; accepted receipts may only be
acknowledged. A new check captures current instructions.
Failed cleanup receipts remain owned for an explicit shutdown-close retry.

`HeartbeatFileOwner` handles only `<captured workspace>/<literal task>/heartbeat.md`.
It captures physical directory identities, refuses links, special files and
multiply linked files, compares opened FD identity to the named leaf, and
bounds reads/writes before allocation. Writes use an exclusive private temp,
sync and verify its actual bytes, recheck the original, close the FD, then
publish. Concurrently changed/unowned files and temps are preserved. Real FD
close failure blocks publication and remains retained until explicit close
retry. `retireWorkspace(taskId,{dev,ino})` transfers only that known physical
workspace identity to the trusted cleanup owner; it does not delete files.
If the first stat of a created scratch FD fails, its real FD is still closed;
the empty scratch is retained because its namespace identity was never proven.

These synchronous Node path checks are conservative receipts, not an atomic
cross-platform `openat` containment guarantee. A same-user process can race
between the last namespace check and a mkdir/rename/link. Changed identities
are refused where observable, and unowned bytes are retained; installed/native
platform containment and full migration gates remain separate acceptance work.

Authored tests use actual portable SQLite, the actual scheduler/manager with an
explicit controlled adapter, real temporary files/FDs, and injected primitive
faults. They cover all eight controls, scoped/huge legacy refusals, raw close
retry, task replacement, ignored cancellation, inherited retired scopes,
accepted background continuation, stale bindings, and failed acknowledgements.
No live model, OS opener, network, installed-platform, or validation result is
claimed by this source batch. The coordinator runs integrated checks after all
workers freeze.
