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
reaches the next message.

Changing the Captain's agent (the Captain drawer's picker, the project
editor, or the Commander's `update_project`) is saved on the project as
`captain_agent_id`, so the drawer, `ask_captain`, wake-ups, scheduled reviews
and the next launch all start the same agent. Whenever it changes,
`AgentManager.releaseCaptainIfAgentChanged` stops a live session still on
the old agent. A persisted session is bound to the agent that made it (setting
`captain_session_agent:<taskId>`): a start or send with another agent opens a
fresh session instead of resuming it, because another backend cannot continue
it (Claude Code even accepts a Codex thread id and fails only at the first
message). A Captain start is bounded (`CAPTAIN_START_TIMEOUT_MS`, 90 s): past
that it fails with the reason in the transcript, and a session that comes up
late is stopped. The drawer then shows the reason with **Retry** and **Switch
back to** the previous agent, and holds messages sent in the meantime until
a start succeeds, then delivers each one once.

The Captain has no checkout of the project's
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
when the user must decide something. The Captain's merges and issue writes
reach the Commander the same way, without the Captain doing anything.

## Project limits and pause (#65)

Limits live in the project's `settings` JSON column under the `limits` key (`src/shared/project-policies.ts`), edited in the project editor's **Limits** section. Missing values mean the defaults.

### Limits (`settings.limits`)

| Key | Default | Effect |
|-----|---------|--------|
| `max_concurrent_agents` | null (unlimited) | Working sessions of real tasks in the project; checked in `checkAdmission` (`src/main/agent-manager/admission.ts`) against the running sessions' projects |
| `daily_session_cap` | null | Sessions started since local midnight, counted in the `project_daily_usage:<projectId>` settings row (`src/main/project-limits.ts`) |
| `daily_token_cap` | null | Stored and shown; `recordProjectTokenUsage` is the seam, no adapter reports a per-session token total yet |
| `paused` | false | New starts wait; running sessions are untouched |

The global pause is the `all_projects_paused` setting: `AgentManager.pauseAllProjects(paused)` sets it and drains the queue when lifted (IPC `projectLimits:pauseAll`; the Commander's "pause all projects" tool of #61 calls the same method).

A start over a limit goes into the existing FIFO start queue with a reason of `project_limit`, `project_daily_cap`, `project_paused` or `global_pause` (beside `agent_limit` and `global_limit`). The `start_task` tool's result says which. The project's Captain is also told in a short fenced system message when its session is live and idle (once per project and reason until a queued start runs). Coordinator (Captain), heartbeat and triage sessions bypass all of it, as before. The queue is re-checked when a project's settings are saved (`project:update`), when the global pause is lifted, on every session idle/stop, and on every idle-session sweep, which is also what reopens a project after midnight. `AgentManager.getProjectLimitState(projectId)` (IPC `projectLimits:getState`) reports the limits, the live counts, the queued starts and what the next start would wait for; the project status (#58) carries it as `limits`.

### The Captain's GitHub tools

The Captain acts on its own. There is no per-action escalation policy, no held call waiting for approval and no merge grant: schema 32 dropped the `merge_grants` tables and the `escalation` and `merge_grants` blocks of project settings. What remains is scoping (the signed MCP scope, the project's repositories) and GitHub's own checks.

`merge_pull_request` and the issue tools have no Task API route. The Captain's project-scoped calls pass through `setCoordinatorCallHandler` in `task-management-core.ts`, installed by `src/main/captain-github-tools.ts` when the Task API server starts; it answers those tools and runs every other call. Task agents in the same project cannot call them (`COORDINATOR_ONLY_TOOLS`). A merge, a settled issue create or update, and anything blocked on a person outside 21x become a `CaptainActionEvent`: an OS notification and, through `setCaptainActionHandler` (installed by `installCommanderReportBridge`), an unprompted Commander report.

### Merging pull requests (#137)

`merge_pull_request` (`src/main/pull-request-merge.ts`) reads fresh GitHub state and refuses unless the PR is in one of the project's GitHub repos and `gh pr view` reports: open, not a draft, every check passed or skipped, `mergeStateStatus` CLEAN or HAS_HOOKS, and no `REVIEW_REQUIRED`/`CHANGES_REQUESTED`. It also requires `mergeable: MERGEABLE` and complete, consistent PR, check, author and exact-head review data; anything missing fails closed. A PR whose latest verified 21x review attestation of that exact head is `CHANGES_REQUIRED` is refused with `REVIEW_CHANGES_REQUIRED`. It merges with `gh api --method PUT repos/<owner>/<repo>/pulls/<number>/merge -f sha=<checked-sha> -f merge_method=squash|merge|rebase`, a fixed argument list with no bypass option. The synchronous endpoint cannot silently enable auto-merge or enqueue a merge, unlike `gh pr merge`, and the SHA precondition makes GitHub refuse if the head moved after the check. Only GitHub's confirmed merged response is reported as success; an ambiguous response or timeout returns `unknown` and asks for inspection.

- **External approvals.** A missing required review, CODEOWNERS approval, requested changes or unmet protection returns `blocked` with `needs_external_approval`, and is reported to the Commander once per PR head. It is never bypassed.
- **Readiness snapshots.** Every read is recorded as a `pr_readiness_snapshots` revision (migration v27), invalidated on any material change: head, base, draft, mergeability, reviews, checks or attestation.
- **Audit.** Each merge appends a project status journal entry, sends a notification, and reports to the Commander.

Whether a PR is obsolete, duplicate or depends on an unlanded predecessor remains a Captain workflow decision: the prompt requires current evidence before each merge and forbids blind retries.

Residual risk: agents still have a shell with the user's `gh` credentials. The Captain prompt forbids merging any other way, but a shell-level `gh pr merge --admin` is outside what 21x can intercept.

### Delegated GitHub issue writes

Opening an issue for work the user asked for is ordinary bookkeeping. The action taxonomy in `src/shared/issue-actions.ts` defines what the issue tools may do, and `src/main/issue-writes.ts` implements it.

- **Classes.** `delegated_issue_write` is the only class a Captain performs as ordinary project work. `merge_or_approve`, `deploy_or_release`, `destructive_delete`, `migration_or_replay`, `protection_bypass`, `outbound_message` and `credential_change` are out of the issue tools' reach; `checkIssueWriteCapability` refuses such a class before it looks at anything else, so "merge this" is never answered with a repository complaint.
- **Actions.** Exactly three: `create_issue`, `update_issue` (title, body, labels) and `link_issue` (a 21x-side association; nothing is sent to GitHub). Commenting, closing, reopening, assigning, transferring, deleting and locking are in `NON_DELEGATED_ISSUE_OPERATIONS` and have no tool at all — a comment notifies subscribers, a close is a decision.
- **Scope.** Only the project's configured GitHub repositories (`getProjectRepos`, provider `github`) and only tasks in the project; the MCP dispatcher's membership check refuses a cross-project `task_id` before the gate is reached. Arguments in `FORBIDDEN_ISSUE_ARGS` (`token`, `gh_host`, `as_user`, `admin`, …) are refused: the write always runs as the user's own authenticated `gh` against github.com. A body that looks like it carries a credential, or that `@mentions` anyone, is refused.
- **Exactly once.** `issue_writes` (migration v24, `database/issue-writes-migration.ts`) is both the audit ledger and the idempotency claim, with `idempotency_key` UNIQUE. Every claimed key is immutably bound to its action, repository, target, task, exact payload shape/hash and calling Captain; reusing it for anything else is refused even after failure, without rewriting the original audit row. An exact retry recomputes the same key across a restart. A created issue also carries `<!-- 21x-issue-write:<key> -->` in its body, which is what makes an external success findable. A claim whose lease expires becomes `unresolved`, never free.
- **Reconciliation.** `reconcileIssueWrites` runs at startup (`recoverIssueWriteOutcomes`) and whenever the ledger is read. For a create it searches the repository for the marker: exactly one hit in a result set GitHub confirms is complete is only a candidate; its canonical repository/issue identity and title/body/labels in the durable `payload_fields` shape must also reproduce the ledger's `payload_hash`. Zero, a truncated/incomplete search, copied/mismatched evidence, or multiple distinct marker hits stay `unresolved`. A negative search is not a linearizable absence proof. For an update it hashes only the requested fields recorded in `payload_fields`. Attempt epochs prevent a late writer from settling a row after its lease passed to reconciliation. Successful rows whose local effects were interrupted replay an atomic task-attachment + journal transaction guarded by `effects_applied_at`. `confirmedIssueWriteFailure` distinguishes a refusal GitHub certainly made (HTTP 4xx, `ENOENT`) from an unknown outcome (timeout, reset, kill).
- **Scope and payload.** The project's configured repositories are intersected with any repository restrictions on both the calling Captain task and target task, and the full intersection is rebuilt after preflight before a write may dispatch. Update/link performs a GitHub read preflight and refuses pull-request targets. Secret detection scans title, body and every label. Nonempty labels use `gh api` raw nested fields so scalar-looking names such as `true`, `00123` and `null` remain JSON strings on the wire; the valueless typed `labels[]` sentinel represents an explicit empty array.
- **Audit.** Each row records the Captain's task and session, the repository, the action and target, the payload hash, the external URL/number and GitHub's answer, the attempt count, local-effects marker, and created/updated/settled timestamps. Each successful write appends exactly one project status journal entry naming the Captain that wrote it and, when scoped to a task, attaches the issue URL exactly once. `list_github_issue_writes` reads the ledger and reconciles as a side effect.

### Unified ordinary task and PR lifecycle

Task creation, update and start need no per-message permission: a signed caller
scope can create, update and start tasks in its own project. Starting still goes
through the existing admission controller, which decides capacity, dependency
and file-overlap.

A coding task uses `open_draft_pull_request`. The operation
derives the task workspace from the signed scope, intersects the task repo with
current project configuration, requires a clean non-base branch whose origin
matches the repository, refuses multiple/different push URLs and URL rewriting,
checks that the configured base is an ancestor, pushes an immutable SHA to its
exact branch ref without force, verifies that remote ref, and opens a draft
through fixed argument arrays. It re-reads worktree and live scope
after every remote lookup and checks for an exact existing PR before and after
the push, so repository removal wins and restart or a lost response
does not duplicate the PR. The task-only tool is served to nested and top-level
signed agents, never Captains or raw sessions. It has no merge, approval,
auto-merge, admin, force-push or protection option; those controls remain
separate.

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
