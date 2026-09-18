# Commander chat sessions

The Commander is a fast conversational model with no canvas. The user talks to
it in persisted chat sessions; it delegates work to each project's Mastermind
and relays their reports. It never does the work itself. The delegation tools
(#61) and Mastermind reply routing (#62) are separate issues. This document
covers storage, the turn loop and the UI (#60).

## Storage

Both tables are created in `createTables()` with `CREATE TABLE IF NOT EXISTS`,
so they need no schema-version bump. Timestamps are epoch ms.

- `commander_sessions`: `id`, `title` (empty until named), `created_at`,
  `updated_at` (bumped by every message), `archived`, `last_read_at`.
- `commander_messages`: `id`, `session_id` (FK, `ON DELETE CASCADE`), `role`
  (`user | assistant | tool | report | summary`), `content`, `tool_calls` (JSON
  array of `ChatToolCall` on assistant rows), `tool_call_id`, `tool_name`,
  `is_error` (tool rows), `project_id` (delegations and reports; references projects, set null on delete),
  `correlation_id`, `created_at`. Indexed on `(session_id, created_at)`.

`CommanderStore` (`src/main/commander/commander-store.ts`) handles sessions
(list, search over titles and message text, create, rename, archive) and
messages (append, list). Its clock never repeats, so ordering and "newer than"
comparisons hold within one millisecond.

**Unread** means the number of `report` messages newer than `last_read_at`.
Opening a session, or sending in it, marks it read. A report that arrives in
the session open in the Commander view is read on arrival. A report for any
other session stays unread and shows a badge in the list.

## Turns and the context budget

`CommanderService.sendUserMessage` (`src/main/commander/commander-service.ts`)
does the following:

1. Builds the provider first, so a missing API key rejects before anything is
   stored. Then it stores the user message.
2. Builds the model context (`context.ts`). It splits the history into turns.
   A turn starts at a `user` or `report` message. The newest turns are sent
   verbatim, up to `keepTurns` (default 8) and `maxChars` (default 24k). The
   newest turn is always kept. Anything older is covered by the latest `summary`
   message, which is appended to the system prompt. Cuts always fall on turn
   boundaries, so a tool call is never separated from its result. Reports go to
   the model as user-side notes (`[Report from project X]`).
3. Runs one `ChatRuntime` turn with the Commander system prompt (`prompts.ts`)
   and the tools from `getTools` (none yet). Events stream on `commander:event`.
4. Stores the assistant and tool messages. Then it emits `messages_appended`,
   then `done`.
5. After the turn, it does two things:
   - Names an untitled session with a one-shot model call. If that fails, the
     title falls back to the first six words of the first user message. A
     rename made meanwhile is never overwritten.
   - Folds turns that no longer fit the budget into a new rolling `summary`.
     The previous summary is merged in. The summary's `correlation_id` is the
     id of the last message it covers. If the summary call fails, nothing is
     stored and the next turn just trims.

Only one turn runs per session. Cancel aborts it, and whatever text arrived is
kept.

## IPC

`src/main/ipc/commander.ts` registers these handlers: `commander:listSessions`,
`createSession`, `renameSession`, `archiveSession` (which also cancels a running
turn), `listMessages` (returns `{ messages, activeTurnId }`), `markRead`, `send`
and `cancel`. Every handler checks the sender with `assertTrustedSender`.
Callers are subscribed to `commander:event`, which carries these events:
`turn_started`, `turn_event` (runtime events, where `done` carries only the stop
reason), `messages_appended` and `session_updated`.

## UI

The Commander view is in the NavRail (`sidebarView === 'commander'`) and lives in
`src/renderer/src/components/commander/`:

- Session list: new, search, rename, archive, a show-archived toggle, and
  unread badges.
- Chat pane:
  - Streams the assistant's text as it arrives.
  - Shows tool calls as chips, e.g. "Asked Project X…" (`tool-call-label.ts`).
    Chips are drawn from the stored `tool_calls`, and a chip's result comes from
    the matching `tool` row.
  - Shows reports as bordered, project-tagged cards.
  - Has a Stop button and an empty state.
- The state lives in `stores/commander-store.ts`.

## Extension points

- **#61 tools**: pass `getTools` to `registerCommanderHandlers` (or
  `CommanderService`). Stored tool rows do not set `project_id` or
  `correlation_id` yet. #61 must fill them in `persistChatMessage`, for
  example from the tool call's input or from metadata on the tool result.
- **#62 reports**: `getCommanderService()?.appendReport({ sessionId, content,
  projectId, correlationId })` stores the report, emits the events and counts it
  as unread.
