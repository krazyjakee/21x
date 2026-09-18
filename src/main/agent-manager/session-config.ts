import type { AgentMcpServerEntry, AgentRecord, DatabaseManager, SecretRecord, TaskRecord } from '../database'
import type { McpServerConfig, SessionConfig } from '../adapters/coding-agent-adapter'
import type { OAuthManager } from '../oauth/oauth-manager'
import { TaskStatus } from '../../shared/constants'
import { getTaskApiPort, getTaskApiToken, waitForTaskApiServer } from '../task-api-server'
import { buildTaskMcpUrl } from '../task-mcp-endpoint'
import { getSecretBrokerPort, writeSecretShellWrapper } from '../secret-broker'

export interface McpServerOptions {
  ensureTaskManagement?: boolean
  taskScope?: { taskId: string; parentTaskId: string }
  artifactTaskId?: string
}

export function isTriageSessionTask(taskId: string, task?: TaskRecord | null): boolean {
  if (!task) return false
  if (taskId === 'mastermind-session') return false
  if (taskId.startsWith('heartbeat-')) return false
  return task.status === TaskStatus.Triaging ||
    (Object.prototype.hasOwnProperty.call(task, 'agent_id') && !task.agent_id)
}

export function shouldEnableTillDone(taskId: string, task?: TaskRecord | null): boolean {
  if (taskId === 'mastermind-session') return false
  if (taskId.startsWith('heartbeat-')) return false
  if (isTriageSessionTask(taskId, task)) return false
  if (task?.status === TaskStatus.AgentLearning) return false
  return true
}

/** Real task sessions always get task-management so they can triage, orchestrate
 *  subtasks, and inspect live task state regardless of per-agent MCP config. */
export function mcpOptionsForTask(taskId: string, task?: TaskRecord | null): McpServerOptions {
  return {
    ensureTaskManagement: taskId === 'mastermind-session' || !!task,
    taskScope: task?.parent_task_id ? { taskId, parentTaskId: task.parent_task_id } : undefined,
    artifactTaskId: task ? taskId : undefined
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
  // startTaskApiServer is fire-and-forget during DB init and may not be done yet.
  await waitForTaskApiServer()
  // Let the renderer paint before the (synchronous) DB lookups below.
  await new Promise<void>((r) => setImmediate(r))

  for (const entry of mcpEntries) {
    const serverId = typeof entry === 'string' ? entry : (entry as AgentMcpServerEntry).serverId
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
        env: { ...mcpServer.environment }
      }
    } else if (mcpServer.type === 'remote') {
      let headers = { ...mcpServer.headers }
      if (oauthManager && mcpServer.oauth_metadata && 'resource_url' in mcpServer.oauth_metadata) {
        const token = await oauthManager.getValidMcpServerToken(mcpServer.id)
        if (token) headers = { ...headers, Authorization: `Bearer ${token}` }
      }
      result[mcpServer.name] = { type: 'http', url: mcpServer.url, headers }
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
 * Builds the adapter session config shared by start, resume and follow-up
 * sends. Secret broker fields are attached only when a broker token exists;
 * decrypted secret values and the secrets prompt come from the agent config.
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
  }
): SessionConfig {
  const config: SessionConfig = {
    agentId: params.agentId,
    taskId: params.taskId,
    workspaceDir: params.workspaceDir,
    model: agent.config?.model,
    reasoningEffort: agent.config?.reasoning_effort,
    systemPrompt: params.systemPrompt,
    mcpServers: params.mcpServers,
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
