import type { DatabaseManager, OutputFieldRecord, TaskRecord } from '../database'
import { TaskStatus } from '../../shared/constants'
import { buildSystemMessage, computeDeliveryId, SystemMessageOrigin } from '../../shared/system-authority'

export const ARTIFACT_WORKSPACE_INSTRUCTIONS = `

[Workspace Deliverables]
Repository files are code and appear in the task's Changes view; do not treat ordinary source files as artifacts.
For every standalone user-facing deliverable, first call \`create_artifact\` on the task-management MCP server (its exact callable name is listed under the MCP section of your workspace docs, AGENTS.md / CLAUDE.md). Then use \`write_artifact_file\`, \`read_artifact_file\`, and \`edit_artifact_file\` with the returned artifact_id. Multiple supporting files belong to that one artifact; mark its preview entry file with \`preview: true\`. Do not create artifact files with generic filesystem Write/Edit tools. Screenshots and pull requests are detected automatically.`

export const HEARTBEAT_MONITORING_INSTRUCTIONS = `\n\n## Heartbeat Monitoring (Optional)

If this task involves something that should be monitored after your work is done (e.g., a PR awaiting review, a deployment to verify, an issue to track), create a \`heartbeat.md\` file in the working directory.

Example heartbeat.md:
\`\`\`markdown
# Heartbeat Checks
- [ ] Check if PR https://github.com/org/repo/pull/123 has new review comments or requested changes
- [ ] Verify CI pipeline passed on the latest commit
- [ ] Check if linked issue #456 has new updates
\`\`\`

Only create this file when there's genuinely useful monitoring to do. Do not create it for tasks that are fully self-contained.`

/** Initial prompt for a regular (non-triage) task session: the task itself,
 *  parent/sibling/subtask context, orchestration hints and output fields. */
export function buildTaskWorkPrompt(db: DatabaseManager, taskId: string, task: TaskRecord | undefined): string {
  if (!task) return `Work on task: ${taskId}`
  let promptText = `Work on task: "${task.title}"\n\n${task.description || ''}${ARTIFACT_WORKSPACE_INSTRUCTIONS}`

  if (task.parent_task_id) {
    const parentTask = db.getTask(task.parent_task_id)
    if (parentTask) {
      promptText += `\n\n## Parent Task Context\nThis is a subtask of: "${parentTask.title}" (id: ${parentTask.id})\nParent description: ${parentTask.description || '(none)'}\nParent status: ${parentTask.status}`
      if (parentTask.output_fields && parentTask.output_fields.length > 0) {
        promptText += '\nParent output fields:'
        for (const field of parentTask.output_fields) {
          const val = (field as unknown as { value?: string }).value ?? '(not set)'
          promptText += `\n  - ${field.name}: ${val}`
        }
      }

      const otherSubtasks = db.getSubtasks(task.parent_task_id).filter(s => s.id !== task.id)
      if (otherSubtasks.length > 0) {
        promptText += '\n\n## Sibling Subtasks'
        for (const sibling of otherSubtasks) {
          const resolution = sibling.resolution ? ` | Resolution: ${sibling.resolution}` : ''
          const outputSummary = sibling.output_fields && sibling.output_fields.length > 0
            ? ` | Outputs: ${sibling.output_fields.length} field(s)`
            : ''
          promptText += `\n- "${sibling.title}" (id: ${sibling.id}, status: ${sibling.status}${resolution}${outputSummary})`
        }
        promptText += '\n\nCoordinate with sibling subtasks — avoid duplicating work and ensure compatibility.'
        promptText += '\nUse `get_task` with a sibling ID to read its full output fields and resolution.'
      }
    }
    promptText += '\n\nYou can call `list_subtasks` or `get_task` via the `task-management` MCP server at any time for live data on parent and sibling tasks.'
    promptText += '\nIMPORTANT: For all task operations (update_task, get_task, list_subtasks), use ONLY the `task-management` MCP server tools. Do NOT use integration tools from other MCP servers for these updates — those are for external system sync only.'
  }

  const subtasks = db.getSubtasks(task.id)
  if (subtasks.length > 0) {
    promptText += '\n\n## Subtasks'
    for (const sub of subtasks) {
      const subResolution = sub.resolution ? ` | Resolution: ${sub.resolution}` : ''
      promptText += `\n- "${sub.title}" (id: ${sub.id}, status: ${sub.status}, agent: ${sub.agent_id || 'unassigned'}${subResolution})`
    }
    promptText += '\n\nThis task has subtasks. Each subtask has its own agent. Focus on coordination and any work not covered by subtasks.'
    promptText += '\nUse `list_subtasks` or `get_task` via MCP tools to check live subtask status and outputs.'
  }

  promptText += '\n\nYou can use the `task-management` MCP server to orchestrate execution instead of doing everything yourself.'
  promptText += '\n- Use `create_subtask` to break work down.'
  promptText += '\n- Use `start_task` to triage+start an unassigned task, start an assigned task, or start a specific subtask by ID.'
  promptText += '\n- Use `wait_for_subtasks` to block until subtasks reach `ready_for_review` or `completed` before continuing coordination.'
  promptText += '\n- Repetitive work: when the task needs the same tool called once per item (e.g. creating one subtask per issue), make that call once per item until the list is done — that is the normal pattern and no per-item approval is needed. If a batching helper is missing or returns an error, fall back to repeated individual calls instead of stopping, and do not pause mid-loop to ask whether to continue.'

  if (Array.isArray(task.output_fields) && task.output_fields.length > 0) {
    promptText += buildOutputFieldInstructions(task.output_fields)
  }
  return promptText
}

function buildOutputFieldInstructions(fields: OutputFieldRecord[]): string {
  const lines: string[] = [
    '\n\n---',
    'When you complete this task, provide the following outputs.',
    'Include your answers in a JSON code block at the end of your final message.',
    'Use the exact field names as keys:\n'
  ]

  const exampleObj: Record<string, string> = {}
  for (const field of fields) {
    const attrs: string[] = [field.type]
    if (field.required) attrs.push('required')
    if (field.multiple) attrs.push('multiple')
    if (field.options?.length) attrs.push(`options: ${field.options.join(', ')}`)

    lines.push(`- ${field.name} (${attrs.join(', ')})`)
    exampleObj[field.name] = field.type === 'file' ? '</absolute/path/to/file>' : `<${field.type} value>`
  }

  const hasFileFields = fields.some((f) => f.type === 'file')
  if (hasFileFields) {
    lines.push('\nFor file fields, return the absolute path to the file you created in the workspace.')
  }

  lines.push('\nExample output format (if you have ``` inside the output - escape with \\`\\`\\`):')
  lines.push('```json')
  lines.push(JSON.stringify(exampleObj, null, 2))
  lines.push('```')

  return lines.join('\n')
}

/** Sent when an agent goes idle with an unfinished todo list (TillDone). */
export function buildTillDoneNudge(todos: Array<{ content: string; status: string }>, incomplete: Array<{ content: string; status: string }>): string {
  const lines = [
    `TillDone: you went idle but your to-do list is NOT finished (${todos.length - incomplete.length}/${todos.length} completed).`,
    '',
    'Remaining items:'
  ]
  for (const t of incomplete) lines.push(`- [${t.status}] ${t.content}`)
  lines.push('')
  lines.push('Continue working on the remaining items above. Update todowrite as you progress and only stop once every item is completed or explicitly removed.')
  return lines.join('\n')
}

/**
 * `projectRepos` are the repos of the task's project (#50): triage may only
 * pick from them, and update_task rejects any other.
 */
export function buildTriagePrompt(task: TaskRecord, projectRepos: string[] = []): string {
  const repoList = projectRepos.length > 0
    ? `Project Repos (the ONLY repos you may assign): ${projectRepos.join(', ')}`
    : 'Project Repos: none. This project has no repos, so do not set repos; the task runs in an empty workspace.'
  return `You are triaging a new task. Your job is to analyze this task and assign the best agent, skills, repos, priority, and labels. Do NOT work on the task itself.

Task ID: ${task.id}
Title: ${task.title}
Description: ${task.description || '(none)'}
Type: ${task.type || 'general'}
Current Priority: ${task.priority || 'medium'}
Current Labels: ${JSON.stringify(task.labels || [])}
Current Output Fields: ${JSON.stringify(task.output_fields || [])}
Parent Task: ${task.parent_task_id ? `This is a subtask of task ${task.parent_task_id}` : 'None (top-level task)'}
${repoList}

IMPORTANT: For ALL task operations below, use ONLY the \`task-management\` MCP server tools (e.g. \`mcp__task-management__update_task\`, \`mcp__task-management__create_subtask\`). Do NOT use integration/sync tools from other MCP servers for updating tasks — those are for external system sync only.

Follow these steps:

1. Call \`find_similar_tasks\` with individual keywords extracted from the title/description. Pass them as space-separated words in \`title_keywords\` (e.g. "login bug fix" not the full title). Do NOT set \`completed_only\` — search all tasks so you find patterns even if tasks are still in progress.
2. Call \`list_agents\` to see available agents and their capabilities.
3. Call \`list_skills\` to see available skills.
4. Call \`list_repos\` to see this project's repositories, with provider and default branch. Pick repos only from that list; any other repo is rejected.
5. Based on the similar tasks and available resources, determine:
 - The best agent_id to assign (REQUIRED — you must set this)
 - Relevant skill_ids (if any match the task)
 - Appropriate repos from the project's repos (if the task relates to specific repositories)
 - Priority (critical/high/medium/low) — adjust if the current priority seems wrong
 - Labels — suggest relevant labels based on similar tasks
 - output_fields — define the expected structured outputs for this task. Think about what concrete deliverables or data the agent should produce. Each output field needs an id (snake_case), name (human-readable), and type (text, number, url, file, boolean, textarea, list, date, email, country, currency). Mark fields as required if they are essential. Examples:
   - A coding task might have: { id: "pr_url", name: "Pull Request URL", type: "url", required: true }
   - A research task might have: { id: "summary", name: "Summary", type: "textarea", required: true }
   - A review task might have: { id: "approved", name: "Approved", type: "boolean", required: true }
6. If the task is complex and clearly involves multiple distinct steps that would benefit from separate agents or sequential human review, create subtasks using \`create_subtask\` from the \`task-management\` MCP server. Each subtask should:
 - Have a clear, specific title describing one step
 - Be assigned to the most appropriate agent_id (REQUIRED for each subtask)
 - Have relevant skill_ids assigned based on what skills match that subtask's work
 - Have repos set to the repositories relevant to that subtask (inherits from parent if not specified)
 - Include a description explaining the subtask's scope, expected output, and how it relates to other subtasks
 - Have output_fields defined to specify what structured data the subtask agent should produce
 - NOT overlap with other subtasks — each subtask should be a distinct, self-contained piece of work
 Only create subtasks when clearly needed — simple tasks should remain as single tasks.
 When creating subtasks, consider the order of execution and dependencies between them.
 Each subtask will run as a separate agent session with access to the parent task and sibling subtask outputs for coordination.
7. Call \`update_task\` ONCE with task_id "${task.id}" and all the values you determined. You MUST include agent_id and output_fields.
 If you created subtasks, the parent task's agent will coordinate the overall work.

Important:
- You MUST assign an agent_id to the parent task. If only one agent exists, assign that one.
- You MUST also assign an agent_id to each subtask you create.
- Do NOT change the task status — it will be handled automatically.
- Do NOT attempt to work on or solve the task. Only triage it.
- If no similar tasks exist, use your best judgment based on the title, description, and type.
- Be efficient — make your tool calls and finish quickly.
- If the task already has output_fields defined (from an external source), preserve them and only add additional fields if needed. Do not remove existing output fields.
- When creating subtasks, the parent task's agent will coordinate — subtask agents handle individual pieces.
- Subtask agents can see the parent task, all sibling subtasks' status/resolution/outputs, and sibling transcripts for coordination.
- NEVER use external integration MCP tools for local task updates — always use task-management tools.`
}

/** Wake-up prompt for a coordinator once no subtask is still being worked on. */
export function buildSubtaskWakeMessage(
  parentTaskId: string,
  subtasks: TaskRecord[],
  routing?: { subtaskId: string; issue: string }
): string {
  const summary = subtasks
    .map((s) => `- "${s.title}" (id: ${s.id}) → ${s.status}`)
    .join('\n')
  const allTerminal = subtasks.every(
    (s) => s.status === TaskStatus.ReadyForReview || s.status === TaskStatus.Completed
  )
  const instructions = routing
    ? `Use \`get_task\` / \`list_subtasks\` via the task-management MCP server to review the current agenda, ` +
      `then decide which sibling subtask to start next, fix its successor links or agent assignment, ` +
      `or complete the task if no more work is needed.`
    : allTerminal
      ? `Use \`get_task\` / \`list_subtasks\` via the task-management MCP server to review their outputs, ` +
        `then continue coordination: consolidate results, fill in the parent task's output fields, ` +
        `and complete the task — or create follow-up subtasks if more work is needed.`
      : `Use \`get_task\` / \`list_subtasks\` via the task-management MCP server to review the ready subtask's outputs, ` +
        `then continue coordination: start the next not_started subtask, create follow-up subtasks if more work ` +
        `is needed, or consolidate results and complete the task.`
  const header = routing
    ? `Subtask ${routing.subtaskId} completed, but its selected next subtasks could not all be started: ${routing.issue}`
    : allTerminal
      ? 'All subtasks of this task have reached a terminal state.'
      : 'No subtask of this task is in agent_working anymore — the last one reached ready_for_review.'
  // Subtask titles are agent-authored text. Fencing them and stating the authority
  // boundary keeps a wake-up from reading as a human go-ahead for privileged work.
  return buildSystemMessage(
    {
      origin: SystemMessageOrigin.Coordinator,
      taskId: parentTaskId,
      deliveryId: computeDeliveryId(parentTaskId, `${header}\n${summary}`),
      generatedAt: new Date().toISOString()
    },
    header,
    summary,
    instructions
  )
}
