# Session accounting and observational ledger

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
