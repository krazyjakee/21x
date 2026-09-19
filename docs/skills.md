# Skills

Skills are reusable SKILL.md instructions that agents discover and load on-demand during sessions. They're stored in SQLite and written to the agent workspace at session start, so OpenCode can surface them via the `skill` tool.

## Data Model

```
Skill {
  id: string
  name: string          // ^[a-z0-9]+(-[a-z0-9]+)*$ (1-64 chars), unique across all scopes
  description: string   // 1-1024 chars
  content: string       // markdown body
  version: number       // auto-incremented on update and on a scope change
  preferred_model: string | null  // optional model id; null = use the agent's model
  project_id: string | null       // null = global; an id = owned by that project (#74)
  created_at, updated_at
}
```

Skills can be assigned at two levels:
- **Task-level**: `task.skill_ids` — global skills and the task's project's own
- **Agent-level**: `agent.config.skill_ids` — global skills only (an agent serves every project)
- **Unset** (both null): no skill files are written

## Scope (#74)

A skill is either **global** (`project_id` null) or a **project skill**
(`project_id` set). Schema version 16 adds the column (`migrateSkillScope` in
`src/main/database/schema.ts`); every skill that existed before the upgrade
stays global, so nothing disappears from any project.

Names are unique across both scopes (`idx_skills_name`, checked in every
create/rename path). A project skill therefore never shadows a global one, and
a task workspace can hold both kinds without a `SKILL.md` directory collision.
Per-scope names with an explicit shadowing rule can come later.

### Who sees what

| Caller | Sees | May create | May change / delete | May change scope |
|---|---|---|---|---|
| Skills view (the user) | everything | any scope | anything | promote / move, confirmed in the dialog |
| Commander (`commander/skill-tools.ts`) | everything (archived projects' skills on request) | global, or a named project's | anything, after the confirmation challenge | `promote_skill`, `move_skill`, after confirmation |
| Mastermind (project scope) | global + its project's | its project's | its project's own | no |
| Task agent / subtask agent | global + its project's | its project's | its project's own | no |
| Feedback learning (`syncSkillsFromDirectory`) | — | in the task's project | the task's project's own | no |

Visibility is enforced where a skill is read, not in the prompt:

- `list_skills`, `get_skill`, `update_skill` and `delete_skill` for a session go
  through `task-api/skill-routes.ts` with a scope the MCP dispatcher attaches
  (`SKILL_SCOPE_PARAM` in `task-management-core.ts`; it overwrites anything the
  caller sent under that key). A skill outside the visible set is refused with
  the same message whether it exists or not, so ids cannot be probed.
- `create_task`, `create_subtask` and `update_task` refuse `skill_ids` naming
  another project's skill (`validateSkillAssignment`), with the skill names.
- `writeSkillFiles` writes only the skills the task's project may see; an
  agent-level default that is a project skill of another project is skipped
  and logged rather than copied into the workspace.
- The task skill picker offers global plus the task's project's skills; the
  agent form offers global skills only.

### Defaults

- **Commander**: `create_skill` makes a global skill unless `project` names one.
- **Mastermind / task agent**: `create_skill` makes a skill owned by the
  session's project. `global: true` is refused with a message that the user
  must create it in the Skills view or through the Commander: a session cannot
  obtain the user's confirmation, and the #66 escalation policy has no action
  for skill changes today. The Mastermind may still assign global skills to
  its tasks.
- **Feedback learning**: a skill the session wrote into its workspace is
  created in the task's project. A changed **global** skill, or one another
  project owns, is *not* written back: it is reported in
  `SkillSyncResult.skipped` and logged. Improving a global skill from a task
  is a promotion decision for the user.
- **Skills view**: a new skill takes the scope of the active filter (a project
  when one is selected, else global).

### Promote and move

Changing scope is never part of a field update (`UpdateSkillData` has no
`project_id`); it is `DatabaseManager.setSkillProject`, reached only by:

- the editor's Scope section (Promote / Move button, confirmation dialog);
- the Commander's `promote_skill` (project → global) and `move_skill`
  (→ a project), both behind the one-time confirmation challenge.

Promotion never breaks anything. A move into a project is refused while tasks
in other projects or agent-level defaults still reference the skill; the
refusal names them. Both bump the version.

### Concurrent edits

`UpdateSkillData.expected_version` (the `expected_version` argument of the
MCP and Commander `update_skill` tools; the editor sends the version it
loaded) makes a content write conditional on the row still having that
version. A stale write throws `SkillVersionConflictError` / returns
`{ conflict: 'stale_version', current_version }`, so two Masterminds, a
learning session and the Commander cannot silently overwrite each other.
Usage updates (`uses`, `last_used`) are never version-checked.

### Archived projects

A project is archived, not deleted, so its skills keep their `project_id` and
their history. They are hidden from the Commander's `list_skills` unless
`include_archived_projects` is set, and the Skills view lists an archived
project in the scope filter only while it still owns skills.

## SKILL.md Format

```markdown
---
name: git-release
description: Create consistent releases and changelogs
---

## What I do
- Draft release notes from merged PRs
- Propose a version bump
```

YAML frontmatter requires `name` and `description`. The directory name must match `name`.
A skill with a preferred model also gets `preferred_model: "<model id>"`.

## Preferred Model

A skill can name the model it runs best with (`skills.preferred_model`,
schema version 14). Set, change or clear it in the skill editor (the backend
dropdown only picks which model list to show), or with the `create_skill` /
`update_skill` MCP tools (`""` clears it). `list_skills` and `get_skill`
return it.

When a session is set up, `assembleSessionConfig` picks the model with
`resolveSkillModel` (`src/main/agent-manager/skill-model.ts`):

1. Skills are taken in order: the task's `skill_ids`, then the agent's
   `skill_ids` (deduplicated). The **first** skill whose preferred model is
   usable on the agent's backend wins; later preferences are ignored.
2. Otherwise the agent's configured model is used.

Tasks have no model setting of their own, so there is no task-level
override today. The chosen model only goes into that session's config (start,
resume and follow-up sends resolve it the same way); the agent record is never
changed, so other sessions keep the agent's model.

A preferred model is usable when the backend's last model listing (OpenCode
and Pi, cached whenever the agent form or skill editor lists models) contains
it. Without a listing, only the id's shape is checked: OpenCode/Pi need
`provider/model`, Claude Code needs a Claude model id, and other backends
reject `provider/model` ids. An unusable preference is skipped: the session
runs with the agent's model, the reason is logged, and a new session shows it
as a system message in the transcript. A missing model never blocks a run.

The field round-trips through workspace SKILL.md files: `writeSkillFiles`
writes `preferred_model`, and `syncSkillsFromDirectory` (the learning loop)
reads it back. A file without the line leaves the stored value alone; an empty
value clears it.

## File Layout in Workspace

```
workspaces/<taskId>/
  .agents/
    skills/
      <skill-name>/
        SKILL.md
```

Written by `writeSkillFiles()` (`src/main/agent-manager/workspace-docs.ts`) before the OpenCode session is created.

## Discovery

OpenCode discovers skills without git. It walks up from the session's working directory looking for `.agents/` (and `.claude/`, `.opencode/`) directories, then scans `skills/**/SKILL.md` inside each.

Since each task gets a unique workspace (`workspaces/<taskId>/`), OpenCode creates a fresh Instance per workspace — no caching issues for new tasks.

## Skill Resolution Priority

In `writeSkillFiles(db, taskId, agentId, workspaceDir)`, the task and agent selections are merged and deduplicated. Only selected skills are written, never all skills. Claude Code agents get them under `.claude/skills/`; other agents get them under `.agents/skills/`.

## Feedback Learning Loop

When a user completes a task that had an active agent session:

```
User clicks "Complete Task"
  │
  ├─ No session/messages → complete immediately
  │
  └─ Has session with messages
       │
       FeedbackDialog (1-5 stars + optional comment)
       │
       ├─ Skip → complete immediately
       │
       └─ Submit
            ├─ Close dialog, set task status to agent_learning
            │  (stores rating, comment, complete-at-source choice)
            └─ Send the feedback prompt through the normal chat flow
               (resuming or starting a session if needed)
                 │
                 Main process, when the session goes idle (transitionToIdle):
                 1. syncSkillsFromWorkspace() → compare with DB
                 2. Create/update changed skills
                 3. finishSessionFeedback() → mark task completed
                    (and complete at source if chosen)
                 On failure → task returns to ready_for_review
```

The feedback flow lives in `useTaskFeedbackFlow.ts`; the `agent_learning` status is what stops the completed-task effect from stopping the session being reused.

### syncSkillsFromWorkspace

`AgentManager.syncSkillsFromWorkspace()` delegates to `syncSkillsFromDirectory()` in `src/main/agent-manager/skills-sync.ts`, which scans `.claude/skills/`, `.agents/skills/` and `.opencode/skills/` (legacy) in the workspace. Handles:

- **Subdirectory layout**: `skills/<name>/SKILL.md`
- **Flat file layout**: `skills/<name>.md` (agent-created)
- **With frontmatter**: parses name + description from YAML
- **Without frontmatter**: derives name from filename (underscores → hyphens)

For each parsed skill:
- Match by name → update if content/description changed (version auto-increments)
- No match → create new skill
- Same content → skip

`SkillSyncResult = { created: string[], updated: string[], unchanged: string[], skipped?: string[] }`

`syncSkillsFromDirectory(db, dir, { projectId })` receives the task's project
from `AgentManager.syncSkillsFromWorkspace`: new skills are created in it, and
only skills it owns are updated (see *Scope* above for what `skipped` holds).

## The Mastermind is not a skill

The Mastermind's instructions are a built-in system prompt (`src/main/prompts/mastermind.ts`). `assembleSessionConfig` puts it first for any coordinator task, whatever the backend, and appends the agent's own `system_prompt` after it. Older installs seeded a "Mastermind" skill. On startup, `seedOrchestratorSkill` soft-deletes that skill and detaches it from agents if its content still matches the seeded text. If the user edited it, it stays as an ordinary skill.

## UI Components

- **SkillWorkspace** — full skill management view
- **SkillList** — lists skills with CRUD
- **SkillSelector** — picker for assigning skills to tasks/agents
- **FeedbackDialog** — star rating + comment after session completion

## Files

| File | Role |
|------|------|
| `src/main/agent-manager/workspace-docs.ts` | `writeSkillFiles` |
| `src/main/agent-manager/skills-sync.ts` | `parseSkillMd`, `syncSkillsFromDirectory` |
| `src/main/agent-manager/skill-model.ts` | Preferred model precedence and validation |
| `src/main/agent-manager/session-config.ts` | Applies the resolved model to the session config |
| `src/main/agent-manager.ts` | `syncSkillsFromWorkspace`, `transitionToIdle` (learning completion) |
| `src/main/session-feedback.ts` | `updateTaskFromUser`, `finishSessionFeedback` |
| `src/main/database.ts` | `getSkillByName`, skill CRUD, `getSkillsByIds`, `setSkillProject`, `getTasksUsingSkill` |
| `src/main/task-api/skill-routes.ts` | Scope-aware skill routes, `validateSkillAssignment` |
| `src/main/commander/skill-tools.ts` | The Commander's skill tools (list, get, create, update, remove, promote, move) |
| `src/shared/skill-scope.ts` | `isSkillVisibleToProject`, `skillScopeLabel` |
| `src/renderer/src/components/tasks/FeedbackDialog.tsx` | Rating dialog |
| `src/renderer/src/components/tasks/workspace/useTaskFeedbackFlow.ts` | Feedback orchestration |
| `src/renderer/src/components/skills/` | Skill management UI |
| `src/renderer/src/stores/skill-store.ts` | Zustand store for skills |
