import type Database from 'better-sqlite3'

/**
 * The Mastermind → Captain upgrade boundary (#71).
 *
 * The project coordinator used to be called the Mastermind, and that name was
 * persisted: the coordinator task row's `role` and title, the
 * `projects.mastermind_agent_id` column, the `mastermind_prewarm` app setting,
 * the `mastermind_wakeups` key inside `projects.settings`, the
 * `project_status_journal.source` value and a seeded "Mastermind" skill.
 * Everything that still spells the old name for stored data lives in this file
 * so the rest of the codebase can say Captain; the repository terminology test
 * (src/shared/captain-terminology.test.ts) allowlists it for that reason.
 */

/** `tasks.role` of a coordinator row before #71. */
export const LEGACY_COORDINATOR_ROLE = 'mastermind'
/** Title and description the coordinator row was seeded with before #71. */
const LEGACY_COORDINATOR_TITLE = 'Mastermind'
const LEGACY_COORDINATOR_DESCRIPTION = 'The Mastermind conversation. Not a task: never listed, never scheduled.'
/** The same, Captain-era. Kept in step with `ensureProjectCaptain` in seed.ts. */
export const COORDINATOR_TITLE = 'Captain'
export const COORDINATOR_DESCRIPTION = 'The Captain conversation. Not a task: never listed, never scheduled.'

/** `projects` column before and after #71. */
const LEGACY_AGENT_COLUMN = 'mastermind_agent_id'
const AGENT_COLUMN = 'captain_agent_id'

/** App `settings` keys renamed by #71 (old → new). */
export const LEGACY_SETTING_KEYS: Readonly<Record<string, string>> = {
  mastermind_prewarm: 'captain_prewarm'
}

/** Keys inside a project's `settings` JSON renamed by #71 (old → new). */
export const LEGACY_PROJECT_SETTING_KEYS: Readonly<Record<string, string>> = {
  mastermind_wakeups: 'captain_wakeups'
}

/** `project_status_journal.source` for a written update, before and after #71. */
const LEGACY_JOURNAL_SOURCE = 'mastermind'
const JOURNAL_SOURCE = 'captain'

/** Name of the skill 20x used to seed for the coordinator before it had a built-in prompt. */
export const LEGACY_COORDINATOR_SKILL_NAME = 'Mastermind'

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name))
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
}

/**
 * Migration v17: Mastermind → Captain (#71).
 *
 * Renames every persisted Mastermind identifier in place, so an upgrade keeps
 * the same coordinator row (id, session_id, transcript, project) and the same
 * per-project agent choice, warm-up preference and wake-up settings:
 *
 * - `tasks.role` 'mastermind' → 'captain'; the seeded title/description are
 *   rewritten only while they are still the seeded text. No row is inserted,
 *   so the startup seed finds the renamed row and never adds a second one.
 * - `projects.mastermind_agent_id` → `captain_agent_id` (RENAME COLUMN keeps
 *   the values and the foreign key).
 * - app settings `mastermind_prewarm` → `captain_prewarm`, and
 *   `projects.settings.mastermind_wakeups` → `captain_wakeups`. A value already
 *   stored under the new key wins; the old key is removed either way.
 * - `project_status_journal.source` 'mastermind' → 'captain', and the table is
 *   rebuilt (by named columns) when its column default is still 'mastermind',
 *   because SQLite cannot alter a default in place.
 *
 * Idempotent: every step matches only old values, so re-runs on later schema
 * bumps are no-ops. Runs after migrateToProjects (the projects table exists).
 */
export function migrateCoordinatorToCaptain(db: Database.Database): void {
  db.transaction(() => {
    if (columnsOf(db, 'tasks').has('role')) {
      db.prepare(`
        UPDATE tasks SET title = ? WHERE role = ? AND title = ?
      `).run(COORDINATOR_TITLE, LEGACY_COORDINATOR_ROLE, LEGACY_COORDINATOR_TITLE)
      db.prepare(`
        UPDATE tasks SET description = ? WHERE role = ? AND description = ?
      `).run(COORDINATOR_DESCRIPTION, LEGACY_COORDINATOR_ROLE, LEGACY_COORDINATOR_DESCRIPTION)
      db.prepare('UPDATE tasks SET role = ? WHERE role = ?').run('captain', LEGACY_COORDINATOR_ROLE)
    }

    if (tableExists(db, 'projects')) {
      const projectCols = columnsOf(db, 'projects')
      if (projectCols.has(LEGACY_AGENT_COLUMN) && !projectCols.has(AGENT_COLUMN)) {
        db.exec(`ALTER TABLE projects RENAME COLUMN ${LEGACY_AGENT_COLUMN} TO ${AGENT_COLUMN}`)
      }

      const rows = db.prepare('SELECT id, settings FROM projects').all() as { id: string; settings: string | null }[]
      const writeSettings = db.prepare('UPDATE projects SET settings = ? WHERE id = ?')
      for (const row of rows) {
        let settings: unknown
        try {
          settings = JSON.parse(row.settings || '{}')
        } catch {
          continue
        }
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue
        const record = settings as Record<string, unknown>
        let changed = false
        for (const [oldKey, newKey] of Object.entries(LEGACY_PROJECT_SETTING_KEYS)) {
          if (!(oldKey in record)) continue
          if (!(newKey in record)) record[newKey] = record[oldKey]
          delete record[oldKey]
          changed = true
        }
        if (changed) writeSettings.run(JSON.stringify(record), row.id)
      }
    }

    for (const [oldKey, newKey] of Object.entries(LEGACY_SETTING_KEYS)) {
      db.prepare('INSERT OR IGNORE INTO settings (key, value) SELECT ?, value FROM settings WHERE key = ?').run(newKey, oldKey)
      db.prepare('DELETE FROM settings WHERE key = ?').run(oldKey)
    }

    if (tableExists(db, 'project_status_journal')) {
      db.prepare('UPDATE project_status_journal SET source = ? WHERE source = ?').run(JOURNAL_SOURCE, LEGACY_JOURNAL_SOURCE)
      const source = (db.pragma('table_info(project_status_journal)') as { name: string; dflt_value: string | null }[])
        .find((c) => c.name === 'source')
      if (source?.dflt_value === `'${LEGACY_JOURNAL_SOURCE}'`) rebuildProjectStatusJournal(db)
    }
  })()
}

/**
 * Recreates project_status_journal with the Captain-era `source` default. The
 * definition matches `createTables()` in schema.ts (the schema equivalence and
 * captain migration tests compare the two). Columns are copied by name.
 */
function rebuildProjectStatusJournal(db: Database.Database): void {
  const columns = ['id', 'project_id', 'summary', 'completed', 'blockers', 'decisions', 'next_steps', 'source', 'correlation_id', 'created_at']
  const existing = columnsOf(db, 'project_status_journal')
  const copied = columns.filter((c) => existing.has(c)).join(', ')
  db.exec(`
    CREATE TABLE project_status_journal_new (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      completed TEXT NOT NULL DEFAULT '[]',
      blockers TEXT NOT NULL DEFAULT '[]',
      decisions TEXT NOT NULL DEFAULT '[]',
      next_steps TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT '${JOURNAL_SOURCE}',
      correlation_id TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO project_status_journal_new (${copied}) SELECT ${copied} FROM project_status_journal;
    DROP TABLE project_status_journal;
    ALTER TABLE project_status_journal_new RENAME TO project_status_journal;
    CREATE INDEX IF NOT EXISTS idx_project_status_journal_project_created
      ON project_status_journal(project_id, created_at DESC, id DESC);
  `)
}

/**
 * The text 20x used to seed as the "Mastermind" skill. The persona now lives in
 * code (src/main/prompts/captain.ts); this copy exists only so startup can
 * tell an untouched seeded skill from one the user edited. Never change it.
 */
export const LEGACY_COORDINATOR_SKILL_CONTENT = `# Mastermind Skill

You are helping the user manage their tasks. When analyzing tasks or making recommendations:

## 1. Understanding Historical Patterns

When a new task is created or user asks for recommendations:
- Use \`find_similar_tasks\` to find tasks with similar titles/descriptions
- Look at how those tasks were labeled, which agent handled them, and which skills were used
- Identify patterns (e.g., "tasks with 'bug' in title are usually labeled 'bug', 'high' priority")

## 2. Making Recommendations

Based on historical patterns, suggest:
- **Labels**: Common labels from similar tasks (e.g., "frontend", "backend", "bug", "feature")
- **Skills**: Skills that were effective for similar tasks
- **Agent**: Agent that successfully handled similar tasks
- **Priority**: Priority level based on task urgency and type

Format your recommendations clearly:
\`\`\`
I found 5 similar tasks about login bugs. Based on those:
- Labels: "bug", "frontend", "authentication"
- Agent: Frontend Agent (handled 4/5 similar tasks)
- Priority: High (login issues are critical)
- Skills: Authentication Debugging, Frontend Troubleshooting

Should I apply these recommendations?
\`\`\`

## 3. Applying Recommendations

If user approves (or if you're very confident), use \`update_task\` to apply:
\`\`\`json
{
  "task_id": "task-123",
  "labels": ["bug", "frontend", "authentication"],
  "agent_id": "agent-frontend-001",
  "skill_ids": ["skill-auth-debug", "skill-frontend"],
  "priority": "high"
}
\`\`\`

## 4. Answering Questions

Handle queries like:
- "What tasks are pending?" → Use \`list_tasks\` with status="not_started"
- "Show high priority bugs" → Use \`list_tasks\` with priority="high" and labels=["bug"]
- "How many tasks does Frontend Agent have?" → Use \`list_tasks\` with agent_id filter

## 5. Statistics and Insights

Use \`get_task_statistics\` to provide insights:
- Label usage trends
- Agent workload distribution
- Completion rates
- Priority distribution

## Example Workflow

User: "I just created a task: Fix payment gateway timeout"

You:
1. Call \`find_similar_tasks\` with title_keywords="payment gateway"
2. Analyze results: Found 3 similar payment tasks
3. Pattern: All labeled "bug", "backend", "payment", assigned to Backend Agent
4. Recommend same pattern
5. Ask user or apply if confident

Remember: Be helpful, concise, and proactive. Learn from history, but adapt to context.`

/**
 * Retires the seeded "Mastermind" skill now that the coordinator (the Captain) has a built-in
 * system prompt. Nothing is seeded any more. A copy whose content is still the
 * seeded text is soft-deleted and detached from every agent; a copy the user
 * edited is left alone, attached as before, as an ordinary user skill.
 * Idempotent: once the untouched copy is gone there is nothing left to match.
 */
export function seedOrchestratorSkill(db: Database.Database): void {
  const stale = db.prepare('SELECT id FROM skills WHERE name = ? AND content = ? AND is_deleted = 0')
    .all(LEGACY_COORDINATOR_SKILL_NAME, LEGACY_COORDINATOR_SKILL_CONTENT) as { id: string }[]
  if (stale.length === 0) return

  const staleIds = new Set(stale.map((row) => row.id))
  const now = new Date().toISOString()
  const agents = db.prepare('SELECT id, config FROM agents').all() as { id: string; config: string }[]
  const updateAgent = db.prepare('UPDATE agents SET config = ?, updated_at = ? WHERE id = ?')
  const deleteSkill = db.prepare('UPDATE skills SET is_deleted = 1, updated_at = ? WHERE id = ?')

  db.transaction(() => {
    for (const agent of agents) {
      let config: Record<string, unknown>
      try {
        config = JSON.parse(agent.config) as Record<string, unknown>
      } catch {
        continue
      }
      const skillIds = config.skill_ids
      if (!Array.isArray(skillIds) || !skillIds.some((id) => staleIds.has(id))) continue
      config.skill_ids = skillIds.filter((id) => !staleIds.has(id))
      updateAgent.run(JSON.stringify(config), now, agent.id)
    }
    for (const id of staleIds) deleteSkill.run(now, id)
  })()
}
