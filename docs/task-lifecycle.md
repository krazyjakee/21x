# Task Lifecycle & State Management

This document describes the task status model, state transitions, auto-run scheduling, and auto-triage system.

## Task Statuses

```typescript
enum TaskStatus {
  NotStarted    = 'not_started'      // Default. Waiting to be picked up.
  Triaging      = 'triaging'         // Auto-triage in progress (assigning agent/skills/labels).
  AgentWorking  = 'agent_working'    // Agent session is active.
  ReadyForReview = 'ready_for_review' // Agent finished. Awaiting human review.
  AgentLearning = 'agent_learning'   // Agent is learning from feedback (skill extraction).
  Completed     = 'completed'        // Done.
}
```

### UI Indicators

| Status | Badge | Dot Color |
|--------|-------|-----------|
| Not Started | grey | grey |
| Triaging | grey | grey (pulsing) |
| Agent Working | yellow | amber (pulsing) |
| Ready for Review | purple | purple |
| Agent Learning | blue | blue (pulsing) |
| Completed | green | green |

### Coordinator rows

Each project's Captain is stored as a row in `tasks` with
`role = 'captain'` and the project's `project_id` (#55). `seedCaptainTasks`
gives every existing project one on startup (idempotent, keyed by project;
the Default project's row is the one every install has), `createProject`
creates one with the project, and archiving leaves it alone so a restored
project finds its conversation again. It is a row so that its `session_id`
and transcript parts persist like any task's: restarting the app and sending
a message continues the same conversation, and a runtime the idle reaper
released is resumed by the next message.

Its session runs in its own workspace with no worktree, on the project's
`captain_agent_id` (else `default_agent_id`, else the app default agent —
`captainAgentIdFor` in the renderer's coordinator-store). The system prompt
is the built-in Captain prompt (`src/main/prompts/captain.ts`) followed
by a project section built on every start, resume and send from the project
row, its repos (with default branches) and resources
(`src/main/agent-manager/captain-context.ts`), so an edit to the project
reaches the next message. The Captain has no checkout of the project's
repos; the prompt tells it to ask a task agent instead (read-only clones are
a follow-up). It keeps a long-lived `MEMORY.md` in its workspace — decisions,
conventions, open threads — which the prompt injects (capped) and the project
editor shows read-only via `project:getCaptainMemory`.

It is not a task. `role` keeps it out of `DatabaseManager.getTasks()` (so the
board, sidebar, mobile task list and MCP list tools never see it), and the
raw-SQL routes in `task-routes.ts` (`list_tasks`, `find_similar_tasks`,
`get_task_statistics`, `list_repos`) carry the same predicate through
`userTaskRoleFilter()`. It has no lifecycle: `AgentManager` never writes a
status to it, going idle only reports idle, and `isCoordinatorTask()` in
`src/shared/task-roles.ts` is the one check for "this row is a conversation,
not work". The renderer asks for a project's id with
`tasks:getCoordinatorTaskId(projectId)` instead of carrying a fixed string;
the coordinator-store keys the ids by project, so the Orchestrator drawer and
the dashboard command input follow the current project.

## State Transitions

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    ▼                                         │
              ┌───────────┐    auto-triage     ┌──────────┐  │
  Created ──> │not_started│ ─────────────────> │ triaging │  │
              └─────┬─────┘ <──────────────── └──────────┘  │
                    │         triage complete                 │
                    │         (agent_id now set)              │
                    │                                         │
                    │  auto-run / manual start                │
                    ▼                                         │
              ┌─────────────┐                                │
              │agent_working│                                │
              └──────┬──────┘                                │
                     │  agent goes idle                      │
                     ▼                                       │
              ┌────────────────┐   feedback    ┌──────────────┐
              │ready_for_review│ ────────────> │agent_learning│
              └───────┬────────┘               └──────┬───────┘
                      │  user completes               │ learning done
                      ▼                               │
              ┌───────────────┐                       │
              │   completed   │ <─────────────────────┘
              └───────────────┘
```

### Transition Details

| From | To | Trigger |
|------|----|---------|
| (new) | `not_started` | Task created (UI, MCP, sync, API) |
| `not_started` | `triaging` | Auto-run enabled, task has no `agent_id` |
| `triaging` | `not_started` | Triage agent finishes (agent_id now assigned) |
| `not_started` | `agent_working` | Auto-run picks up task (has agent_id), or manual start |
| `agent_working` | `ready_for_review` | Agent session goes idle (`transitionToIdle`) |
| `ready_for_review` | `completed` | User clicks "Complete Task" (no session, or feedback skipped) |
| `ready_for_review` | `agent_learning` | User submits feedback; the feedback prompt is sent to the session |
| `agent_learning` | `completed` | Session goes idle; skills synced (`finishSessionFeedback`) |
| `agent_learning` | `ready_for_review` | Skill sync or source completion fails |

## Auto-Run

Auto-run is toggled via the Play button in the sidebar. When enabled, the scheduler (`use-agent-auto-start.ts`) continuously monitors tasks and starts agent sessions automatically.

### Eligibility Criteria (regular auto-start)

A task is eligible for auto-start when ALL conditions are true:

- `status === 'not_started'`
- `agent_id` is set
- Not snoozed (`snoozed_until` is null or in the past)
- No active session exists for this task

### Scheduling

- Tasks are grouped by `agent_id`
- Each agent respects `max_parallel_sessions` (default: 1)
- Tasks are sorted by priority (critical > high > medium > low)
- Excess tasks are queued per-agent
- When an agent goes idle, the next queued task starts
- A periodic check (60s) catches any stuck tasks

## Per-Task Automation Flags

Two flags on a task drive it without any human, and without any window:

| Flag | Effect |
|------|--------|
| `auto_start_agent` | The task is handed to its agent as soon as it exists or becomes due. Set it on a recurring task and every occurrence runs by itself. |
| `auto_complete_without_review` | The task goes straight to `completed` when its agent finishes, instead of stopping at `ready_for_review`. |

Both are owned by the **main process**, not the renderer, and both are
independent of the sidebar auto-run toggle:

- `src/main/task-automation-scheduler.ts` reconciles them against SQLite every
  60 seconds, and on demand whenever a task is created or its status changes.
  Because it reconciles durable state rather than reacting to an event, a
  missed event costs latency, never correctness.
- `src/main/agent-manager.ts` (`transitionToIdle` →
  `completeTaskWithoutReview`) applies `auto_complete_without_review`
  immediately when a session goes idle.

Both flags can be set from the desktop UI, the mobile UI, the HTTP API, and the
`create_task` / `update_task` MCP tools.

> These used to live in `use-agent-auto-start.ts`, driven by one-shot
> `task:created` / `task:updated` events. That made them silently
> window-dependent — an occurrence created while the window was closed was
> never started, and never retried.

### Flags and subtasks

A task that works through subtasks obeys these rules:

- A parent is **never completed while a child is unfinished**. Its agent can
  create children and then stop; completing there would mark the occurrence
  done with none of the work run. The parent is parked in `ready_for_review`
  and completes once every child is terminal.
- A child is started **through its parent**, one at a time, in `sort_order`.
  Only a genuinely running child (`agent_working`, `triaging`,
  `agent_learning`) blocks the next one. A child in `ready_for_review` has
  finished its agent run and does not block, because a subtask cannot set
  itself to `completed`.

  This is **one rule with one implementation**: `isSiblingBlocking` /
  `findBlockingSibling` in `src/shared/subtask-graph.ts`, used by the renderer
  auto-start hook (`use-agent-auto-start.ts`), `TaskAutomationScheduler` and
  `AgentManager.startTask`'s `preferSubtasks` path. Blocking on
  `ready_for_review` in any one of them deadlocks every unattended chain at
  its first step.
- `/create_subtask` passes `auto_complete_without_review` down from the
  parent, so an unattended chain does not park in review at its first step.
  `auto_start_agent` is **not** passed down — children are started through the
  parent, which is what keeps them in order.

### Successor edges (`next_subtask_ids`)

A subtask can name the sibling(s) that run after it. Once any subtask of a
parent has started and edges exist, the graph — not `sort_order` — owns
sequencing (`isSuccessorGraphInProgress`), and
`AgentManager.notifyParentOfSubtaskCompletion` starts the selected successors
or wakes the parent to decide.

Successors normally fire when a subtask reaches `completed`. They also fire
from `ready_for_review` when the chain opts in
(`successorsFireOnReview` in `src/shared/subtask-graph.ts`): the parent carries
`auto_start_agent` or `auto_complete_without_review`, or the subtask itself
carries `auto_complete_without_review` (which `/create_subtask` passes down).
No new field is involved — the existing unattended flags *are* the opt-in.

The finished step stays in `ready_for_review`. Only ordering moves on:
`completeTaskWithoutReview` still refuses to accept a local agent's own result,
so a human accepts every step whenever they get to it, and the chain does not
wait for them. Without an opt-in, a chain advances only as a human accepts each
step — the old behaviour.

## Auto-Triage

When auto-run is enabled and a new task has no `agent_id`, the system automatically triages it using the default agent.

### Triage Flow

```
New task (no agent_id, status=not_started)
    │
    ▼
selectTriageCandidates() detects it
    │
    ▼
startTriage() → status='triaging' → start default agent
    │
    ▼
agent-manager detects status='triaging' → builds triage prompt
    │
    ▼
Default agent runs:
  → find_similar_tasks (keyword matching on historical tasks)
  → list_agents, list_skills, list_repos
  → update_task(agent_id, skill_ids, labels, priority, repos)
    │
    ▼
Agent goes idle → transitionToIdle()
  → detects isTriageSession → status back to 'not_started'
  → removes triage session from store
    │
    ▼
Auto-run detects task with agent_id + status=not_started
  → starts assigned agent via normal auto-run flow
```

### Triage Prompt

The triage agent receives a structured prompt that instructs it to:

1. Call `find_similar_tasks` with keywords from the task title/description
2. Call `list_agents` to see available agents
3. Call `list_skills` to see available skills
4. Call `list_repos` to see the repositories of the task's project (the prompt lists them too)
5. Determine the best `agent_id`, `skill_ids`, `repos`, `priority`, and `labels`
6. Call `update_task` once with all determined values
7. NOT work on the task itself

### Triage Safety

- **Status guard:** The `/update_task` API skips status changes when a task is in `triaging` status. This prevents the triage agent from accidentally changing the task status.
- **Retry limit:** Max 2 triage attempts per task. If the agent fails to assign an `agent_id` after 2 tries, a toast notification tells the user to assign manually.
- **Session cleanup:** The triage session is removed from the agent store after completion so the task becomes eligible for auto-start.
- **No triage when disabled:** If auto-run is off, no triage happens.
- **Pre-assigned tasks skip triage:** Tasks created with `agent_id` already set go directly to auto-run.
- **Project repos only:** `create_task`, `update_task` and `create_subtask` check `repos` against the task's project (`validateProjectRepos` in `src/main/agent-manager/project-repos.ts`). An unknown repo fails the call with an error that lists the project's repos; it is never silently dropped. Repos the task (or its parent) already carries stay allowed.

## Projects: repos and MCP scope

A task's repos, git provider and org come from its project: its `project_repos` rows, then the project's `git_provider` / `git_org`. The global `git_provider` / `github_org` settings are a fallback for the Default project only (`src/main/agent-manager/project-repos.ts`). A project with no repos runs its tasks in an empty workspace.

The task-management MCP tools have three scopes (`src/main/mcp-servers/task-management-core.ts`):

- **Subtask scope** (`?task=&parent=`): subtask agents, parent and siblings only.
- **Project scope** (`?project=<id>`): every other task agent and the Captain (for its row's `project_id`: one Captain per project, see `coordinatorProjectScope` in `session-config.ts`). List and search tools (`list_tasks`, `find_similar_tasks`, `get_task_statistics`, `get_recent_activity`, `list_pending_approvals`, `list_repos`) are narrowed to the project, `create_task` lands in it, and any call naming a `task_id`, `parent_task_id`, `subtask_ids` or `next_subtask_ids` outside it is refused.
- **Full access** (no scope): internal and debug use only — a direct run of `task-management-mcp.js` without `TASK_SCOPE_PROJECT_ID`, or a session with no task row behind it.

### Manual Triage

A "Triage" button (with sparkle icon) appears in the task detail view when no agent is assigned. Clicking it manually triggers the same triage flow.

## MCP Tools for Triage

The task-management MCP server provides these tools used during triage:

| Tool | Purpose |
|------|---------|
| `find_similar_tasks` | Find historical tasks by keyword matching (title, description, type, labels) |
| `list_agents` | List all available agents with capabilities |
| `list_skills` | List all available skills |
| `list_repos` | List the project's repos with provider, org and default branch |
| `update_task` | Assign agent_id, skill_ids, labels, priority, repos |

### `find_similar_tasks` Algorithm

Uses SQL `LIKE` substring matching — not semantic search:

- `title_keywords` → `WHERE title LIKE '%keyword%'`
- `description_keywords` → `WHERE description LIKE '%keyword%'`
- `type` → exact match
- `labels` → JSON substring match
- `completed_only` → filters to completed tasks only (default: true)

## Project events and Captain wake-ups (#57)

The Captain used to act only when the user talked to it. Now the main
process raises a `ProjectEvent` (`src/main/project-events.ts`) at the places
where something happens to a task, and the `CaptainWaker`
(`src/main/captain-waker.ts`) turns a project's events into one wake-up
for that project's Captain.

Event kinds and where they are raised:

| Kind | Raised from |
|------|-------------|
| `task_ready_for_review` | `afterTaskUpdated` (task API, IPC, mobile) and `AgentManager.updateTaskFromLocalAgent` (an agent's own work reaching review) |
| `task_failed` | `AgentManager.emitStatus` when a session goes to `error` |
| `approval_pending` | `AgentManager.emitStatus` when a session goes to `waiting_approval` |
| `chain_stuck` | `notifyParentOfSubtaskCompletion` when a successor is missing, has no agent, or fails to start |
| `heartbeat_finding` | `HeartbeatScheduler.forwardFindings`, after its own dedupe, for forwarded and escalated findings alike |
| `task_synced` | `SyncManager.importTasks`, for every row a run created (flagged `unassigned` when it has no agent) |

`emitTaskEvent(db, kind, taskId, detail?)` looks the task up, drops
coordinator rows (the Captain's own session must never wake itself) and
clips the detail to 400 characters, so each hook is one line.

The waker holds a project's events for a debounce window (3 s), then sends
ONE fenced system message (`buildSystemMessage`, origin `coordinator-wakeup`,
the same authority boundary as the subtask wake-up) to the project's
coordinator row through `AgentManager.sendMessage`, which rejoins the live
session or resumes the persisted one. A Captain that is mid-turn is not
interrupted: the batch waits for idle (dropped after 15 min). Rules:

- **Per-project setting.** `projects.settings.captain_wakeups`
  (`src/shared/captain-wakeups.ts`): `{ enabled, kinds[] }`; absent means
  on for every kind. The project editor's "Captain wake-ups" section edits
  it.
- **Self-caused events are skipped.** The task-management MCP dispatch reports
  every successful call (`setToolCallObserver`); a coordinator-shaped scope
  (project scope, no artifact pin) touching a task marks it for 20 s, and
  events on marked tasks do not wake the Captain.
- **Cap.** At most 12 wake-ups per project per rolling hour; the first dropped
  batch is logged (`[CaptainWaker] Wake-up cap reached`).
- Duplicate (kind, task) pairs inside one window are one line; a batch lists
  at most 40 events and counts the rest.

## Project status (#58)

`project_status` (`project_id` PK, `summary`, `top_blockers` JSON,
`updated_at`) holds the Captain's narrative snapshot for a project, one
row per project. Counts are never stored: `DatabaseManager.getProjectStatus`
computes `running` (`agent_working` / `triaging`), `awaiting_review`
(`ready_for_review`) and `blocked` (`not_started` with no agent and no
queued start) from the task rows, and takes `queued` (admission queue) and
`awaiting_approval` (session state) from the caller —
`src/main/project-status.ts` reads those from the `AgentManager`. No LLM is
involved in any count.

The Captain writes the narrative with the project-scoped tool
`update_project_status(summary, top_blockers?)` (route
`/update_project_status`; the scope forces `project_id`, and a task agent in
the same project is refused). Its prompt tells it to call the tool after a
meaningful round of work and after every wake-up. The renderer reads
`project:getStatus` and is pinged on `project:statusChanged`; the project
switcher and Settings → Projects show the counts, the summary and its age.

### Status journal (#72)

`project_status_journal` (`id`, `project_id` FK cascade, `summary`,
`completed` / `blockers` / `decisions` / `next_steps` JSON lists, `source`
(`captain` | `compaction`), `correlation_id`, `created_at`; indexed on
`(project_id, created_at DESC, id DESC)`) keeps one row per status update
beside the snapshot. `update_project_status` accepts the optional lists
(`completed`, `blockers` — default `top_blockers` —, `decisions`,
`next_steps`, at most 8 items of 200 characters each) and a
`correlation_id`; `DatabaseManager.recordProjectStatus` writes the snapshot
and the entry in one transaction. The snapshot stays the cheap read and its
shape is unchanged; nothing from the journal is ever put in a system prompt
or in `list_projects`.

Reads are pages: `readProjectStatusHistory` (`src/main/project-status.ts`)
returns entries newest first over `(created_at, id)`, with an opaque cursor
(the boundary of the last entry served) so pages stay stable while new
entries arrive. Default 5 entries, hard maximum 20; each entry's summary and
lists are clipped, and entries are dropped from the end of a page that would
exceed the page cap (`has_more` and `next_cursor` then point at them). The
Commander's `get_project_status_history(project, limit?, cursor?)` and the
project editor's read-only **Status history** section (IPC
`project:getStatusHistory`) both read through it.

Retention: `DatabaseManager.compactProjectStatusJournal` runs at every start
(`initialize()`) and rolls Captain entries older than 90 days into one
`compaction` entry per project and calendar month: a dated line per folded
summary (capped at 2,000 characters, newest lines kept) and the deduplicated
union of each list (capped at 16 items), dated at the newest folded entry. An
existing roll-up for the month absorbs late arrivals, so the run is idempotent.
Rows go with their project (`ON DELETE CASCADE`); archiving leaves them.

### Reporting to the Commander (#62)

`report_to_commander(message, correlation_id?)` (route `/report_to_commander`;
coordinator-only and project-forced like `update_project_status`, message
capped at 4,000 characters) hands a report to the Commander through the seam
in `src/main/commander/report-inbox.ts`; docs/commander.md describes where it
lands. Section 11 of the Captain prompt tells it to answer Commander
requests with it (quoting the relay's correlation id) and to report unasked
when the user must decide something. `tell_commander` escalations (#66)
reach the Commander the same way, without the Captain doing anything.

## Project limits, pause and escalation policy (#65, #66)

Both live in the project's `settings` JSON column under their own keys (`src/shared/project-policies.ts`), edited in the project editor's **Limits** and **Escalation** sections. Missing values mean the defaults.

### Limits (`settings.limits`)

| Key | Default | Effect |
|-----|---------|--------|
| `max_concurrent_agents` | null (unlimited) | Working sessions of real tasks in the project; checked in `checkAdmission` (`src/main/agent-manager/admission.ts`) against the running sessions' projects |
| `daily_session_cap` | null | Sessions started since local midnight, counted in the `project_daily_usage:<projectId>` settings row (`src/main/project-limits.ts`) |
| `daily_token_cap` | null | Stored and shown; `recordProjectTokenUsage` is the seam, no adapter reports a per-session token total yet |
| `paused` | false | New starts wait; running sessions are untouched |

The global pause is the `all_projects_paused` setting: `AgentManager.pauseAllProjects(paused)` sets it and drains the queue when lifted (IPC `projectLimits:pauseAll`; the Commander's "pause all projects" tool of #61 calls the same method).

A start over a limit goes into the existing FIFO start queue with a reason of `project_limit`, `project_daily_cap`, `project_paused` or `global_pause` (beside `agent_limit` and `global_limit`). The `start_task` tool's result says which. The project's Captain is also told in a short fenced system message when its session is live and idle (once per project and reason until a queued start runs). Coordinator (Captain), heartbeat and triage sessions bypass all of it, as before. The queue is re-checked when a project's settings are saved (`project:update`), when the global pause is lifted, on every session idle/stop, and on every idle-session sweep, which is also what reopens a project after midnight. `AgentManager.getProjectLimitState(projectId)` (IPC `projectLimits:getState`) reports the limits, the live counts, the queued starts and what the next start would wait for; the project status (#58) carries it as `limits`.

### Escalation policy (`settings.escalation`)

Per action, one of `autonomous`, `tell_commander` or `ask_user`:

| Action | Default | Tool calls covered |
|--------|---------|--------------------|
| `create_task` | autonomous | `create_task`, `create_subtask` |
| `start_task` | autonomous | `start_task` |
| `stop_task` | tell_commander | `stop_task` |
| `respond_to_checkpoint` | ask_user | `respond_to_checkpoint` |
| `change_priority` | autonomous | `update_task` with a `priority` |
| `pr` | ask_user | none: prompt guidance only, no task-management tool opens or merges pull requests |

The policy is a section of the Captain prompt (`src/main/prompts/captain.ts`) and is enforced for coordinator-scope calls by a gate on the project-scoped dispatch (`setCoordinatorCallGate` in `task-management-core.ts`, installed by `src/main/escalation.ts` when the Task API server starts). Task agents in the same project are not gated. `tell_commander` runs the call, then calls `escalateToCommander(event)` and shows a user notification; `ask_user` holds the call in memory, returns `{ status: 'held', id }` to the Captain, notifies the user, and the status bar's held-actions notice approves (runs the original call) or rejects it over IPC (`escalation:approve` / `escalation:reject`); either way the Captain's live session gets a fenced note with the outcome. `escalateToCommander` is a no-op seam until #62's `report_to_commander` installs a handler with `setCommanderEscalationHandler`. Held calls are not persisted: a restart forgets them.

## Scheduled Captain reviews (#67)

A project can wake its Captain on a schedule to review the board, re-plan
and update the project status. The setting is a keyed block of
`projects.settings`, edited in the project editor's "Scheduled review" section.
It is off by default:

```json
{ "scheduled_review": { "enabled": false, "cron": "0 9 * * 1-5" } }
```

`src/main/scheduled-coordination.ts` checks it every minute in the main
process, so it runs with the window closed. The cron is 5 fields in local
time. At each occurrence:

- a paused project (its own `limits.paused`, or the global `all_projects_paused`)
  is skipped, and the skip is logged;
- a Captain that is mid-turn is tried again on the next tick while the
  occurrence is under 6 hours old;
- otherwise the project's coordinator row gets one fenced system message
  (`buildScheduledReviewMessage`: origin `coordinator-wakeup`, the current
  counts and last status summary as findings, and instructions to review,
  re-plan and finish with `update_project_status`). It is sent through
  `AgentManager.sendMessage`, the same rejoin-or-resume path the event waker
  uses.

The last occurrence handled is stored per project in the app setting
`scheduled_review_state:<projectId>` (`{ cron, last }`) before the send. A
restart therefore does not wake the Captain twice. Enabling a review, or
changing its cron, starts from that moment. An occurrence missed while the
app was closed runs once at start-up if it is under 6 hours old. The
Commander's scheduled briefing uses the same scheduler (docs/commander.md).

## Key Files

| File | Role |
|------|------|
| `src/main/project-events.ts` | Project event bus, `emitTaskEvent` |
| `src/main/captain-waker.ts` | Batched, debounced, capped Captain wake-ups |
| `src/shared/captain-wakeups.ts` | Event kinds and the per-project wake-up setting |
| `src/main/project-status.ts` / `src/shared/project-status.ts` | Project status counts + narrative |
| `src/shared/constants.ts` | `TaskStatus` enum |
| `src/main/agent-manager.ts` | Session lifecycle, `transitionToIdle` |
| `src/main/agent-manager/prompts.ts` | `buildTriagePrompt` |
| `src/main/task-api/task-routes.ts` | HTTP API routes (`/update_task` status guard, `/list_repos`) |
| `src/main/mcp-servers/task-management-mcp.ts` | MCP tool definitions |
| `src/main/task-automation-scheduler.ts` | `auto_start_agent` / `auto_complete_without_review` reconciliation |
| `src/renderer/src/hooks/use-agent-auto-start.ts` | Auto-run scheduler + triage trigger |
| `src/renderer/src/components/tasks/TaskWorkspace.tsx` | Manual triage button wiring |
| `src/renderer/src/components/tasks/TaskDetailView.tsx` | Triage button UI |
| `src/renderer/src/stores/agent-store.ts` | Session state management |
| `src/renderer/src/stores/agent-scheduler-store.ts` | Running counts, queues |
