# Session accounting and managed Commander

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
