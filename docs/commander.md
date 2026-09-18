# Commander chat sessions

The Commander is a fast conversational model with no canvas. The user talks to
it in persisted chat sessions; it delegates work to each project's Mastermind
and relays their reports. It never does the project work itself, and it has
no tool that could: its registry (#61, #73) holds delegation, status reads
and project administration only. Mastermind reply routing (#62) is a
separate concern.

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
   and the tools from `getTools`, which is called per turn with the session id
   and the user message (the confirmation check reads it). Events stream on
   `commander:event`.
4. Stores the assistant and tool messages. A tool row whose result is a JSON
   object carrying `project_id` / `correlation_id` (an `ask_mastermind`
   result) is tagged with them, so #62 can match the report to the
   delegation. Then it emits `messages_appended`, then `done`.
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

## Tools

`src/main/commander/project-tools.ts` builds the registry. Every result is a
small JSON object with fixed item and character caps (50 projects, 20 repos,
20 resources, 30 approvals, 12k characters), never raw tasks or transcripts.
A project is addressed by its stable id, or by its exact name when that name
is unique; an ambiguous name is an error. The test
`project-tools.test.ts` pins the exact tool list and asserts that no tool is
named for a task, session, checkpoint, approval, start, stop or delete.

Delegation and status (#61):

- `list_projects(include_archived?)`: id, name, one-line brief, the #58
  counts, paused flag.
- `get_project_summary(project)`: the #58 status record (counts, compact
  limits, the Mastermind's summary and top blockers) plus the Mastermind
  agent and whether its session is running.
- `ask_mastermind(project, message)`: sends a fenced relay message to the
  project's Mastermind through `AgentManager.sendMessage` on its coordinator
  row (the same rejoin-or-resume path the wake-ups use) and returns at once
  with a `correlation_id`. The message carries the Commander session id and
  the correlation id in a provenance line, quotes the request inside
  `<<<BEGIN COMMANDER MESSAGE … END COMMANDER MESSAGE>>>`, and states that it
  grants no authority for privileged operations. Delivery is not awaited; a
  failure after the tool returned is stored on the session as a report through
  `onDeliveryFailed`.
- `get_pending_approvals()`: agent checkpoints (sessions in
  `waiting_approval`) and held Mastermind actions (#66) across active
  projects. Read-only: there is no approve or reject tool.
- `navigate_to_project(project)`: pushes a `switch_project` UI command down
  the existing `ui:command` channel; the renderer switches the current project
  and leaves the Commander view for the dashboard.
- `pause_all_projects(paused)`: the #65 pause, behind confirmation.

Administration (#73): `get_project`, `create_project(name, brief?, repos?,
…)`, `update_project(project, changes)` (name, brief, Mastermind/default
agent, git defaults), `add/update/remove/reorder_project_repo(s)`,
`add/update/remove/reorder_project_resource(s)`, `archive_project`,
`restore_project`. There is no delete. The Default project cannot be archived
(the tool refuses before the confirmation step, and the database refuses too).

### Confirmation

Every mutating tool (`MUTATING_COMMANDER_TOOLS`) goes through
`ProjectMutationConfirmations`, one instance per app:

1. The first call performs no write. It stores a challenge for the session
   bound to the tool name and the normalized action, and returns
   `{ status: 'confirmation_required', confirmation_token }`.
2. The model explains the change and asks the user to reply exactly
   `Confirm <token>`.
3. The call is accepted only when it carries that token, the current turn's
   user message is exactly `Confirm <token>`, the tool and action match the
   challenge, and the token is unexpired (10 minutes) and unused. Anything else
   returns `confirmation_invalid`, `confirmation_mismatch` or
   `confirmation_absent` as an error result, and nothing is written.

The confirmation is therefore part of the stored user/tool turn flow, checked
in the main process, not a prompt convention. Successful mutations call
`onProjectChanged`, which broadcasts `project:changed`.

## IPC

`src/main/ipc/commander.ts` registers these handlers: `commander:listSessions`,
`createSession`, `renameSession`, `archiveSession` (which also cancels a running
turn), `listMessages` (returns `{ messages, activeTurnId }`), `markRead`, `send`
and `cancel`. Every handler checks the sender with `assertTrustedSender`.
Callers are subscribed to `commander:event`, which carries these events:
`turn_started`, `turn_event` (runtime events, where `done` carries only the stop
reason), `messages_appended` and `session_updated`.

It also wires the tool registry to the app: the agent manager, the held-action
list from `escalation.ts`, the Task API's window notifier for UI commands, and
`broadcastProjectChanged` from `ipc/projects.ts`.

`project:changed` (`ProjectChangedEvent`: `projectId`, `kind`) is sent to every
window from the main-process mutation points: the project, repo and resource
IPC handlers in `ipc/projects.ts` and the Commander's tools. The renderer's
`projectApi.onChanged` subscribes; `AppLayout` refetches the project store
(switcher, overview), and an open `ProjectEditorDialog` reloads the project,
its repos and resources when the event names the project it is editing.

## UI

The Commander view is in the NavRail (`sidebarView === 'commander'`) and lives in
`src/renderer/src/components/commander/`:

- Session list: new, search, rename, archive, a show-archived toggle, and
  unread badges.
- Chat pane:
  - Streams the assistant's text as it arrives.
  - Shows tool calls as chips (`tool-call-label.ts`): a delegation reads
    "Asked Web: Ship the site", an administration call reads
    "Archive project · Web". Chips are drawn from the stored `tool_calls`, and
    a chip's result comes from the matching `tool` row.
  - Shows reports as bordered, project-tagged cards.
  - Has a Stop button and an empty state.
- The state lives in `stores/commander-store.ts`.

## Extension points

- **Custom tools**: tests or integrations may pass `getTools` to
  `registerCommanderHandlers` (or `CommanderService`) to replace the default
  registry.
- **#62 reports**: `getCommanderService()?.appendReport({ sessionId, content,
  projectId, correlationId })` stores the report, emits the events and counts it
  as unread. The `correlation_id` a Mastermind quotes is the one its relay
  message carried; the matching `ask_mastermind` tool row holds the same id.
