# Skills

Skills are reusable SKILL.md instructions that agents discover and load on-demand during sessions. They're stored in SQLite and written to the agent workspace at session start, so OpenCode can surface them via the `skill` tool.

## Data Model

```
Skill {
  id: string
  name: string          // ^[a-z0-9]+(-[a-z0-9]+)*$ (1-64 chars)
  description: string   // 1-1024 chars
  content: string       // markdown body
  version: number       // auto-incremented on update
  created_at, updated_at
}
```

Skills can be assigned at two levels:
- **Task-level**: `task.skill_ids`
- **Agent-level**: `agent.config.skill_ids`
- **Unset** (both null): no skill files are written

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

`SkillSyncResult = { created: string[], updated: string[], unchanged: string[] }`

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
| `src/main/agent-manager.ts` | `syncSkillsFromWorkspace`, `transitionToIdle` (learning completion) |
| `src/main/session-feedback.ts` | `updateTaskFromUser`, `finishSessionFeedback` |
| `src/main/database.ts` | `getSkillByName`, skill CRUD, `getSkillsByIds` |
| `src/renderer/src/components/tasks/FeedbackDialog.tsx` | Rating dialog |
| `src/renderer/src/components/tasks/workspace/useTaskFeedbackFlow.ts` | Feedback orchestration |
| `src/renderer/src/components/skills/` | Skill management UI |
| `src/renderer/src/stores/skill-store.ts` | Zustand store for skills |
