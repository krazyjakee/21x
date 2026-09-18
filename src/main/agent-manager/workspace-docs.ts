import { join } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import type { DatabaseManager, McpServerRecord, SecretRecord, SkillRecord } from '../database'
import type { CodingAgentAdapter, McpServerConfig } from '../adapters/coding-agent-adapter'
import { CodingAgentType } from './adapter-factory'
import { readServerToolLimits } from '../mcp-tool-limits'
import { isSkillVisibleToProject } from '../../shared/skill-scope'

/**
 * One MCP server as the session documentation describes it.
 * `injected` is the config the session really received, when it is known.
 */
interface DocumentedMcpServer {
  server: McpServerRecord
  enabledTools?: string[]
  injected?: McpServerConfig
}

/** Claude Code agents read CLAUDE.md; all other agents read AGENTS.md. */
export function getMemoryFileName(db: DatabaseManager, agentId: string): string {
  return db.getAgent(agentId)?.config?.coding_agent === CodingAgentType.CLAUDE_CODE ? 'CLAUDE.md' : 'AGENTS.md'
}

/**
 * Escapes a value for a YAML double-quoted scalar. Unquoted values break the
 * parser when skill names/descriptions contain colons or brackets (e.g.
 * "latest: true" or "[Team] foo").
 */
function sanitizeYamlValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim()
}

/**
 * Writes the selected SKILL.md files (task + agent selections, deduplicated,
 * never all skills) and then AGENTS.md / CLAUDE.md. Async I/O lets IPC and
 * rendering run between writes.
 *
 * Scope (#74): only skills the task's project may see are written — global
 * ones and the project's own. A selection that names another project's skill
 * (an agent-level default reused across projects, or a task moved between
 * projects) is dropped here and logged, never copied into the workspace.
 */
export async function writeSkillFiles(
  db: DatabaseManager,
  taskId: string,
  agentId: string,
  workspaceDir: string,
  injectedMcpServers?: Record<string, McpServerConfig>
): Promise<void> {
  try {
    const task = db.getTask(taskId)
    const agentConfig = db.getAgent(agentId)?.config
    const skillIds = [...new Set([...(task?.skill_ids ?? []), ...(agentConfig?.skill_ids ?? [])])]
    const selected = skillIds.length > 0 ? db.getSkillsByIds(skillIds) : []
    const skills = selected.filter((skill) => isSkillVisibleToProject(skill, task?.project_id))
    const hidden = selected.filter((skill) => !skills.includes(skill))
    if (hidden.length > 0) {
      console.warn(`[AgentManager] Not writing ${hidden.length} skill(s) another project owns to task ${taskId}: ${hidden.map((s) => s.name).join(', ')}`)
    }

    if (skills.length > 0) {
      const skillsDir = agentConfig?.coding_agent === CodingAgentType.CLAUDE_CODE
        ? join(workspaceDir, '.claude', 'skills')
        : join(workspaceDir, '.agents', 'skills')
      for (const skill of skills) {
        const dir = join(skillsDir, skill.name)
        await mkdir(dir, { recursive: true })
        const safeName = sanitizeYamlValue(skill.name)
        const safeDesc = sanitizeYamlValue(skill.description || skill.name)
        // preferred_model round-trips through syncSkillsFromDirectory.
        const modelLine = skill.preferred_model ? `preferred_model: "${sanitizeYamlValue(skill.preferred_model)}"\n` : ''
        const content = `---\nname: "${safeName}"\ndescription: "${safeDesc}"\n${modelLine}---\n\n${skill.content}`
        await writeFile(join(dir, 'SKILL.md'), content, 'utf-8')
      }
      console.log(`[AgentManager] Wrote ${skills.length} SKILL.md file(s) to ${skillsDir}`)
    }

    await writeAgentsDocumentation(db, workspaceDir, skills, task?.repos || [], agentId, injectedMcpServers)
  } catch (error) {
    console.error('[AgentManager] Error writing skill files:', error)
  }
}

/** Writes AGENTS.md and CLAUDE.md to the workspace root. */
export async function writeAgentsDocumentation(
  db: DatabaseManager,
  workspaceDir: string,
  skills: SkillRecord[],
  repos: string[],
  agentId?: string,
  injectedMcpServers?: Record<string, McpServerConfig>
): Promise<void> {
  try {
    const sortedSkills = [...skills].sort((a, b) => b.confidence - a.confidence)
    await writeFile(join(workspaceDir, 'AGENTS.md'), generateAgentsMd(db, sortedSkills, repos, workspaceDir, agentId, injectedMcpServers), 'utf-8')
    await writeFile(join(workspaceDir, 'CLAUDE.md'), generateClaudeMd(db, sortedSkills, repos, workspaceDir, agentId, injectedMcpServers), 'utf-8')
    console.log('[AgentManager] Generated AGENTS.md and CLAUDE.md in workspace root')
  } catch (error) {
    console.error('[AgentManager] Error writing agent documentation:', error)
  }
}

/**
 * Names of MCP servers that a session was given but that are not attached to
 * the backend. Only the OpenCode adapter can report this: the Claude Code
 * adapter passes the server map on every CLI spawn, so it cannot drift.
 */
export function getAdapterMcpAttachFailures(adapter: CodingAgentAdapter, sessionId: string): string[] {
  const reporter = adapter as unknown as { getMcpAttachFailures?: (id: string) => string[] }
  if (typeof reporter.getMcpAttachFailures !== 'function') return []
  try {
    return reporter.getMcpAttachFailures(sessionId) ?? []
  } catch {
    return []
  }
}

/**
 * Resolves which MCP servers the session documentation must describe.
 *
 * The list has to come from the servers that are really injected into the
 * session (see buildMcpServers), not from the agent configuration alone. The
 * agent configuration is wrong in both directions: task-management is
 * force-added for every real task, so a session that has it is not listed, and
 * a configured server whose DB row is gone is listed but never injected. That
 * is how AGENTS.md came to advertise 35 task-management tools to sessions that
 * had none of them.
 *
 * When the caller gives no injected names, fall back to the agent
 * configuration, which keeps standalone documentation generation working.
 */
function resolveDocumentedMcpServers(
  db: DatabaseManager,
  agentId: string | undefined,
  injectedServers?: Record<string, McpServerConfig>
): DocumentedMcpServer[] {
  if (!agentId) return []
  const entries = db.getAgent(agentId)?.config?.mcp_servers || []

  // Same parser as buildMcpServers, so documentation and enforcement agree
  // on each server's limit.
  const limits = readServerToolLimits(entries)
  const configured = new Map<string, DocumentedMcpServer>()
  for (const serverId of limits.keys()) {
    const server = db.getMcpServer(serverId)
    if (!server) continue
    configured.set(server.name, { server, enabledTools: limits.get(serverId) })
  }

  if (!injectedServers) return [...configured.values()]

  const documented: DocumentedMcpServer[] = []
  for (const [name, injected] of Object.entries(injectedServers)) {
    const fromConfig = configured.get(name)
    if (fromConfig) {
      documented.push({ ...fromConfig, injected })
      continue
    }
    // Force-added server (task-management): present in the session but absent
    // from the agent configuration, so it must be looked up by name.
    const server = db.getMcpServers().find(s => s.name === name)
    if (server) documented.push({ server, injected })
  }
  return documented
}

/**
 * How the session reaches a server. Reads the config the session really
 * received, because the stored record can disagree with it: task-management's
 * record still describes a command, but sessions reach it over HTTP in this
 * process and no command runs at all.
 */
function describeMcpTransport(entry: DocumentedMcpServer): { type: string; detail: string } {
  const injected = entry.injected
  if (injected?.type === 'http' || injected?.type === 'sse') {
    return { type: 'Local (HTTP, in-process)', detail: `**Endpoint:** \`${withoutToken(injected.url ?? '')}\`` }
  }
  if (injected?.type === 'stdio') {
    return { type: 'Local (stdio)', detail: `**Command:** \`${injected.command} ${(injected.args || []).join(' ')}\`` }
  }
  return entry.server.type === 'local'
    ? { type: 'Local (stdio)', detail: `**Command:** \`${entry.server.command} ${entry.server.args.join(' ')}\`` }
    : { type: 'Remote (HTTP)', detail: `**URL:** \`${entry.server.url}\`` }
}

function visibleTools({ server, enabledTools }: DocumentedMcpServer): McpServerRecord['tools'] {
  return enabledTools ? server.tools.filter(t => enabledTools.includes(t.name)) : server.tools
}

/** Secret names and descriptions only — never the values. */
function agentSecrets(db: DatabaseManager, agentId?: string): SecretRecord[] {
  if (!agentId) return []
  const secretIds = db.getAgent(agentId)?.config?.secret_ids
  return secretIds && secretIds.length > 0 ? db.getSecretsByIds(secretIds) : []
}

function secretList(secrets: SecretRecord[]): string {
  let md = ''
  for (const secret of secrets) {
    md += `- **\`$${secret.env_var_name}\`** — ${secret.name}`
    if (secret.description) md += `: ${secret.description}`
    md += `\n`
  }
  return md
}

export function generateAgentsMd(
  db: DatabaseManager,
  skills: SkillRecord[],
  repos: string[],
  workspaceDir: string,
  agentId?: string,
  injectedMcpServers?: Record<string, McpServerConfig>
): string {
  let md = `# Agent Session Configuration\n\n`
  md += `**Generated:** ${new Date().toISOString()}\n`
  md += `---\n\n`

  const documentedServers = resolveDocumentedMcpServers(db, agentId, injectedMcpServers)
  if (documentedServers.length > 0) {
    md += `## Available MCP Servers & Tools\n\n`
    md += `This session has access to the following Model Context Protocol (MCP) servers and their tools:\n\n`

    for (const entry of documentedServers) {
      const transport = describeMcpTransport(entry)
      md += `### ${entry.server.name}\n\n`
      md += `**Type:** ${transport.type}\n\n`
      md += `${transport.detail}\n\n`

      if (entry.server.tools && entry.server.tools.length > 0) {
        const toolsToShow = visibleTools(entry)
        md += `**Available Tools (${toolsToShow.length}):**\n\n`
        for (const tool of toolsToShow) {
          md += `- **\`${tool.name}\`** - ${tool.description}\n`
        }
        md += `\n`
      }

      md += `---\n\n`
    }
  }

  const secrets = agentSecrets(db, agentId)
  if (secrets.length > 0) {
    md += `## Available Secrets\n\n`
    md += `The following secrets are automatically injected as environment variables into every shell/bash command you run.\n`
    md += `They are managed by the user and securely provided at runtime — you MUST NOT hardcode, echo, log, or ask the user for these values.\n\n`
    md += `### How to use\n\n`
    md += `Reference them with \`$VAR_NAME\` in any bash command. Examples:\n\n`
    md += `\`\`\`bash\n`
    md += `# Connect to a database\n`
    md += `psql "$DATABASE_URL"\n\n`
    md += `# Use an API key in a curl request\n`
    md += `curl -H "Authorization: Bearer $API_KEY" https://api.example.com\n\n`
    md += `# Pass to a script\n`
    md += `python deploy.py --token "$DEPLOY_TOKEN"\n`
    md += `\`\`\`\n\n`
    md += `**Important:** Secrets are ONLY available inside bash/shell commands. They are not in your process environment or accessible via tool arguments.\n\n`
    md += `### Available secrets\n\n`
    md += secretList(secrets)
    md += `\n---\n\n`
  }

  if (repos.length > 0) {
    md += `## Repositories\n\n`
    md += `This task has ${repos.length} repository/repositories checked out in the workspace:\n\n`
    for (const repo of repos) {
      const repoName = repo.split('/').pop() || repo
      md += `- **${repo}** → \`${repoName}/\`\n`
    }
    md += `\n`
    md += `**Workspace Directory:** \`${workspaceDir}\`\n\n`
    md += `**Important:** All repository code is in subdirectories. For example, to access files in ${repos[0].split('/').pop()}, use \`${repos[0].split('/').pop()}/src/...\` as paths.\n\n`
    md += `---\n\n`
  }

  md += `## Available Skills\n\n`

  if (skills.length === 0) {
    md += `No skills configured for this session.\n\n`
  } else {
    md += `This session has access to ${skills.length} skill(s), sorted by confidence level:\n\n`

    for (const skill of skills) {
      const confidencePercent = (skill.confidence * 100).toFixed(0)
      const lastUsed = skill.last_used ? new Date(skill.last_used).toISOString().split('T')[0] : 'Never'
      const tags = skill.tags && skill.tags.length > 0 ? skill.tags.join(', ') : 'none'

      md += `### [${skill.name}](.agents/skills/${skill.name}/SKILL.md)\n\n`
      md += `**Confidence:** ${confidencePercent}% | **Uses:** ${skill.uses} | **Last Used:** ${lastUsed}\n\n`
      md += `**Tags:** ${tags}\n\n`
      md += `${skill.description}\n\n`
      md += `---\n\n`
    }
  }

  return md
}

export function generateClaudeMd(
  db: DatabaseManager,
  skills: SkillRecord[],
  repos: string[],
  workspaceDir: string,
  agentId?: string,
  injectedMcpServers?: Record<string, McpServerConfig>
): string {
  let md = `# Claude Code Configuration\n\n`
  md += `**Session Started:** ${new Date().toISOString()}\n`
  md += `---\n\n`

  const documentedServers = resolveDocumentedMcpServers(db, agentId, injectedMcpServers)
  if (documentedServers.length > 0) {
    md += `## MCP Tools Available\n\n`
    md += `You have access to the following tools through Model Context Protocol (MCP) servers:\n\n`

    for (const entry of documentedServers) {
      if (entry.server.tools && entry.server.tools.length > 0) {
        const toolsToShow = visibleTools(entry)
        md += `### ${entry.server.name} (${toolsToShow.length} tools)\n\n`
        for (const tool of toolsToShow) {
          md += `#### \`${tool.name}\`\n\n`
          md += `${tool.description}\n\n`
        }
      }
    }

    md += `---\n\n`
  }

  const secrets = agentSecrets(db, agentId)
  if (secrets.length > 0) {
    md += `## Available Secrets\n\n`
    md += `The following secrets are automatically injected as environment variables into every bash command you execute.\n`
    md += `They are securely managed — you MUST NOT hardcode, echo, print, log, or ask the user for these values.\n\n`
    md += `### Usage\n\n`
    md += `Use \`$VAR_NAME\` directly in any bash command:\n\n`
    md += `\`\`\`bash\n`
    md += `# They are already set — just reference them\n`
    md += `psql "$DATABASE_URL"\n`
    md += `curl -H "Authorization: Bearer $API_KEY" https://api.example.com\n`
    md += `python deploy.py --token "$DEPLOY_TOKEN"\n`
    md += `\`\`\`\n\n`
    md += `**Important:** Secrets are ONLY available inside bash/shell commands (the Bash tool). They are not accessible in your own process environment, tool arguments, or file contents.\n\n`
    md += `### Available secrets\n\n`
    md += secretList(secrets)
    md += `\n---\n\n`
  }

  if (repos.length > 0) {
    md += `## Workspace Structure\n\n`
    md += `Your working directory is \`${workspaceDir}\`\n\n`
    md += `This task has ${repos.length} repository/repositories checked out:\n\n`
    for (const repo of repos) {
      const repoName = repo.split('/').pop() || repo
      md += `- **${repo}** is checked out in \`./${repoName}/\`\n`
    }
    md += `\n`
    md += `**IMPORTANT:** All repository code is in subdirectories, not in the root workspace directory. When reading or editing files, use paths like \`${repos[0].split('/').pop()}/src/...\`, not just \`src/...\`\n\n`
    md += `---\n\n`
  }

  md += `## Skills Reference\n\n`

  if (skills.length === 0) {
    md += `No skills are available for this session.\n\n`
  } else {
    md += `You have access to ${skills.length} specialized skill(s). Each skill contains proven patterns and approaches from previous successful sessions.\n\n`
    md += `### Quick Reference\n\n`

    for (const skill of skills) {
      const confidencePercent = (skill.confidence * 100).toFixed(0)
      md += `- **[${skill.name}](.claude/skills/${skill.name}/SKILL.md)** (${confidencePercent}% confidence)\n`
      md += `  ${skill.description}\n\n`
    }

    md += `### Detailed Skills\n\n`

    for (const skill of skills) {
      const confidencePercent = (skill.confidence * 100).toFixed(0)
      const lastUsed = skill.last_used ? new Date(skill.last_used).toISOString().split('T')[0] : 'Never'

      md += `#### ${skill.name}\n\n`
      md += `**Path:** [.claude/skills/${skill.name}/SKILL.md](.claude/skills/${skill.name}/SKILL.md)\n\n`
      md += `**Confidence:** ${confidencePercent}%\n\n`
      md += `**Description:** ${skill.description}\n\n`
      md += `**Usage Stats:** ${skill.uses} uses | Last used: ${lastUsed}\n\n`

      if (skill.tags && skill.tags.length > 0) {
        md += `**Tags:** ${skill.tags.map((t: string) => `\`${t}\``).join(', ')}\n\n`
      }

      md += `---\n\n`
    }
  }

  md += `## Usage Notes\n\n`
  md += `- Skills are sorted by confidence level (highest first)\n`
  md += `- Confidence indicates how well the skill has performed in past sessions\n`
  md += `- Higher usage count suggests more battle-tested approaches\n`
  md += `- Check the SKILL.md files for detailed implementation guidance\n\n`

  return md
}

// Workspace docs are plain files an agent may copy or commit; the task API
// token stays in the session config only.
function withoutToken(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('token')
    return parsed.toString()
  } catch {
    return url
  }
}
