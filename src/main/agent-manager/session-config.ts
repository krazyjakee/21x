import type { AgentRecord, DatabaseManager, McpServerRecord, SecretRecord, TaskRecord } from '../database'
import type { McpServerConfig, SessionConfig } from '../adapters/coding-agent-adapter'
import type { OAuthManager } from '../oauth/oauth-manager'
import { TaskStatus } from '../../shared/constants'
import { isCoordinatorTask } from '../../shared/task-roles'
import { getTaskApiPort, getTaskApiToken, waitForTaskApiServer } from '../task-api-server'
import { buildTaskMcpUrl } from '../task-mcp-endpoint'
import { getSecretBrokerPort, writeSecretShellWrapper } from '../secret-broker'
import { opencodeDisallowedToolMap, readServerToolLimits, resolveAllowedToolNames } from '../mcp-tool-limits'
import { withMastermindSystemPrompt } from '../prompts/mastermind'
import { knownBackendModels, orderedSkillIds, resolveSkillModel } from './skill-model'

export interface McpServerOptions {
  ensureTaskManagement?: boolean
  taskScope?: { taskId: string; parentTaskId: string }
  artifactTaskId?: string
}

export function isTriageSessionTask(taskId: string, task?: TaskRecord | null): boolean {
  if (!task) return false
  // A coordinator row has no agent_id of its own; that is not a triage need.
  if (isCoordinatorTask(task)) return false
  if (taskId.startsWith('heartbeat-')) return false
  return task.status === TaskStatus.Triaging ||
    (Object.prototype.hasOwnProperty.call(task, 'agent_id') && !task.agent_id)
}

export function shouldEnableTillDone(taskId: string, task?: TaskRecord | null): boolean {
  if (isCoordinatorTask(task)) return false
  if (taskId.startsWith('heartbeat-')) return false
  if (isTriageSessionTask(taskId, task)) return false
  if (task?.status === TaskStatus.AgentLearning) return false
  return true
}

/** Real task sessions always get task-management so they can triage, orchestrate
 *  subtasks, and inspect live task state regardless of per-agent MCP config.
 *  The Mastermind is a task row too, so it gets the same; its artifact calls
 *  stay unpinned, because it is not a workpiece of its own. */
export function mcpOptionsForTask(taskId: string, task?: TaskRecord | null): McpServerOptions {
  return {
    ensureTaskManagement: !!task,
    taskScope: task?.parent_task_id ? { taskId, parentTaskId: task.parent_task_id } : undefined,
    artifactTaskId: task && !isCoordinatorTask(task) ? taskId : undefined
  }
}

/**
 * The task-management MCP server runs inside this process on the Task API
 * server and is reached over HTTP, so nothing is spawned. The scope is part of
 * the URL, which keeps the config identical across resumes.
 */
function buildTaskManagementMcpConfig(opts?: McpServerOptions): McpServerConfig | null {
  const apiPort = getTaskApiPort()
  if (!apiPort) {
    console.warn('[AgentManager] buildTaskManagementMcpConfig - task API port is null; task-management tools unavailable')
    return null
  }
  return {
    type: 'http',
    url: buildTaskMcpUrl(apiPort, getTaskApiToken(), {
      taskId: opts?.taskScope?.taskId,
      parentTaskId: opts?.taskScope?.parentTaskId,
      artifactTaskId: opts?.artifactTaskId
    })
  }
}

/**
 * The per-tool limit for one server, in the shape an adapter config carries.
 * Returns nothing for an unrestricted server, so its config is exactly what
 * it always was.
 */
function toolLimitFor(
  mcpServer: McpServerRecord,
  limit: string[] | undefined
): { enabledTools?: string[]; knownTools?: string[] } {
  if (limit === undefined) return {}
  return {
    enabledTools: resolveAllowedToolNames({ serverTools: mcpServer.tools, limit }),
    knownTools: (mcpServer.tools || []).map(tool => tool.name).filter(Boolean)
  }
}

/** Converts the agent's configured MCP servers from DB format to adapter format. */
export async function buildMcpServers(
  db: DatabaseManager,
  oauthManager: OAuthManager | null,
  agentId: string,
  opts?: McpServerOptions
): Promise<Record<string, McpServerConfig>> {
  const agent = db.getAgent(agentId)
  const mcpEntries = agent?.config?.mcp_servers || []
  const result: Record<string, McpServerConfig> = {}
  // Per-agent tool limits travel with each server so adapters can enforce
  // them. resolveDocumentedMcpServers reads them through the same parser, so
  // the tools AGENTS.md lists and the tools the session gets cannot diverge.
  const toolLimits = readServerToolLimits(mcpEntries)
  // startTaskApiServer is fire-and-forget during DB init and may not be done yet.
  await waitForTaskApiServer()
  // Let the renderer paint before the (synchronous) DB lookups below.
  await new Promise<void>((r) => setImmediate(r))

  for (const serverId of toolLimits.keys()) {
    const mcpServer = db.getMcpServer(serverId)
    if (!mcpServer) continue

    if (mcpServer.name === 'task-management') {
      const taskManagement = buildTaskManagementMcpConfig(opts)
      if (taskManagement) result[mcpServer.name] = taskManagement
    } else if (mcpServer.type === 'local') {
      result[mcpServer.name] = {
        type: 'stdio',
        command: mcpServer.command,
        args: mcpServer.args,
        env: { ...mcpServer.environment },
        ...toolLimitFor(mcpServer, toolLimits.get(serverId))
      }
    } else if (mcpServer.type === 'remote') {
      let headers = { ...mcpServer.headers }
      if (oauthManager && mcpServer.oauth_metadata && 'resource_url' in mcpServer.oauth_metadata) {
        const token = await oauthManager.getValidMcpServerToken(mcpServer.id)
        if (token) headers = { ...headers, Authorization: `Bearer ${token}` }
      }
      result[mcpServer.name] = {
        type: 'http',
        url: mcpServer.url,
        headers,
        ...toolLimitFor(mcpServer, toolLimits.get(serverId))
      }
    }
  }

  if (opts?.ensureTaskManagement && !result['task-management']) {
    const taskManagement = buildTaskManagementMcpConfig(opts)
    if (taskManagement) result['task-management'] = taskManagement
  }

  return result
}

/** Tells the agent which secret env vars exist and how to use them in bash. */
function buildSecretsSystemPrompt(secrets: SecretRecord[]): string {
  let prompt = '\n\n## Available Secrets\n\n'
  prompt += 'The following environment variables are automatically injected into every bash command you run. '
  prompt += 'Use them with `$VAR_NAME` in bash — do NOT hardcode, echo, or log their values.\n\n'
  for (const s of secrets) {
    prompt += `- \`$${s.env_var_name}\` — ${s.name}`
    if (s.description) prompt += `: ${s.description}`
    prompt += '\n'
  }
  return prompt
}

/**
 * The model for this session: the first attached skill's usable preferred
 * model, else the agent's model (see skill-model.ts). Session only: the
 * agent record is not touched.
 */
function sessionModel(
  db: DatabaseManager,
  agent: AgentRecord,
  params: { task?: TaskRecord | null; availableModels?: string[] | null; onModelNotice?: (notice: string) => void }
): string | undefined {
  const skillIds = orderedSkillIds(params.task?.skill_ids, agent.config?.skill_ids)
  if (skillIds.length === 0) return agent.config?.model
  const byId = new Map(db.getSkillsByIds(skillIds).map((skill) => [skill.id, skill]))
  const skills = skillIds.flatMap((id) => byId.get(id) ?? [])
  const backend = agent.config?.coding_agent || 'opencode'
  const resolution = resolveSkillModel({
    agentModel: agent.config?.model,
    backend,
    skills,
    availableModels: params.availableModels !== undefined ? params.availableModels : knownBackendModels(backend)
  })
  if (resolution.source === 'skill') {
    console.log(`[AgentManager] Session model ${resolution.model} from skill "${resolution.skillName}" (agent model ${agent.config?.model || 'default'})`)
  }
  if (resolution.notice) {
    console.warn(`[AgentManager] ${resolution.notice}`)
    params.onModelNotice?.(resolution.notice)
  }
  return resolution.model
}

/**
 * Builds the adapter session config shared by start, resume and follow-up
 * sends. Secret broker fields are attached only when a broker token exists;
 * decrypted secret values and the secrets prompt come from the agent config.
 * A coordinator task (the Mastermind) gets the built-in Mastermind prompt
 * first, whatever the backend, with `systemPrompt` appended after it.
 */
export function assembleSessionConfig(
  db: DatabaseManager,
  agent: AgentRecord,
  params: {
    agentId: string
    taskId: string
    task?: TaskRecord | null
    workspaceDir: string
    mcpServers: Record<string, McpServerConfig>
    systemPrompt?: string
    secretToken?: string
    /** Backend model ids to validate skill preferred models against; defaults to the last listing. */
    availableModels?: string[] | null
    /** Told why a skill's preferred model was not used (the session still runs). */
    onModelNotice?: (notice: string) => void
  }
): SessionConfig {
  const config: SessionConfig = {
    agentId: params.agentId,
    taskId: params.taskId,
    workspaceDir: params.workspaceDir,
    model: sessionModel(db, agent, params),
    reasoningEffort: agent.config?.reasoning_effort,
    systemPrompt: isCoordinatorTask(params.task)
      ? withMastermindSystemPrompt(params.systemPrompt)
      : params.systemPrompt,
    mcpServers: params.mcpServers,
    // OpenCode enforces per-agent MCP tool limits through session.prompt's
    // tool map (Claude Code reads enabledTools from mcpServers directly).
    tools: opencodeDisallowedToolMap(params.mcpServers),
    authMethod: agent.config?.auth_method,
    permissionMode: agent.config?.permission_mode,
    sandboxMode: agent.config?.sandbox_mode,
    apiKeys: agent.config?.api_keys,
    tillDone: shouldEnableTillDone(params.taskId, params.task)
  }

  if (params.secretToken) {
    const brokerPort = getSecretBrokerPort()
    if (brokerPort) {
      config.secretBrokerPort = brokerPort
      config.secretSessionToken = params.secretToken
      config.secretShellPath = writeSecretShellWrapper()
    }
  }

  const secretIds = agent.config?.secret_ids
  if (secretIds && secretIds.length > 0) {
    const secretRecords = db.getSecretsByIds(secretIds)
    const secretsWithValues = db.getSecretsWithValues(secretIds)
    if (secretsWithValues.length > 0) {
      config.secretEnvVars = {}
      for (const s of secretsWithValues) config.secretEnvVars[s.env_var_name] = s.value
    }
    if (secretRecords.length > 0) {
      config.systemPrompt = (config.systemPrompt || '') + buildSecretsSystemPrompt(secretRecords)
    }
  }

  return config
}
