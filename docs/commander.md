# Commander chat sessions

The Commander is a conversational coordinator with no canvas. The user talks
to it in persisted chat sessions; it delegates work to each project's Captain
and relays their reports. It never does the project work itself, and it has
no tool that could: its registry (#61, #73) holds delegation, status reads
and project administration only. Captain replies and escalations come
back as reports routed to the right session (#62, below).

The hierarchy is **Commander → Captain → task agent**: the Commander works
across projects, each project's Captain coordinates the work inside one project
(one persistent conversation per project), and task agents do the work. The
Captain was called the Mastermind before #71; stored data is migrated (see
docs/database-migrations.md, *The coordinator is the Captain*).

## A session is an agent session

Every Commander session runs through AgentManager and the coding-agent
adapters, exactly like a task and like the Captain. There is one session stack,
so a fix or improvement to agent sessions (auth, streaming, transcripts,
approvals, stop, resume, voice) applies to the Commander too.

- **The row.** Each session has a hidden `tasks` row with the **same id** and
  `role = 'commander'` (`TASK_ROLE_COMMANDER` in `src/shared/task-roles.ts`).
  It is a coordinator role, so the row is never listed, scheduled, triaged or
  given a worktree, and its status never moves (the same rules as the
  Captain's row). The session's conversation is that row's agent session:
  its `session_id` is the resume anchor and its transcript is the task's
  transcript (`transcript_parts`), streamed on the usual `agent:output` /
  `transcript:changed` channels.
- **The agent.** Every session runs on one agent: the `commander_agent_id` app
  setting (chosen in the Commander view), else the default agent, else the
  first agent. The model, thinking level, auth method (subscription or API
  key) and permission mode are that agent's, as for any session.
- **The prompt.** `assembleSessionConfig` gives a Commander row the Commander
  prompt (`COMMANDER_SYSTEM_PROMPT` in `src/main/commander/prompts.ts`),
  whatever the backend, followed by the agent's own system prompt. A session
  started before this design gets its old conversation appended
  (`earlierHistoryNote`: the rolling summary it kept and the newest messages,
  about 8k characters), so the agent picks up where the old chat left off.
- **The tools.** A Commander row gets one MCP server, `commander`, and nothing
  else: not task-management, and not the agent's configured servers
  (`mcpOptionsForTask` / `buildMcpServers` in
  `src/main/agent-manager/session-config.ts`). The server is the in-process
  task MCP endpoint with the scope `/mcp?commander=<sessionId>`
  (`task-mcp-endpoint.ts`), which serves the Commander's registry through
  the seam in `src/main/commander/commander-mcp.ts` and never falls through to
  a task scope. The prompt also tells the agent not to use its built-in file,
  shell or web tools.
- **The service.** `CommanderService` (`src/main/commander/commander-service.ts`)
  owns only what is particular to the Commander: the session list, the tools,
  reports, and the agent choice. `prepareSession` makes sure the row exists
  (and copies an old session's history into its transcript once, so it still
  reads as one conversation). It listens to agent events: when the user speaks
  in a session, an untitled session is named from the first words of the
  message and moves to the top of the list; when its agent goes idle, the
  session moves up and any report waiting for it is handed over.

Sending, streaming, stopping, approvals and questions are the normal
agent-session calls (`agentSession:*`). The renderer drives a Commander session
with the same hook as the Captain drawer (`useCoordinatorChat`).

## Storage

`commander_sessions` and `commander_messages` are created in `createTables()`.
Timestamps are epoch ms.

- `commander_sessions`: `id` (also the id of the session's task row),
  `title` (empty until named), `created_at`, `updated_at` (bumped by activity),
  `archived`, `last_read_at`, `relayed_at` (reports stored up to then have been
  handed to the agent; migration 18).
- `commander_messages`: what is not part of the agent conversation. `role`
  is `report` (a Captain report), `tool` (an `ask_captain` delegation,
  kept so the report that answers it is routed back), or `user`, `assistant`,
  `summary` (history written by the old chat runtime; never written now).
  Columns: `id`, `session_id` (FK, `ON DELETE CASCADE`), `role`, `content`,
  `tool_calls`, `tool_call_id`, `tool_name`, `is_error`, `project_id`
  (references projects, set null on delete), `correlation_id`, `created_at`.

`CommanderStore` (`src/main/commander/commander-store.ts`) handles sessions
(list, search over titles, reports and the conversation transcript, create,
rename, archive, delete, which removes the task row too) and messages. Its
clock never repeats, so ordering and "newer than" comparisons hold within one
millisecond.

**Unread** means the number of `report` messages newer than `last_read_at`.
Opening a session marks it read. A report that arrives in the session open in
the Commander view is read on arrival. A report for any other session stays
unread and shows a badge in the list.

## Tools

The agent calls these over MCP (above). `src/main/commander/project-tools.ts`
builds the project registry and `src/main/commander/skill-tools.ts` the skill
registry (#74: `list_skills`,
`get_skill`, `create_skill`, `update_skill`, `remove_skill`, `promote_skill`,
`move_skill`; see docs/skills.md, *Scope*). `ipc/commander.ts` concatenates
the two under one confirmation table. The registry is built for every MCP call
with the call's context: the session id, the user's newest message, and
whether the agent is answering the user or a relayed report. That context is
read from the session's stored transcript: AgentManager stores the user's
message before the prompt reaches the agent, so a call always sees the message
that caused it. A successful `ask_captain` result is stored as a `tool` row
with its project and correlation id. Every result is a
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
  limits, the Captain's summary and top blockers) plus the Captain
  agent and whether its session is running.
- `get_project_status_history(project, limit?, cursor?)` (#72): one page of
  the project's status journal, newest first: 5 entries by default, 20 at
  most, each clipped (600-character summary, 6 items of 160 characters per
  list), the page capped at 8k characters, with `has_more` and an opaque
  `next_cursor` that continues exactly where the page stopped even when new
  entries arrived meanwhile. The prompt reserves it for "what changed?"
  questions; it is never part of `list_projects` or the system prompt. See
  docs/task-lifecycle.md, "Status journal".
- `ask_captain(project, message)`: sends a fenced relay message to the
  project's Captain through `AgentManager.sendMessage` on its coordinator
  row (the same rejoin-or-resume path the wake-ups use) and returns at once
  with a `correlation_id`. The message carries the Commander session id and
  the correlation id in a provenance line, quotes the request inside
  `<<<BEGIN COMMANDER MESSAGE … END COMMANDER MESSAGE>>>`, and states that it
  grants no authority for privileged operations. Delivery is not awaited; a
  failure after the tool returned is stored on the session as a report through
  `onDeliveryFailed`.
- `get_pending_approvals()`: agent checkpoints (sessions in
  `waiting_approval`) and held Captain actions (#66) across active
  projects. Read-only: there is no approve or reject tool.
- `navigate_to_project(project)`: pushes a `switch_project` UI command down
  the existing `ui:command` channel; the renderer switches the current project
  and leaves the Commander view for the dashboard.
- `pause_all_projects(paused)`: the #65 pause, behind confirmation.

Administration (#73): `get_project`, `create_project(name, brief?, repos?,
…)`, `update_project(project, changes)` (name, brief, Captain/default
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
3. The call is accepted only when it carries that token, the user's newest
   message in the session's transcript is exactly `Confirm <token>`, the tool and action match the
   challenge, and the token is unexpired (10 minutes) and unused. Anything else
   returns `confirmation_invalid`, `confirmation_mismatch` or
   `confirmation_absent` as an error result, and nothing is written.

The confirmation is therefore checked in the main process against what the
user actually sent, not a prompt convention: the agent cannot confirm on the
user's behalf, and an automated message (a relayed report) never counts as a
confirmation. Successful mutations call
`onProjectChanged`, which broadcasts `project:changed`.

## IPC

`src/main/ipc/commander.ts` registers these handlers: `commander:listSessions`,
`createSession`, `renameSession`, `archiveSession` (which also stops the
session's agent), `prepareSession` (returns `{ taskId, agentId }`: the row and
agent the renderer then starts or resumes with the normal agent-session
calls), `getAgentId`, `markRead` and `setActiveSession` (the session the view
shows, or null when it closes; see Reports). Every handler checks the sender
with `assertTrustedSender`. It also installs the report bridge
(`installCommanderReportBridge`) and the MCP tool host
(`setCommanderToolHost`). Callers are subscribed to `commander:event`, which
carries `messages_appended` (reports and delegations) and `session_updated`.

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
- Chat pane (`CommanderChatPane.tsx`): the shared `AgentTranscriptPanel`, the
  same transcript and composer a task or the Captain drawer uses, bound to the
  session's row through `useCoordinatorChat`. The header has the agent
  selector, which saves `commander_agent_id` for every session and moves the
  open conversation to the chosen agent.
- The session list state lives in `stores/commander-store.ts`; the
  conversation lives in the agent store like any task's.

## Reports (#62)

A Captain is slow and the user moves on; its answer must still land in the
right place. The pieces:

- **The Captain's tool.** `report_to_commander(message, correlation_id?)`
  is a project-scoped, coordinator-only task-management tool (route
  `/report_to_commander`, message capped at 4,000 characters). The Captain
  prompt (section 11) tells it to answer a Commander request with it, quoting
  the `correlation_id` from the relay message, and to report unasked when the
  user must decide something. The route hands the report to the seam in
  `src/main/commander/report-inbox.ts`; `ipc/commander.ts` installs the
  handler (`installCommanderReportBridge` in `report-tools.ts`). Without the
  handler (before the Commander IPC is registered) the tool returns an error
  the Captain can read.
- **Routing** (`resolveReportSession`). A report quoting a `correlation_id`
  goes to the session whose `ask_captain` tool row carries that id
  (`CommanderStore.findDelegation`, indexed on `correlation_id`), unless that
  session is archived. Otherwise — no id, an unknown id, or an archived
  origin — it goes to the most recently active session, which is where the
  user is working. With no session at all, one titled "Project reports" is
  created for it. The stored `report` message keeps the project tag and the
  correlation id whichever rule applied. The tool result says which rule
  (`routed_by`: `correlation` | `latest` | `inbox`).
- **Delivery** (`CommanderService.deliverReport`). The report is stored and
  emitted (unread until read). The renderer tells main which session the
  Commander view shows (`commander:setActiveSession`, sent by the store's
  `selectSession` and cleared when the view unmounts or the window closes).
  Reports are handed to the session's agent only while that session is open:
  every report newer than `relayed_at` goes as one automated message
  (`buildReportRelayMessage`: the `SYSTEM_MESSAGE_MARKER` provenance header,
  the reports fenced as data, the authority notice, and a note asking the
  Commander to relay them, naming the project). AgentManager starts or resumes
  the agent when needed. A busy agent gets the message when it next goes idle,
  so a report never interrupts an answer. A session that is not open keeps the
  unread report and its badge, and its reports are handed over when the user
  opens it. With no agent configured the report is still stored.
- **Loop protection.** While the agent is answering a relayed report (the
  newest input in the transcript is the automated message), `ask_captain` is
  allowed only while the session's budget lasts: 3 calls
  (`MAX_REPORT_ASKS_WITHOUT_USER_TURN`) since the user last spoke.
  `guardReportAsks` wraps the tool for such calls and returns a `loop_guard`
  error result beyond that; a new user message resets the count. Answers to
  the user are not limited.
- **Escalations.** `installCommanderReportBridge` also installs the
  `escalation.ts` handler: a `tell_commander` action the Captain performed
  (#66) becomes an unprompted, project-tagged report ("Escalation notice …")
  routed by the rules above. Held, approved and rejected `ask_user` calls are
  not reported; they are the user's business (`get_pending_approvals`).

## Voice (#64)

A Commander session is an agent session, so voice works as it does for a task
and for the Captain drawer. The transcript composer registers under the
session's task id: dictation fills it, a voice conversation sends each
sentence through it and expects the spoken answer from that task, and
`watchAgentAnswersForSpeech` reads the answer aloud through whichever engine is
selected in Settings → Voice (system, downloaded, or ElevenLabs). Relayed
reports are answered by the agent, so the relay is spoken like any answer.
There is no Commander-only voice path.

## Scheduled briefing (#67)

A scheduled summary across all projects, off by default. It is one app
setting, `commander_briefing`, holding JSON:

```json
{ "enabled": false, "cron": "0 8 * * 1-5", "speak": false }
```

Edit it in Settings → Projects → Commander briefing
(`src/renderer/src/components/settings/CommanderBriefingSettings.tsx`). The
cron is 5 fields in local time. Shapes and defaults are in
`src/shared/scheduled-coordination.ts`.

`src/main/scheduled-coordination.ts` runs it in the main process on a
one-minute tick, so it runs with the window closed. At each occurrence it:

1. builds the briefing from every active project's status record
   (`buildProjectStatus`): summary, counts, top blockers, and pending approvals
   (agent steps waiting for approval, plus Captain actions held by the
   escalation policy). Projects that need the user come first. There is no
   model and no raw task data in this step;
2. creates a new session titled `Briefing <YYYY-MM-DD>` and stores the
   briefing as a `report` message (through `CommanderService.appendReport`
   when the service is running, so an open window sees it). The report leaves
   the session unread. When the user opens the session, the briefing is handed
   to the Commander's agent like any report, and the agent sums it up;
3. raises a desktop notification that says which projects need attention;
4. if `speak` is on, a window is open, and a speech engine is ready, reads that
   one-line verdict aloud ("Your briefing. …") through the speech service with
   the `manual` source and the `commander:<sessionId>` key.

The last occurrence handled is stored in the `commander_briefing_state` app
setting before the work starts, so a restart does not brief twice. Turning
the briefing on, or changing its cron, starts from that moment: a past
occurrence never fires. An occurrence missed while the app was closed runs
once at start-up if it is under 6 hours old. Otherwise it is skipped.

## Extension points

- **Custom tools**: tests or integrations may pass `getTools` to
  `registerCommanderHandlers` (or `CommanderService`) to replace the default
  registry. The tool context carries `trigger: 'user' | 'report'`. The agent
  sees them on its `commander` MCP server with no other change.
- **Reports from elsewhere**: `getCommanderService()?.deliverReport({ sessionId,
  content, projectId, projectName, correlationId })` stores, counts unread and
  hands the report to the agent when the session is open; `appendReport` only stores. To route by
  correlation id first, go through `deliverCaptainReport` in
  `report-inbox.ts`.
