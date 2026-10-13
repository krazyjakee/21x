# Session accounting and managed conversations

Schema v34 adds Commander turn/call usage independently of the managed-session
rollout. Every user, title and summary model turn records a durable usage row,
including failure, cancellation and partial streaming output. Each model call
within a tool loop has its own stable call index. Logs include IDs, model,
counts and provenance, without logging conversation or image contents.

Estimates begin at characters divided by 3.5. Text, tool inputs and tool schemas
are included; base64 image bytes are not counted as text. Image modality cost
stays unknown until a provider reports usage. Reported counters replace the
same call's estimates rather than adding another usage record. Input and output
have independent `reported`, `estimated` or aggregate `mixed` provenance, and
the original estimates remain available for inspection. Reported samples
calibrate later estimates for that model. Context windows are advisory metadata;
unknown models retain an unknown window, and accounting never changes requests,
context budgets, folding, or session identity.

Claude SDK terminal results, Codex app-server token-usage notifications and
OpenCode assistant token counters implement the read-only adapter usage seam.
Commander HTTP providers pass through their normalized usage. Subscription
responses without real counters no longer manufacture reported zero usage;
Commander records estimates. Explicit reported zero remains a real report.

`sessions.ledger` enables an **observe-only** rollout when its setting is `1`,
`true` or `observe`. It defaults off. The shared `ManagedSessionObserver`,
`EventInbox` and `SessionLedger` accept chat or adapter engine observations, but
have no access to providers, task starts or tool execution. Commander integrates
the observer at startup and records its current turn, tool, message and summary
events. Enabling the setting adds recording only; it cannot start, retry, reset,
fold, or replace a live session.

The inbox commits each idempotent event before yielding. Its projection and
acknowledgement share a SQLite transaction. A shared per-owner lock serializes
processing across observer instances while unrelated owners proceed. Duplicate
keys are no-ops; reuse for a different owner or payload is rejected.

Startup drains pending observational events and reconciles previous-process
claims. Interrupted turns retain their original intent, partial output, tool
results and lifecycle audit, and become explicitly `interrupted` with a
`crash_unconfirmed` reason. Completed turns remain completed. Neither pending
events nor interrupted turns cause a model/tool replay. Token accounting also
marks previous-process running usage interrupted and logs the preserved figures.
This provides durable evidence for a future managed lifecycle without changing
the existing Commander or adapter ownership rules.

`sessions.commander_managed` enables the managed Commander when its setting is
`1` or `true`; it defaults off. Observe-only recording remains independently
controlled by `sessions.ledger`. Managed Commander forces its own shared-ledger
observations even if the observe-only flag is off. Rollout remains observe-only,
then Captains, then Commander. Adapter management and planned rollover have
separate gates and are not activated by this flag.

Managed Commander uses `ChatEngine` over the existing `ChatRuntime` and selected
subscription/API provider. D7 limits verbatim model context to the lesser of
16,000 estimated tokens and 60% of a known model window; unknown windows use
16,000. The summary contributes at most 1,500 tokens separately. Text and tool
metadata use the accounting character estimator; image modality tokens remain
unknown until reported. User instructions and tool call/result pairing are
preserved. Older whole turns can leave the model view with an explicit omission
marker and a visible context notice; the full transcript remains in SQLite.
An oversized newest instruction or stored summary rejects a draft before it
is accepted, with a retained-history error.

Each model step and completed tool result has a stable durable message identity
and a shared inbox event. The engine waits for persistence before executing the
next tool or model request. A crash preserves committed steps and marks the
interrupted turn; startup does not replay its actions. A known context overflow
before any output from that model attempt gets exactly one retry at half the
verbatim budget within the same runtime turn. Completed tool results remain in
the request, and identical completed actions are reused if the model asks for
them again after recovery. Large tool outputs may be shortened only in the
model view, with an explicit marker; their full durable results remain intact.
Cancellation, partial output and unknown transport failures do not trigger an
overflow retry. A persistent overflow, or protected instructions that cannot
fit the smaller budget, ends visibly with its history retained.

Summary requests use the session's own provider/model, with bounded transcript
chunks and a 1,500-token output ceiling. Only a complete valid summary advances
the fold cursor. Empty, failed or oversized summaries leave stored history and
the prior cursor intact. Accounting and shared observers seal this instance's
pending work before shutdown; late ignored-abort title/summary work cannot
access SQLite.

Captain reports enter the shared inbox as correlated durable observations and
remain quiet messages in the requesting conversation (or the project-report
inbox according to existing routing). Delivery never starts a model turn or
speech. `roles/commander.ts` owns the defensive report tool policy: report-owned
administration is refused and the report-ask budget is shared; explicit user
tools retain their direct action behavior.

## Captains on AdapterEngine

`sessions.captain_managed` defaults off; `1` or `true` enables the Captain path.
It retains the backend's native context. Starts, resumes, prompt acceptance and
wake dispositions enter the shared event inbox with stable owner/generation
identities. Wake receipt and its existing delivery intent commit together.
The inbox records evidence; the delivery outbox remains the only owner of sends
and retries, so startup projection does not replay prompts or tools.

A managed Captain whose backend session is explicitly missing starts a visible
recap-pending replacement. Its next accepted human message or eligible wake
carries the retained recap; the interrupted prompt is not replayed. Transport,
configuration and approval failures preserve their existing binding. Stale
output batches and excluded, capped or expired wake batches retain disposition
records. Temporary-to-native ID changes preserve the original logical generation.

## Optional task sessions

`sessions.task_managed` defaults off; `1` or `true` enables ordinary task
sessions independently of the Captain flag. Captain, triage and heartbeat
sessions are excluded. Tasks reuse AdapterEngine start, resume, send, terminal,
rekey and compaction observations, with the existing delivery outbox retaining
authority over retries. This flag does not enable planned task rollover.

Each dispatch records estimated input and cumulative output. Reported billing
replaces those estimates only when it identifies the owned intent or a fresh
native turn; uncorrelated reports remain estimated. Actual context occupancy is
recorded separately and is never inferred from summed billing usage.

Lost-session and agent-switch recaps select complete saved records within a
token budget, preserve the newest human instruction, and identify omitted
history. The complete transcript remains stored. An oversized protected
instruction pauses continuation instead of being clipped. A lost-session seed
joins the next accepted instruction without creating another provider turn.

## Planned context continuation

`sessions.rollover` is `off` by default. `observe` records reached limits without
allocating a generation. `on` continues between safe turns after activation of
managed Captains; Commander additionally requires its own managed flag. The
adopted defaults in `sessions.rollover_thresholds` are 70% of a known context
window, two compactions, 150 delivered wake-ups, 300 conversation turns or seven
days. Summed billing usage is never interpreted as context occupancy. Unknown
model windows do not produce a percentage trigger.

The durable handoff progresses through pending, summary, memory, creating,
created and completed. Summaries use the frozen session model and are bounded
to 1,500 estimated tokens. A failed or oversized summary uses a deterministic
fallback with explicit archive references and the newest instruction retained;
if that instruction cannot fit, continuation pauses visibly with its source
intact. Cancellation leaves resumable evidence. It never changes summary models
silently or repeats accepted external creation. A `creation_unconfirmed` row
needs its exact accepted backend identity reconciled before binding can resume.

Captain memory replaces only its own marked block in `MEMORY.md` and appends
one stable handoff entry to `.21x/session-journal.jsonl`. Other text and owners'
blocks are preserved. A changed or non-regular destination and a symlink journal
parent pause the write; source and handoff progress remain available. An accepted
Captain replacement takes precedence over a missing old backend on restart,
so an interrupted binding resumes against its saved identity. Commander retains
one global memory record, binds a
summary and divider atomically in its existing conversation, and keeps newer
unfolded messages available. Replayed binding cannot rewind a later generation.

## Context presentation

Commander and Captain transcript surfaces show a context control. Reported
model input is distinguished from `≈` estimated input; unknown usage and model
windows remain unknown. The latest single request is shown, rather than summed
turn costs. Generation counters, reached limits, pending or unconfirmed
continuation warnings and expandable retained summaries are available in the
dialog. Caption/call lifetime, typing and direct action Undo remain unchanged.

The dialog exposes continuation mode and all five thresholds, and a Stop
control while continuation is pending. Settings writes are validated in main
and do not activate either managed engine flag. Snapshot reads are scoped,
trusted desktop operations with no model calls or lifecycle effects. The
renderer coalesces visible reads and fences failed, released or foreign results.
