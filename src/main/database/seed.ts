import type Database from 'better-sqlite3'
import { join } from 'path'
import { createId } from '@paralleldrive/cuid2'
import { FULL_ACCESS_SCOPE, listToolsForScope } from '../mcp-servers/task-management-core'
import { TaskStatus } from '../../shared/constants'
import { TASK_ROLE_MASTERMIND } from '../../shared/task-roles'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'

/** First-run and every-startup rows the app relies on existing. */

export function seedDefaultAgent(db: Database.Database): void {
  const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number }
  if (agentCount.count > 0) return
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO agents (id, name, server_url, config, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(createId(), 'Default Agent', 'http://localhost:4096', '{}', now, now)
}

/**
 * The Mastermind's own row. It is a task row so its session_id and transcript
 * persist and resume like any task's; `role` keeps it out of every task list.
 * Idempotent: one row per install, found by role rather than by a fixed id.
 */
export function seedMastermindTask(db: Database.Database): void {
  const existing = db.prepare('SELECT id FROM tasks WHERE role = ? LIMIT 1').get(TASK_ROLE_MASTERMIND)
  if (existing) return
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, title, description, type, priority, status, assignee, labels, source, role, project_id, created_at, updated_at)
    VALUES (?, ?, ?, 'general', 'medium', ?, '', '[]', 'local', ?, ?, ?, ?)
  `).run(createId(), 'Mastermind', 'The Mastermind conversation. Not a task: never listed, never scheduled.', TaskStatus.NotStarted, TASK_ROLE_MASTERMIND, DEFAULT_PROJECT_ID, now, now)
}

/** Append `id` to an array in the default agent's config unless already present. */
function addToDefaultAgent(db: Database.Database, key: 'skill_ids' | 'mcp_servers', id: string, now: string): void {
  const defaultAgent = db.prepare('SELECT id, config FROM agents WHERE is_default = 1')
    .get() as { id: string; config: string } | undefined
  if (!defaultAgent) return

  let config: Record<string, unknown>
  try {
    config = JSON.parse(defaultAgent.config) as Record<string, unknown>
  } catch {
    config = {}
  }

  // mcp_servers entries may be plain ids or AgentMcpServerEntry objects.
  const entries = (config[key] as Array<string | { serverId: string }>) || []
  if (entries.some((entry) => typeof entry === 'string' ? entry === id : entry.serverId === id)) return
  entries.push(id)
  config[key] = entries
  db.prepare('UPDATE agents SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, defaultAgent.id)
}

/**
 * The text 20x used to seed as the "Mastermind" skill. The persona now lives in
 * code (src/main/prompts/mastermind.ts); this copy exists only so startup can
 * tell an untouched seeded skill from one the user edited. Never change it.
 */
export const LEGACY_MASTERMIND_SKILL_CONTENT = `# Mastermind Skill

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
 * Retires the seeded "Mastermind" skill now that the Mastermind has a built-in
 * system prompt. Nothing is seeded any more. A copy whose content is still the
 * seeded text is soft-deleted and detached from every agent; a copy the user
 * edited is left alone, attached as before, as an ordinary user skill.
 * Idempotent: once the untouched copy is gone there is nothing left to match.
 */
export function seedOrchestratorSkill(db: Database.Database): void {
  const stale = db.prepare('SELECT id FROM skills WHERE name = ? AND content = ? AND is_deleted = 0')
    .all('Mastermind', LEGACY_MASTERMIND_SKILL_CONTENT) as { id: string }[]
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

/** The full-access tool set the server actually serves, in the row's {name, description} shape. */
export function taskManagementToolRecords(): { name: string; description: string }[] {
  return listToolsForScope(FULL_ACCESS_SCOPE).map((tool) => ({ name: tool.name, description: tool.description ?? '' }))
}

/** Create or refresh the built-in task-management MCP server row (path, command
 * and tools change between releases) and attach it to the default agent. */
export function seedTaskManagementMcpServer(db: Database.Database): void {
  const now = new Date().toISOString()

  // __dirname = out/main/. When packaged the script is unpacked via asarUnpack,
  // so point at app.asar.unpacked for the real filesystem path.
  let mcpServerPath = join(__dirname, 'mcp-servers', 'task-management-mcp.js')
  if (mcpServerPath.includes('app.asar')) {
    mcpServerPath = mcpServerPath.replace('app.asar', 'app.asar.unpacked')
  }

  // Direct stdio use needs standalone Node on macOS and Windows. Agent
  // sessions use the in-process HTTP endpoint instead.
  const useSystemNode = process.platform === 'win32' || process.platform === 'darwin'
  const mcpCommand = useSystemNode ? 'node' : process.execPath
  const mcpEnv = useSystemNode ? {} : { ELECTRON_RUN_AS_NODE: '1' }

  const existingServer = db.prepare('SELECT id FROM mcp_servers WHERE name = ?')
    .get('task-management') as { id: string } | undefined
  const tools = JSON.stringify(taskManagementToolRecords())

  const mcpServerId = existingServer?.id ?? createId()
  if (!existingServer) {
    db.prepare(`
      INSERT INTO mcp_servers (id, name, type, command, args, environment, tools, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mcpServerId, 'task-management', 'local', mcpCommand,
      JSON.stringify([mcpServerPath]), JSON.stringify(mcpEnv), tools, now, now
    )
  } else {
    db.prepare(`
      UPDATE mcp_servers SET command = ?, args = ?, environment = ?, tools = ?, updated_at = ? WHERE id = ?
    `).run(
      mcpCommand, JSON.stringify([mcpServerPath]), JSON.stringify(mcpEnv), tools, now, mcpServerId
    )
  }

  addToDefaultAgent(db, 'mcp_servers', mcpServerId, now)
}
