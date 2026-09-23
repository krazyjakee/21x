# Token accounting (managed sessions B1, #97)

Every turn of the Commander, a Captain or a task agent records its token usage
in the `session_usage` table and in one log line. Each figure says whether the
backend **reported** it or 21x **estimated** it. This batch is instrumentation
only: nothing reads the table to change behaviour. Later batches of the managed
sessions epic (#96) build on it for budgets, the context meter, compaction
detection and rollover.

## What a row holds

`session_usage` (migration 31, `src/main/database/session-usage-migration.ts`):

| Column | Meaning |
|---|---|
| `owner_kind`, `owner_id` | `commander` + Commander session id, or `captain` / `task` + task id |
| `session_id` | The backend session (a Claude Code session, a Codex thread, an opencode session) or the Commander session |
| `turn_key` | The turn within its owner. Unique per owner: a figure reported again replaces the row |
| `engine`, `backend`, `model` | `chat` (ChatRuntime) or `adapter` (a coding agent); the chat provider id or coding agent type; the model |
| `usage_source` | `reported` or `estimated`, for the token counts of the row |
| `input_tokens` … `reasoning_tokens` | Anthropic convention: `input_tokens` excludes prompt-cache reads and writes, which have their own columns. Reasoning tokens are already inside `output_tokens` |
| `context_tokens`, `context_source` | The prompt size of the turn's last model call (what the model had in context), and its own provenance |
| `context_window`, `window_source` | The model's window, from `reported` (the backend said), `override`, `known` (the table) or `default` |
| `estimated_prompt_tokens` | 21x's estimate of a prompt whose size was also reported: the calibration pair |
| `model_calls`, `cost_usd`, `stop_reason` | When the backend says |

The log line is `[SessionUsage] owner=… turn=… backend=… model=… source=… in=… out=… cache=…r/…w context=…/window (pct%) …`,
with `≈` in front of every estimated figure.

## Where the figures come from

| Backend | Reported | Notes |
|---|---|---|
| Commander, Anthropic API | yes | Per model call; cache reads and writes included |
| Commander, Claude Code subscription | yes | The result's `usage` |
| Commander, Codex subscription | **no** | Codex exec reports zeros; always estimated |
| Commander, OpenAI-compatible | only if the server streams `usage` | The request does not ask for it (`stream_options.include_usage`); adding it would change the request, so it is left for a later batch |
| Claude Code adapter | yes | `result.modelUsage`, differenced between results (it is cumulative per `query()` process; covers subagents and compaction), else the main-loop `usage`. Context from the last main-loop assistant message; window from `modelUsage[model].contextWindow` |
| Codex app-server | yes | `thread/tokenUsage/updated`: the `last` breakdowns summed per turn, cached input moved to cache reads, window from `modelContextWindow` |
| opencode | yes | Finished assistant messages: the `step-finish` parts summed, context from the message's latest step. Messages that finished before a resumed session was registered are history and are skipped |
| pi, ACP (Cursor) | no | Estimated |

`src/main/adapters/usage-reports.ts` reads the three adapter formats; the
adapters hand the result to `onUsage`, which AgentManager installs when it
creates the adapter. `src/main/sessions/adapter-usage.ts` attributes each
report to its task and records it.

## Estimates

`src/main/sessions/token-estimator.ts`: characters ÷ 3.5, plus 4 tokens per
chat message, 8 per tool definition and 1,600 per image.

- **Commander.** A turn is `reported` only when every model call reported;
  otherwise its figures are estimated from the text of each call's prompt and
  answer. When a turn is reported, the estimate of its last prompt is stored
  next to the reported size, and the ratio between the two (kept only between
  0.5 and 3, and only for prompts of 256 tokens or more) scales later
  estimates in the same session.
- **Captains and task agents.** A turn that ends (idle or error) without any
  report gets one `estimated` row from the prompt and output text. When the
  same backend session reported a context size before, that figure is the
  anchor: the estimated context is "last reported + what this turn added".
  Without an anchor the context is left unknown and the input is only the new
  prompt, a lower bound.

A reported figure is never replaced by an estimate.

## Context windows

`src/main/sessions/model-windows.ts` gives each model a window: a window the
backend reported wins, then an override, then the static table, then 128k.
The table covers the Claude families (1M from Opus 4.6 / Sonnet 4.6 on, 200k
before, the `[1m]` suffix), the common OpenAI, Gemini and open-weight families.
Add a row rather than special-casing a model at a call site.

## Not covered yet

- The Commander's title and fold one-shot calls are not turns and are not recorded.
- Project daily token caps (`recordProjectTokenUsage`, #65) are not fed from
  this table: doing so would start enforcing a cap that is inert today.
- Nothing shows the figures in the UI (B8).
- The managed-session ledger (B3, [Managed sessions](managed-sessions.md))
  links each turn to its `session_usage` rows by `turn_key` and sums them.
