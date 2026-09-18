import type Database from 'better-sqlite3'
import { join } from 'path'
import { createId } from '@paralleldrive/cuid2'

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

const MASTERMIND_SKILL_CONTENT = `# Mastermind Skill

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

export function seedOrchestratorSkill(db: Database.Database): void {
  if (db.prepare('SELECT 1 FROM skills WHERE name = ? AND is_deleted = 0').get('Mastermind')) return

  const now = new Date().toISOString()
  const skillId = createId()
  db.prepare(`
    INSERT INTO skills (id, name, description, content, version, confidence, uses, last_used, tags, is_deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, 0, NULL, ?, 0, ?, ?)
  `).run(
    skillId,
    'Mastermind',
    'Helps agents analyze tasks, make recommendations based on historical patterns, and manage task metadata intelligently',
    MASTERMIND_SKILL_CONTENT,
    0.8, // Higher confidence since this is a system skill
    JSON.stringify(['mastermind', 'task-management', 'system']),
    now,
    now
  )
  addToDefaultAgent(db, 'skill_ids', skillId, now)
}

const TASK_MANAGEMENT_TOOLS = [
  { name: 'list_tasks', description: 'List all tasks with optional filters (status, priority, agent, labels)' },
  { name: 'create_task', description: 'Create a new task with title, description, type, priority, labels, assignee, agent_id, skill_ids, due date. Use cron field for recurring tasks (e.g. "0 9 * * 1-5")' },
  { name: 'get_task', description: 'Get detailed information about a specific task by ID' },
  { name: 'update_task', description: 'Update task metadata (labels, skills, agent assignment, priority, status)' },
  { name: 'create_artifact', description: 'Create a durable task-scoped artifact workpiece' },
  { name: 'list_artifacts', description: 'List explicitly registered artifacts and their files' },
  { name: 'read_artifact_file', description: 'Read a file owned by an artifact workpiece' },
  { name: 'write_artifact_file', description: 'Write a file owned by an artifact workpiece' },
  { name: 'edit_artifact_file', description: 'Edit a file owned by an artifact workpiece' },
  { name: 'list_agents', description: 'List all available agents with their configurations' },
  { name: 'list_skills', description: 'List all available skills with their descriptions' },
  { name: 'find_similar_tasks', description: 'Find historical tasks similar to given criteria for pattern analysis' },
  { name: 'get_task_statistics', description: 'Get aggregated statistics about tasks (label usage, agent workload, completion rate)' }
]

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

  const mcpServerId = existingServer?.id ?? createId()
  if (!existingServer) {
    db.prepare(`
      INSERT INTO mcp_servers (id, name, type, command, args, environment, tools, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mcpServerId, 'task-management', 'local', mcpCommand,
      JSON.stringify([mcpServerPath]), JSON.stringify(mcpEnv), JSON.stringify(TASK_MANAGEMENT_TOOLS), now, now
    )
  } else {
    db.prepare(`
      UPDATE mcp_servers SET command = ?, args = ?, environment = ?, tools = ?, updated_at = ? WHERE id = ?
    `).run(
      mcpCommand, JSON.stringify([mcpServerPath]), JSON.stringify(mcpEnv), JSON.stringify(TASK_MANAGEMENT_TOOLS), now, mcpServerId
    )
  }

  addToDefaultAgent(db, 'mcp_servers', mcpServerId, now)
}
