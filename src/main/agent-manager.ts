import { DEFAULT_SERVER_URL } from './adapters/opencode-server'
import { buildAgentSwitchRecap, INITIAL_PROMPT_PART_PREFIX } from './agent-handoff'
import { EventEmitter } from 'events'
import type { BrowserWindow } from 'electron'
import type { AgentRecord, DatabaseManager, TaskRecord } from './database'
import { TaskStatus } from '../shared/constants'
import { isCoordinatorTask } from '../shared/task-roles'
import { emitTaskEvent } from './project-events'
import type { WorktreeManager } from './worktree-manager'
import type { GitHubManager } from './github-manager'
import type { GitLabManager } from './gitlab-manager'
import type { ForgejoManager } from './forgejo-manager'
import type { CodingAgentAdapter, McpServerConfig, SessionConfig, SessionMessage } from './adapters/coding-agent-adapter'
import { MessagePartType } from './adapters/coding-agent-adapter'
import { randomUUID } from 'crypto'
import { registerSecretSession, unregisterSecretSession, getSecretBrokerPort } from './secret-broker'
import { CodingAgentType, createAdapter, getAgentProvider } from './agent-manager/adapter-factory'
import { assembleSessionConfig, buildMcpServers, isTriageSessionTask, mcpOptionsForTask, type McpServerOptions } from './agent-manager/session-config'
import { getAdapterMcpAttachFailures, getMemoryFileName, writeSkillFiles } from './agent-manager/workspace-docs'
import { buildDisplayMessage, buildMessageWithAttachmentContext, syncAttachmentsToWorkspace, type MessageAttachmentRef } from './agent-manager/attachments'
import { emptySkillSyncResult, syncSkillsFromDirectory, type SkillSyncResult } from './agent-manager/skills-sync'
import { ARTIFACT_WORKSPACE_INSTRUCTIONS, HEARTBEAT_MONITORING_INSTRUCTIONS, buildTaskWorkPrompt, buildTriagePrompt } from './agent-manager/prompts'
import { setupTaskWorktrees } from './agent-manager/worktree-setup'
import { listProjectRepos, taskProjectId } from './agent-manager/project-repos'
import { dedupStateFromHistory } from './agent-manager/output-dedup'
import { findCreditExhaustionMessage, normalizeFallbackAgentIds } from './agent-manager/credit-exhaustion'
import { SessionAdmission, type QueuedStartInfo } from './agent-manager/admission'
import { isAllProjectsPaused, setAllProjectsPaused, type ProjectLimitState } from './project-limits'
import { debugTranscript, textTranscript, type DebugTranscriptMessage, notifyStatusTransition } from './agent-manager/transcript-events'
import { SessionPoller, yieldEventLoop } from './agent-manager/polling'
import { TranscriptProjection } from './agent-manager/transcript-projection'
import { respondToPermission } from './agent-manager/permissions'
import { transitionToIdle } from './agent-manager/turn-completion'
import { ParentWakeups, startTask, type StartTaskResult } from './agent-manager/task-orchestration'
import { RuntimeLifetime } from './agent-manager/runtime-lifetime'
import type { AgentFallbackState, AgentSession, SessionHost, SessionStartOutcome } from './agent-manager/types'

/** Cap on remembered temp -> real session id redirects. */
const MAX_SESSION_REDIRECTS = 200

export class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map()
  /** Old (temp) session ids -> their re-keyed real ids, so stale ids from the renderer still resolve. */
  private sessionIdRedirects: Map<string, string> = new Map()
  private db: DatabaseManager
  private mainWindow: BrowserWindow | null = null
  private adapters: Map<string, CodingAgentAdapter> = new Map()
  private worktreeManager: WorktreeManager | null = null
  private githubManager: GitHubManager | null = null
  private gitlabManager: GitLabManager | null = null
  private forgejoManager: ForgejoManager | null = null
  private oauthManager: import('./oauth/oauth-manager').OAuthManager | null = null
  /** Executes task source actions (e.g. completing tasks at the source). */
  private syncManager?: import('./sync-manager').SyncManager
  /** Last status sent per session, to detect transitions for OS notifications. */
  private lastSentStatus: Map<string, string> = new Map()

  private readonly host: SessionHost
  private readonly poller: SessionPoller
  private readonly admission: SessionAdmission
  private readonly projection: TranscriptProjection
  private readonly lifetime: RuntimeLifetime
  private readonly parentWakeups: ParentWakeups

  constructor(db: DatabaseManager) {
    super()
    this.db = db
    // Late-bound so the helper modules see instance overrides (tests spy on these).
    const host: SessionHost = this.host = {
      db,
      sessions: this.sessions,
      resolveSession: (id, caller) => this.resolveSession(id, caller),
      findSessionByTaskId: (taskId) => this.findSessionByTaskId(taskId),
      hasActiveSessionForTask: (taskId) => this.hasActiveSessionForTask(taskId),
      rekeySession: (oldId, newId, taskId) => this.rekeySession(oldId, newId, taskId),
      sessionConfigFor: (session) => this.sessionConfigFor(session),
      buildSessionConfig: (agentId, taskId, dir) => this.buildSessionConfig(agentId, taskId, dir),
      emitStatus: (id, owner, status) => this.emitStatus(id, owner, status),
      emitSystemError: (id, taskId, partId, content) => this.emitSystemError(id, taskId, partId, content),
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
      updateTaskFromLocalAgent: (taskId, updates) => this.updateTaskFromLocalAgent(taskId, updates),
      hasActiveSubtaskWork: (taskId) => this.hasActiveSubtaskWork(taskId),
      tryAutomaticFallback: (id, session, message) => this.tryAutomaticFallback(id, session, message),
      transitionToIdle: (id, session) => transitionToIdle(host, this.poller, id, session),
      sendAdapterMessage: (session, id, message) => this.doSendAdapterMessage(session, id, message),
      sendInBackground: (session, id, message, attachments) => this.sendInBackground(session, id, message, attachments),
      sendMessage: (id, message, taskId, agentId) => this.sendMessage(id, message, taskId, agentId),
      sendByTaskId: (taskId, message) => this.sendByTaskId(taskId, message),
      startSessionNow: (agentId, taskId, dir, skip) => this.startSessionNow(agentId, taskId, dir, skip),
      startSession: (agentId, taskId) => this.startSession(agentId, taskId),
      requestSession: (agentId, taskId) => this.requestSession(agentId, taskId),
      startTask: (taskId, opts) => this.startTask(taskId, opts),
      stopSession: (id, resetTaskStatus) => this.stopSession(id, resetTaskStatus),
      releaseAdapterSession: (id, reason) => this.releaseAdapterSession(id, reason),
      notifyParentOfSubtaskCompletion: (parentId, subtaskId) => this.notifyParentOfSubtaskCompletion(parentId, subtaskId),
      syncSkillsFromWorkspace: (id) => this.syncSkillsFromWorkspace(id),
      getSyncManager: () => this.syncManager,
      defaultAgentId: () => this.defaultAgent()?.id,
      scheduleStartQueueDrain: () => this.admission.scheduleDrain(),
      schedulePowerSaveBlockerUpdate: () => this.lifetime.scheduleBlockerUpdate()
    }
    this.poller = new SessionPoller(host)
    this.admission = new SessionAdmission(host)
    this.projection = new TranscriptProjection(db, (agentId) => this.getAdapter(agentId), () => this.mainWindow)
    this.lifetime = new RuntimeLifetime(host)
    this.parentWakeups = new ParentWakeups(host)
    this.lifetime.startReaper()
  }

  /**
   * True when the task is coordinating subtasks that are still being worked on.
   * Child progress counts as parent activity: a coordinator session that is
   * silent while its subtask agents run is NOT stuck and must not be aborted
   * or reaped, otherwise the child work gets orphaned or cascaded-killed.
   */
  private hasActiveSubtaskWork(taskId: string): boolean {
    try {
      const subtasks = this.db.getSubtasks(taskId)
      return subtasks.some(
        (s) => s.status === TaskStatus.AgentWorking || s.status === TaskStatus.Triaging
      )
    } catch {
      return false
    }
  }

  setSyncManager(syncManager: import('./sync-manager').SyncManager): void {
    this.syncManager = syncManager
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setManagers(githubManager: GitHubManager, worktreeManager: WorktreeManager, gitlabManager?: GitLabManager, forgejoManager?: ForgejoManager): void {
    this.githubManager = githubManager
    this.worktreeManager = worktreeManager
    this.gitlabManager = gitlabManager ?? null
    this.forgejoManager = forgejoManager ?? null
  }

  setOAuthManager(manager: import('./oauth/oauth-manager').OAuthManager): void {
    this.oauthManager = manager
  }

  /**
   * The repos of a task's project, for the triage prompt. A failed read must
   * not stop triage: the agent can still call list_repos.
   */
  private projectRepoNames(task: TaskRecord): string[] {
    try {
      return listProjectRepos(this.db, taskProjectId(task)).map((repo) => repo.fullName)
    } catch (error) {
      console.warn(`[AgentManager] Could not read the project repos of task ${task.id} for triage:`, error)
      return []
    }
  }

  private setupWorktreeIfNeeded(taskId: string): Promise<string | undefined> {
    const { worktreeManager, githubManager, gitlabManager, forgejoManager } = this
    return setupTaskWorktrees(this.db, { worktreeManager, githubManager, gitlabManager, forgejoManager }, taskId)
  }

  private getAdapter(agentId: string): CodingAgentAdapter | null {
    const agent = this.db.getAgent(agentId)
    if (!agent) return null
    return this.getAdapterByType(getAgentProvider(agent))
  }

  /** Adapters are created lazily and cached per backend type. */
  private getAdapterByType(backendType: string): CodingAgentAdapter | null {
    const cached = this.adapters.get(backendType)
    if (cached) return cached
    const adapter = createAdapter(backendType, this.db)
    if (adapter) this.adapters.set(backendType, adapter)
    return adapter
  }

  private buildMcpServersForAdapter(agentId: string, opts?: McpServerOptions): ReturnType<typeof buildMcpServers> {
    return buildMcpServers(this.db, this.oauthManager, agentId, opts)
  }

  /** Task context in the system prompt keeps follow-ups aware of the task and
   *  survives context compaction. A coordinator row is not work to describe. */
  private taskContextPrompt(task: TaskRecord | undefined): string {
    return task && !isCoordinatorTask(task)
      ? `\n\n[Task Context]\nTask: "${task.title}"\n${task.description || ''}${ARTIFACT_WORKSPACE_INSTRUCTIONS}`
      : ''
  }

  /** Session config for follow-up calls on an existing session (send, abort, stop). */
  private async buildSessionConfig(agentId: string, taskId: string, workspaceDir?: string): Promise<SessionConfig> {
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }
    const task = this.db.getTask(taskId)
    const mcpServers = await this.buildMcpServersForAdapter(agentId, mcpOptionsForTask(taskId, task, this.heartbeatScopeTask(taskId, task)))
    return assembleSessionConfig(this.db, agent, {
      agentId,
      taskId,
      task,
      workspaceDir: workspaceDir || this.db.getWorkspaceDir(taskId),
      mcpServers,
      systemPrompt: (agent.config?.system_prompt || '') + this.taskContextPrompt(task),
      secretToken: this.findSessionByTask(agentId, taskId)?.secretSessionToken
    })
  }

  /** Minimal adapter config for status/message reads on a live session. */
  private sessionConfigFor(session: AgentSession): SessionConfig {
    return {
      agentId: session.agentId,
      taskId: session.taskId,
      workspaceDir: session.workspaceDir || this.db.getWorkspaceDir(session.taskId)
    }
  }

  /**
   * Sets up a secret broker session for an agent, registering its secrets.
   * Returns the token, or undefined if no secrets are configured.
   */
  private setupSecretSession(agentId: string): string | undefined {
    const agent = this.db.getAgent(agentId)
    const secretIds = agent?.config?.secret_ids
    if (!secretIds || secretIds.length === 0) return undefined

    const brokerPort = getSecretBrokerPort()
    if (!brokerPort) {
      console.warn('[AgentManager] Secret broker not running — secrets will not be injected')
      return undefined
    }

    const token = randomUUID()
    registerSecretSession(token, agentId, secretIds)
    console.log(`[AgentManager] Secret session registered for agent ${agentId} with ${secretIds.length} secret(s)`)
    return token
  }

  private findSessionByTask(agentId: string, taskId: string): AgentSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.agentId === agentId && session.taskId === taskId) {
        return session
      }
    }
    return undefined
  }

  /** Looks a session up by id, following a temp -> real re-key redirect. */
  private resolveSession(sessionId: string, caller?: string): { sessionId: string; session: AgentSession } | undefined {
    const session = this.sessions.get(sessionId)
    if (session) return { sessionId, session }
    const redirectedId = this.sessionIdRedirects.get(sessionId)
    const redirected = redirectedId ? this.sessions.get(redirectedId) : undefined
    if (!redirectedId || !redirected) return undefined
    if (caller) {
      console.log(`[SessionTracker] REDIRECT from=${sessionId} to=${redirectedId} reason=stale_id_in_${caller}`)
    }
    return { sessionId: redirectedId, session: redirected }
  }

  private emitStatus(sessionId: string, owner: { agentId: string; taskId: string }, status: AgentSession['status']): void {
    this.sendToRenderer('agent:status', { sessionId, agentId: owner.agentId, taskId: owner.taskId, status })
    // Every idle transition and every stop ends here: a slot may have freed.
    if (status === 'idle' || status === 'error') this.admission.scheduleDrain()
    // Project events (#57): an agent waiting on the user, or one that failed,
    // wakes the project's Captain. Pseudo-tasks and coordinator rows are
    // dropped by emitTaskEvent itself.
    if (status === 'waiting_approval') emitTaskEvent(this.db, 'approval_pending', owner.taskId)
    else if (status === 'error') emitTaskEvent(this.db, 'task_failed', owner.taskId)
  }

  private emitSystemError(sessionId: string, taskId: string, id: string, content: string): void {
    this.sendToRenderer('agent:output', {
      sessionId,
      taskId,
      type: 'message',
      data: { id, role: 'system', content, partType: 'error' }
    })
  }

  private emitSystemNotice(sessionId: string, taskId: string, id: string, content: string): void {
    this.sendToRenderer('agent:output', {
      sessionId,
      taskId,
      type: 'message',
      data: { id, role: 'system', content, partType: 'text' }
    })
  }

  /** Stops the shared OpenCode server, if one was started. */
  async stopServer(): Promise<void> {
    const adapter = this.adapters.get(CodingAgentType.OPENCODE) as { stopServer?: () => Promise<void> } | undefined
    await adapter?.stopServer?.()
  }

  /**
   * Steps shared by a new and a resumed session: MCP servers, secrets, the
   * session config and adapter initialization. Workspace docs are written
   * AFTER the MCP map is built so they describe the servers this session
   * really gets, not the agent configuration (which over- and under-reports).
   */
  private async prepareAdapterSession(
    adapter: CodingAgentAdapter,
    agentId: string,
    agent: AgentRecord,
    taskId: string,
    task: TaskRecord | undefined,
    workspaceDir: string,
    opts: { systemPrompt?: string; writeWorkspaceDocs?: boolean; onModelNotice?: (notice: string) => void }
  ): Promise<{ sessionConfig: SessionConfig; mcpServers: Record<string, McpServerConfig>; secretToken?: string }> {
    await yieldEventLoop()
    const mcpServers = await this.buildMcpServersForAdapter(agentId, mcpOptionsForTask(taskId, task, this.heartbeatScopeTask(taskId, task)))
    if (opts.writeWorkspaceDocs) {
      await writeSkillFiles(this.db, taskId, agentId, workspaceDir, mcpServers)
      await yieldEventLoop()
    }
    const secretToken = this.setupSecretSession(agentId)
    const sessionConfig = assembleSessionConfig(this.db, agent, {
      agentId,
      taskId,
      task,
      workspaceDir,
      mcpServers,
      systemPrompt: opts.systemPrompt,
      secretToken,
      onModelNotice: opts.onModelNotice
    })
    await yieldEventLoop()
    await adapter.initialize()
    return { sessionConfig, mcpServers, secretToken }
  }

  /**
   * Starts a session on a coding agent adapter.
   *
   * @param handoffFromAgentName - Set when this session replaces a different
   * agent mid-task (see switchAgent). Each backend has its own incompatible
   * session format, so there is no native resume across a switch; the initial
   * prompt gets a recap of the existing transcript instead.
   */
  private async startAdapterSession(
    adapter: CodingAgentAdapter,
    agentId: string,
    taskId: string,
    workspaceDir?: string,
    skipInitialPrompt?: boolean,
    handoffFromAgentName?: string,
    inheritedFallbackState?: AgentFallbackState
  ): Promise<string> {
    const agent = this.db.getAgent(agentId)!
    workspaceDir ||= this.db.getWorkspaceDir(taskId)
    const task = this.db.getTask(taskId)
    const isTriageSession = isTriageSessionTask(taskId, task)

    console.log(`[AgentManager] startAdapterSession: agent=${agent.name}, coding_agent=${agent.config?.coding_agent || 'opencode'}, model=${agent.config?.model}, adapter=${adapter.constructor.name}`)
    const { sessionConfig, mcpServers, secretToken } = await this.prepareAdapterSession(adapter, agentId, agent, taskId, task, workspaceDir, {
      systemPrompt: agent.config?.system_prompt,
      writeWorkspaceDocs: true,
      onModelNotice: (notice) => this.emitSystemError('', taskId, `skill-model-${Date.now()}`, notice)
    })

    const adapterSessionId = await adapter.createSession(sessionConfig)
    console.log(`[AgentManager] Session created: ${adapterSessionId}, workspaceDir=${workspaceDir}`)

    // OpenCode attaches MCP servers through runtime calls that can still fail.
    // An agent told it has tools it cannot call behaves far worse than one that
    // knows it has none, so the docs are rewritten without the failed servers.
    const attachFailures = getAdapterMcpAttachFailures(adapter, adapterSessionId)
    if (attachFailures.length > 0) {
      console.error(
        `[AgentManager] MCP servers NOT attached for session ${adapterSessionId}: ${attachFailures.join(', ')} — ` +
        `rewriting session documentation without them`
      )
      const attached = Object.fromEntries(
        Object.entries(mcpServers).filter(([name]) => !attachFailures.includes(name))
      )
      await writeSkillFiles(this.db, taskId, agentId, workspaceDir, attached)
    }

    this.lifetime.scheduleBlockerUpdate()
    // One shared set across nested startup fallbacks: if a replacement itself
    // exhausts credits before this returns, the outer handoff must see every
    // agent the nested one already attempted.
    const attemptedAgentIds = inheritedFallbackState?.attemptedAgentIds ?? new Set<string>()
    attemptedAgentIds.add(agentId)
    const configuredFallbacks = normalizeFallbackAgentIds(agent.config?.fallback_agent_ids)
    const fallbackAgentIds = [
      ...(inheritedFallbackState?.remainingAgentIds ?? []),
      ...configuredFallbacks,
    ].filter((id, index, ids) => id !== agentId && !attemptedAgentIds.has(id) && ids.indexOf(id) === index)

    this.sessions.set(adapterSessionId, {
      id: adapterSessionId,
      agentId,
      taskId,
      workspaceDir,
      status: 'working',
      createdAt: new Date(),
      lastActivityAt: Date.now(),
      seenMessageIds: new Set(),
      seenPartIds: new Set(),
      partContentLengths: new Map(),
      assistantTextKeys: new Set(),
      adapter,
      isTriageSession,
      secretSessionToken: secretToken,
      fallbackAgentIds,
      attemptedAgentIds
    })

    this.updateTaskFromLocalAgent(taskId, { session_id: adapterSessionId })
    console.log(`[SessionTracker] CREATED session=${adapterSessionId} task=${taskId} agent=${agentId} reason=new_session`)

    // Triage sessions keep the Triaging status; coordinator rows have none.
    if (!isTriageSession && !isCoordinatorTask(task)) {
      this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.AgentWorking })
      this.sendToRenderer('task:updated', {
        taskId,
        updates: { status: TaskStatus.AgentWorking }
      })
    }
    await yieldEventLoop()

    this.emitStatus(adapterSessionId, { agentId, taskId }, 'working')

    this.poller.start(adapterSessionId, adapter, sessionConfig)

    if (!skipInitialPrompt) {
      let promptText: string
      if (isTriageSession && task) {
        promptText = buildTriagePrompt(task, this.projectRepoNames(task))
      } else {
        promptText = buildTaskWorkPrompt(this.db, taskId, task ?? this.db.getTask(taskId))
        const attachmentRefs = syncAttachmentsToWorkspace(this.db, taskId, workspaceDir)
        if (attachmentRefs.length > 0) {
          promptText += `\n\nAttached files (relative to your working directory):\n${attachmentRefs.join('\n')}`
        }
      }
      promptText += HEARTBEAT_MONITORING_INSTRUCTIONS
      // In the user message because agents follow it more reliably than the system prompt.
      promptText += `\n\nIMPORTANT: First, read the \`${getMemoryFileName(this.db, agentId)}\` file in the working directory — it has workspace config, skills, and project context.`

      // Prepended last so the handoff recap reads first.
      if (handoffFromAgentName) {
        const recap = buildAgentSwitchRecap(this.db.getTranscriptParts(taskId))
        if (recap) {
          promptText = `## Picking up from ${handoffFromAgentName}\n\nThis task was previously being worked on by a different agent. Here is the conversation so far:\n\n${recap}\n\n---\n\n${promptText}`
        }
      }

      // The full prompt is shown so the user sees everything the agent was told.
      this.sendToRenderer('agent:output', {
        sessionId: adapterSessionId,
        taskId,
        type: 'message',
        data: {
          id: `${INITIAL_PROMPT_PART_PREFIX}${Date.now()}`,
          role: 'user',
          content: promptText,
          partType: 'text'
        }
      })

      try {
        await adapter.sendPrompt(adapterSessionId, [{ type: MessagePartType.TEXT, text: promptText }], sessionConfig)
      } catch (sendError) {
        console.error(`[AgentManager] sendPrompt FAILED:`, sendError)
        const message = sendError instanceof Error ? sendError.message : String(sendError)
        const session = this.sessions.get(adapterSessionId)
        if (session && findCreditExhaustionMessage([message]) && await this.tryAutomaticFallback(adapterSessionId, session, message)) {
          return this.findSessionByTaskId(taskId)?.sessionId || adapterSessionId
        }
        throw sendError
      }
    }

    return adapterSessionId
  }

  private rekeySession(oldId: string, newId: string, taskId: string): void {
    this.updateTaskFromLocalAgent(taskId, { session_id: newId })
    const session = this.sessions.get(oldId)
    if (!session) return
    this.sessions.delete(oldId)
    this.sessions.set(newId, session)
    // Maps keep insertion order: evict the oldest half once the cap is hit.
    if (this.sessionIdRedirects.size >= MAX_SESSION_REDIRECTS) {
      let toEvict = Math.ceil(MAX_SESSION_REDIRECTS / 2)
      for (const key of this.sessionIdRedirects.keys()) {
        if (toEvict-- <= 0) break
        this.sessionIdRedirects.delete(key)
      }
    }
    this.sessionIdRedirects.set(oldId, newId)
  }

  /**
   * Moves an exhausted task to the next configured agent. The shared worktree
   * and durable transcript remain in place; switchAgentWithContext seeds the
   * new backend with the conversation recap and carries the rest of the chain.
   */
  private async tryAutomaticFallback(
    sessionId: string,
    session: AgentSession,
    exhaustionMessage: string
  ): Promise<boolean> {
    if (session.fallbackInProgress || session.fallbackAgentIds.length === 0) return false
    session.fallbackInProgress = true

    while (session.fallbackAgentIds.length > 0) {
      const fallbackAgentId = session.fallbackAgentIds.shift()!
      if (session.attemptedAgentIds.has(fallbackAgentId)) continue
      session.attemptedAgentIds.add(fallbackAgentId)

      const fallbackAgent = this.db.getAgent(fallbackAgentId)
      if (!fallbackAgent) {
        console.warn(`[AgentManager] Skipping deleted fallback agent ${fallbackAgentId} for task ${session.taskId}`)
        continue
      }

      const currentAgent = this.db.getAgent(session.agentId)
      const fromName = currentAgent?.name || 'the current agent'
      const detail = exhaustionMessage.replace(/\s+/g, ' ').trim().slice(0, 300)
      this.emitSystemNotice(
        sessionId,
        session.taskId,
        `automatic-fallback-${Date.now()}`,
        `${fromName} cannot continue because its credits or usage quota are exhausted. Automatically handing off to ${fallbackAgent.name}.${detail ? `\n\nProvider message: ${detail}` : ''}`
      )

      try {
        await this.switchAgentWithContext(session.taskId, fallbackAgentId, {
          remainingAgentIds: [...session.fallbackAgentIds],
          attemptedAgentIds: session.attemptedAgentIds
        })
        console.log(`[AgentManager] Automatic fallback succeeded for task ${session.taskId}: ${session.agentId} -> ${fallbackAgentId}`)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[AgentManager] Automatic fallback to ${fallbackAgent.name} failed:`, error)
        this.emitSystemError(
          '',
          session.taskId,
          `automatic-fallback-error-${Date.now()}`,
          `Could not start fallback agent ${fallbackAgent.name}: ${message}`
        )

        // A failure after createSession may leave a partially-created runtime.
        // Release it before trying the next candidate in the ordered chain.
        const partial = this.findSessionByTaskId(session.taskId)
        if (partial && partial.session.agentId === fallbackAgentId) {
          await this.stopSession(partial.sessionId, false)
          this.updateTaskFromLocalAgent(session.taskId, { session_id: null })
        }
      }
    }

    session.fallbackInProgress = false
    if (!this.findSessionByTaskId(session.taskId)) {
      this.updateTaskFromLocalAgent(session.taskId, { session_id: null })
    }
    this.emitSystemError(
      '',
      session.taskId,
      `automatic-fallback-exhausted-${Date.now()}`,
      'Every configured fallback agent was unavailable. The task has been stopped so you can review the agent configuration and retry.'
    )
    return false
  }

  private async resumeAdapterSession(
    adapter: CodingAgentAdapter,
    agentId: string,
    taskId: string,
    adapterSessionId: string
  ): Promise<string> {
    const agent = this.db.getAgent(agentId)!
    // Same workspace resolution as startSession: Claude Code stores session
    // files under a path derived from workspaceDir, so a different directory
    // would not find the session.
    const workspaceDir = await this.setupWorktreeIfNeeded(taskId) || this.db.getWorkspaceDir(taskId)
    // Picks up attachments added since the session was started or last resumed.
    syncAttachmentsToWorkspace(this.db, taskId, workspaceDir)

    const task = this.db.getTask(taskId)
    const { sessionConfig, secretToken } = await this.prepareAdapterSession(adapter, agentId, agent, taskId, task, workspaceDir, {
      systemPrompt: (agent.config?.system_prompt || '') + this.taskContextPrompt(task)
    })

    let messages: SessionMessage[]
    try {
      messages = await adapter.resumeSession(adapterSessionId, sessionConfig)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.log('[AgentManager] adapter.resumeSession threw error:', errorMessage)

      if (
        errorMessage.includes('INCOMPATIBLE_SESSION_ID') ||
        errorMessage.includes('No conversation found') ||
        errorMessage.includes('SESSION_FILE_NOT_FOUND') ||
        errorMessage.includes('Session no longer exists on server')
      ) {
        console.warn(`[AgentManager] Session not found or incompatible: ${adapterSessionId}`)

        const currentTask = this.db.getTask(taskId)
        // A coordinator conversation the backend no longer has is simply over;
        // the caller opens a new one. There is no task to ask the user about.
        if (isCoordinatorTask(currentTask)) {
          console.log(`[AgentManager] Coordinator session ${adapterSessionId} is gone — clearing session_id for ${taskId}`)
          this.updateTaskFromLocalAgent(taskId, { session_id: null })
          return ''
        }
        const pendingFeedback = currentTask?.status === TaskStatus.AgentLearning
          && this.db.getSetting(`session-feedback-completion:${taskId}`)
        // A finished task's session may simply have ended: no alarming dialog,
        // just '' (session gone) so the UI offers "Start".
        if (currentTask && (currentTask.status === TaskStatus.ReadyForReview || currentTask.status === TaskStatus.Completed || pendingFeedback)) {
          console.log(`[AgentManager] Session ended normally for ${currentTask.status} task ${taskId} — clearing session_id`)
          this.updateTaskFromLocalAgent(taskId, { session_id: null })
          this.sendToRenderer('task:updated', { taskId, updates: { session_id: null } })
          return ''
        }

        this.updateTaskFromLocalAgent(taskId, { session_id: null })

        const userMessage = errorMessage.includes('SESSION_FILE_NOT_FOUND')
          ? 'Session file not found. The session may have been deleted or never synced. Would you like to start a new session?'
          : errorMessage.includes('No conversation found')
            ? 'Session not found on server. Would you like to start a new session?'
            : errorMessage.replace('INCOMPATIBLE_SESSION_ID: ', '')
        // The renderer asks the user whether to start fresh.
        this.sendToRenderer('agent:incompatible-session', { taskId, agentId, error: userMessage })

        throw new Error('SESSION_INCOMPATIBLE')
      }
      throw error
    }

    // The dedup state keeps polling from re-emitting history. Resume does not
    // push the transcript: clients render the durable projection.
    const dedupState = dedupStateFromHistory(messages)
    this.lifetime.scheduleBlockerUpdate()
    this.sessions.set(adapterSessionId, {
      id: adapterSessionId,
      agentId,
      taskId,
      workspaceDir,
      status: 'idle',
      createdAt: new Date(),
      lastActivityAt: Date.now(),
      ...dedupState,
      adapter,
      pollingStarted: false,
      secretSessionToken: secretToken,
      fallbackAgentIds: normalizeFallbackAgentIds(agent.config?.fallback_agent_ids)
        .filter((id) => id !== agentId),
      attemptedAgentIds: new Set([agentId])
    })

    // Before any follow-up prompt starts: a silent resume (e.g. a wake-up after
    // the runtime was released) otherwise leaves the renderer bound to a stale
    // session id, and the wake turn's output renders late or not at all.
    this.updateTaskFromLocalAgent(taskId, { session_id: adapterSessionId })
    this.sendToRenderer('task:updated', { taskId, updates: { session_id: adapterSessionId } })

    this.emitStatus(adapterSessionId, { agentId, taskId }, 'idle')

    return adapterSessionId
  }

  /**
   * A running agent must not pull a task back out of session learning, and a
   * coordinator row has no lifecycle at all: it is never working, in review or
   * done, only resumable. Its session_id still persists like any task's.
   */
  private updateTaskFromLocalAgent(taskId: string, updates: Parameters<DatabaseManager['updateTask']>[1]): TaskRecord | undefined {
    const fields = { ...updates }
    if (fields.status !== undefined) {
      const current = this.db.getTask(taskId)
      if (isCoordinatorTask(current)) delete fields.status
      else if (fields.status === TaskStatus.AgentWorking && current?.status === TaskStatus.AgentLearning) delete fields.status
    }
    if (Object.keys(fields).length === 0) return this.db.getTask(taskId)
    const before = fields.status !== undefined ? this.db.getTask(taskId)?.status : undefined
    const updated = this.db.updateTask(taskId, fields)
    // Project event (#57): an agent's own work reaching review bypasses
    // afterTaskUpdated (task-updates.ts), so the event is raised here.
    if (fields.status === TaskStatus.ReadyForReview && updated?.status === TaskStatus.ReadyForReview && before !== TaskStatus.ReadyForReview) {
      emitTaskEvent(this.db, 'task_ready_for_review', taskId)
    }
    return updated
  }

  /** Admission-controlled start; '' when the start was queued (it runs on its own later). */
  async startSession(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string> {
    const outcome = await this.requestSession(agentId, taskId, workspaceDir, skipInitialPrompt)
    return outcome.status === 'started' ? outcome.sessionId : ''
  }

  /**
   * The admission-controlled start every entry point goes through. Starts the
   * session when it fits under the per-agent, project and global limits,
   * otherwise queues it (once per task) and reports its position. Coordinator,
   * heartbeat and triage sessions bypass the limits (see admission.ts).
   */
  requestSession(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<SessionStartOutcome> {
    return this.admission.request(agentId, taskId, workspaceDir, skipInitialPrompt)
  }

  /** Starts without admission control — callers are exempt or already admitted. */
  private async startSessionNow(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string> {
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // A coordinator conversation outlives its runtime. Rejoin the live session
    // or resume the persisted one, so a restart (or a reaped runtime) continues
    // the same Captain conversation instead of opening a blank one.
    const task = this.db.getTask(taskId)
    if (isCoordinatorTask(task)) {
      const live = this.findSessionByTaskId(taskId)
      if (live) return live.sessionId
      if (task?.session_id) {
        const resumed = await this.resumeCoordinatorSession(agentId, taskId, task.session_id)
        if (resumed) return resumed
      }
    }

    if (!workspaceDir) {
      workspaceDir = await this.setupWorktreeIfNeeded(taskId)
    }

    const adapter = this.getAdapter(agentId)
    if (!adapter) {
      throw new Error(`No adapter available for agent ${agentId}`)
    }
    return this.startAdapterSession(adapter, agentId, taskId, workspaceDir, skipInitialPrompt)
  }

  /** The real task a heartbeat pseudo-session checks, used only to scope its MCP tools. */
  private heartbeatScopeTask(taskId: string, task: TaskRecord | null | undefined): TaskRecord | undefined {
    if (task || !taskId.startsWith('heartbeat-')) return undefined
    return this.db.getTask(taskId.slice('heartbeat-'.length)) ?? undefined
  }

  /** Resumes a coordinator's persisted session; '' when it cannot be continued. */
  private async resumeCoordinatorSession(agentId: string, taskId: string, sessionId: string): Promise<string> {
    const adapter = this.getAdapter(agentId)
    if (!adapter) return ''
    try {
      return await this.resumeAdapterSession(adapter, agentId, taskId, sessionId)
    } catch (error) {
      // Backend restarted, files gone, or a different backend than the one
      // that made it. The next session starts fresh; nothing to ask the user.
      console.warn(`[AgentManager] Could not resume coordinator session ${sessionId} for ${taskId}; starting a new one:`, error)
      this.updateTaskFromLocalAgent(taskId, { session_id: null })
      return ''
    }
  }

  /**
   * Hands a task to a different agent mid-conversation. Backends have
   * incompatible session formats, so the old session is stopped and the new
   * agent's first prompt carries a recap of the transcript.
   */
  async switchAgent(taskId: string, newAgentId: string): Promise<string> {
    return this.switchAgentWithContext(taskId, newAgentId)
  }

  private async switchAgentWithContext(
    taskId: string,
    newAgentId: string,
    fallbackState?: AgentFallbackState
  ): Promise<string> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)

    const newAgent = this.db.getAgent(newAgentId)
    if (!newAgent) throw new Error(`Agent not found: ${newAgentId}`)

    const previousAgentId = task.agent_id
    const previousAgent = previousAgentId ? this.db.getAgent(previousAgentId) : undefined

    if (previousAgentId === newAgentId) {
      throw new Error(`Task is already assigned to ${newAgent.name}`)
    }

    // Resolved first so an unusable agent leaves the outgoing session and the
    // task assignment intact.
    const adapter = this.getAdapter(newAgentId)
    if (!adapter) throw new Error(`No adapter available for agent ${newAgentId}`)

    await this.stopByTaskId(taskId)
    this.updateTaskFromLocalAgent(taskId, { agent_id: newAgentId })
    this.sendToRenderer('task:updated', { taskId, updates: { agent_id: newAgentId } })

    // Reuses the existing worktrees, or repairs them if they went missing.
    const workspaceDir = await this.setupWorktreeIfNeeded(taskId)

    return this.startAdapterSession(adapter, newAgentId, taskId, workspaceDir, false, previousAgent?.name || 'a previous agent', fallbackState)
  }

  startTask(taskId: string, opts?: { preferSubtasks?: boolean; allowTriage?: boolean }): Promise<StartTaskResult> {
    return startTask(this.host, taskId, opts)
  }

  /**
   * Runs a heartbeat check in the task's own `heartbeat-<taskId>` session, so
   * checks stay out of the working session and do not mix across tasks.
   */
  async sendHeartbeatViaCaptain(agentId: string, taskId: string, heartbeatPrompt: string): Promise<string> {
    const heartbeatTaskId = `heartbeat-${taskId}`

    let sessionId = this.findSessionByTaskId(heartbeatTaskId)?.sessionId
    if (!sessionId) {
      // The real task's workspace dir gives the agent repo context for gh commands.
      const workspaceDir = this.db.getWorkspaceDir(taskId)
      console.log(`[AgentManager] Heartbeat: creating heartbeat session for task ${taskId}`)
      sessionId = await this.startSessionNow(agentId, heartbeatTaskId, workspaceDir, true /* skipInitialPrompt */)
    }

    console.log(`[AgentManager] Heartbeat: sending check via heartbeat session ${sessionId} for task ${taskId}`)
    const result = await this.sendMessage(sessionId, heartbeatPrompt, heartbeatTaskId, agentId)
    return result.newSessionId || sessionId
  }

  /** Sends heartbeat findings that need action to the task agent's own session. */
  async startHeartbeatSession(agentId: string, taskId: string, heartbeatPrompt: string): Promise<string> {
    const task = this.db.getTask(taskId)
    let sessionId = task?.session_id

    if (!sessionId) {
      console.log(`[AgentManager] Heartbeat: no session for task ${taskId}, creating new session`)
      // Heartbeat follow-ups act on work already under way; they bypass admission.
      sessionId = await this.startSessionNow(agentId, taskId, undefined, true /* skipInitialPrompt */)
    }

    console.log(`[AgentManager] Heartbeat: forwarding action to task session ${sessionId} for task ${taskId}`)
    // sendMessage resumes a dead session, sends the prompt and starts polling.
    const result = await this.sendMessage(sessionId, heartbeatPrompt, taskId, agentId)
    return result.newSessionId || sessionId
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** Stops a finished heartbeat session so they do not accumulate. */
  async cleanupHeartbeatSession(taskId: string): Promise<void> {
    const found = this.findSessionByTaskId(`heartbeat-${taskId}`)
    if (!found) return
    await this.stopSession(found.sessionId, false)
    console.log(`[AgentManager] Cleaned up heartbeat session ${found.sessionId} for task ${taskId}`)
  }

  /** Lookup by task id, which (unlike a session id) is stable across re-keying. */
  findSessionByTaskId(taskId: string): { sessionId: string; session: AgentSession } | undefined {
    for (const [id, session] of this.sessions.entries()) {
      if (session.taskId === taskId) return { sessionId: id, session }
    }
    return undefined
  }

  hasActiveSessionForTask(taskId: string): boolean {
    return [...this.sessions.values()].some((s) => s.taskId === taskId && s.status === 'working')
  }

  /** Wakes an idle parent coordinator after a subtask finished (see ParentWakeups.notify). */
  notifyParentOfSubtaskCompletion(parentTaskId: string, subtaskId: string): Promise<void> {
    return this.parentWakeups.notify(parentTaskId, subtaskId)
  }

  /**
   * Snapshot of the durable transcript projection for a task. Clients render
   * from this instead of relying on having observed every live event.
   */
  getTranscriptSnapshot(taskId: string, sinceSeq?: number): Promise<ReturnType<DatabaseManager['getTranscriptParts']>> {
    return this.projection.snapshot(taskId, sinceSeq)
  }

  /** Parts changed since `sinceRev`, plus the current maxRev. */
  getTranscriptDelta(taskId: string, sinceRev: number): Promise<ReturnType<DatabaseManager['getTranscriptDelta']>> {
    return this.projection.delta(taskId, sinceRev)
  }

  /** Used by HeartbeatScheduler to read the heartbeat result. */
  getLastAssistantMessage(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session?.adapter) return null
    return session.lastAssistantText ?? null
  }

  /** Full message list of the task's live session; null when there is none. */
  private async getLiveMessages(taskId: string): Promise<SessionMessage[] | null> {
    const session = this.findSessionByTaskId(taskId)?.session
    if (!session?.adapter?.getAllMessages) return null
    return session.adapter.getAllMessages(session.id, this.sessionConfigFor(session))
  }

  /** Raw transcript for the renderer's hidden "Copy Debug Info" feature. */
  async getRawTranscriptForDebug(taskId: string): Promise<DebugTranscriptMessage[]> {
    try {
      return debugTranscript(await this.getLiveMessages(taskId) ?? [])
    } catch (err) {
      console.error(`[AgentManager] Failed to get raw transcript for task ${taskId}:`, err)
      return []
    }
  }

  /** Text-only transcript served to subtask MCP agents for sibling coordination. */
  async getTranscriptForTask(taskId: string): Promise<Array<{ role: string; text: string }>> {
    try {
      return textTranscript(await this.getLiveMessages(taskId) ?? [])
    } catch (err) {
      console.error(`[AgentManager] Failed to get transcript for task ${taskId}:`, err)
      return []
    }
  }

  /**
   * Reconnects to an existing session by its persisted session ID and resumes
   * it idle (history is not replayed; clients render the durable projection).
   */
  async resumeSession(agentId: string, taskId: string, sessionId: string): Promise<string> {
    console.log('[AgentManager] resumeSession called:', { agentId, taskId, sessionId })
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const adapter = this.getAdapter(agentId)
    if (!adapter) {
      throw new Error(`No adapter available for agent ${agentId}`)
    }

    return this.resumeAdapterSession(adapter, agentId, taskId, sessionId)
  }

  /**
   * Local agents help a human owner; only that human can accept completion.
   * Agent-owned work completes through agent-harness, so this never does.
   */
  async completeTaskWithoutReview(_taskId: string, _knownTask?: TaskRecord): Promise<boolean> {
    return false
  }

  /** Interrupts the current generation and stops polling; keeps the transcript and task status. */
  async abortSession(sessionId: string): Promise<void> {
    const resolved = this.resolveSession(sessionId, 'abortSession')
    if (!resolved) return
    const { session } = resolved
    sessionId = resolved.sessionId

    console.log(`[AgentManager] Aborting session ${sessionId}`)
    this.poller.stop(sessionId)

    const adapter = this.getAdapter(session.agentId)
    if (adapter) {
      try {
        const sessionConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
        await adapter.abortPrompt(sessionId, sessionConfig)
      } catch (error) {
        console.error(`[AgentManager] Error aborting adapter session:`, error)
      }
    }

    session.status = 'idle'
    this.emitStatus(sessionId, session, 'idle')
  }

  /**
   * Releases the backend session behind a tracked session, without touching task
   * status or renderer state.
   *
   * Dropping a session from `this.sessions` is not enough: the backend session
   * owns the agent CLI process and its MCP stdio children, and after the drop no
   * handle to them is left, so they run until the app quits. Callers that finish
   * a session on their own terms (triage, learning) use this to release it.
   */
  private async releaseAdapterSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.poller.stop(sessionId)
    const adapter = session.adapter ?? this.getAdapter(session.agentId)
    if (!adapter) return
    try {
      const sessionConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
      await adapter.destroySession(sessionId, sessionConfig)
      console.log(`[AgentManager] Released backend session ${sessionId} (${reason})`)
    } catch (error) {
      console.error(`[AgentManager] Error releasing backend session ${sessionId} (${reason}):`, error)
    }
  }

  /** Destroys the session. `resetTaskStatus` puts the task back to not_started (a user stop). */
  async stopSession(sessionId: string, resetTaskStatus: boolean = true): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.log(`[AgentManager] Session ${sessionId} not found`)
      return
    }

    console.log(`[AgentManager] Destroying session ${sessionId} (resetTaskStatus=${resetTaskStatus})`)

    this.poller.stop(sessionId)

    const adapter = this.getAdapter(session.agentId)
    if (adapter) {
      try {
        const sessionConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
        await adapter.destroySession(sessionId, sessionConfig)
      } catch (error) {
        console.error(`[AgentManager] Error destroying adapter session:`, error)
      }
    }

    if (session.secretSessionToken) {
      unregisterSecretSession(session.secretSessionToken)
      console.log(`[AgentManager] Unregistered secret session for ${sessionId}`)
    }

    // Freed now rather than whenever the session object is collected.
    session.seenMessageIds.clear()
    session.seenPartIds.clear()
    session.partContentLengths.clear()

    this.sessions.delete(sessionId)
    this.lastSentStatus.delete(sessionId)
    this.lifetime.scheduleBlockerUpdate()
    console.log(`[SessionTracker] DESTROYED session=${sessionId} task=${session.taskId} resetStatus=${resetTaskStatus} reason=stop_session`)

    for (const [oldId, newId] of this.sessionIdRedirects.entries()) {
      if (newId === sessionId) this.sessionIdRedirects.delete(oldId)
    }

    // Reset only on an explicit user stop (not app shutdown), and never a Completed task.
    if (resetTaskStatus) {
      const task = this.db.getTask(session.taskId)
      if (task?.status !== TaskStatus.Completed) {
        this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.NotStarted })
      }
    }

    this.emitStatus(sessionId, session, 'idle')
  }

  /** Stops the task's session, and withdraws a start still waiting for a slot. */
  async stopByTaskId(taskId: string): Promise<{ sessionId: string | null }> {
    this.cancelQueuedStart(taskId)
    const found = this.findSessionByTaskId(taskId)
    if (!found) {
      console.log(`[AgentManager] stopByTaskId: no active session found for task ${taskId}`)
      return { sessionId: null }
    }
    console.log(`[AgentManager] stopByTaskId: found session ${found.sessionId} for task ${taskId}, stopping`)
    await this.stopSession(found.sessionId)
    return { sessionId: found.sessionId }
  }

  /** Starts waiting for a free slot, in queue order. */
  getStartQueue(): QueuedStartInfo[] {
    return this.admission.list()
  }

  /** Withdraws a queued start; true when one was waiting. */
  cancelQueuedStart(taskId: string): boolean {
    return this.admission.cancel(taskId)
  }

  /**
   * Stops new starts in every project (or lifts that). Running sessions are
   * untouched; lifting the pause drains the queue. For the Commander (#61)
   * and the project editor.
   */
  pauseAllProjects(paused: boolean): void {
    setAllProjectsPaused(this.db, paused)
    console.log(`[AgentManager] All projects ${paused ? 'paused' : 'unpaused'}`)
    if (!paused) this.admission.scheduleDrain()
  }

  isAllProjectsPaused(): boolean {
    return isAllProjectsPaused(this.db)
  }

  /**
   * Re-checks the queue after something outside a session changed the limits
   * (a project's settings were saved). Idle sweeps do the same as a safety net.
   */
  recheckStartQueue(): void {
    this.admission.scheduleDrain()
  }

  /** The project's limits, what they count right now and what is waiting (#65). */
  getProjectLimitState(projectId: string): ProjectLimitState {
    return this.admission.projectLimitState(projectId)
  }

  /** Starts every queued entry that now fits (see SessionAdmission.drain). */
  drainStartQueue(): void {
    this.admission.drain()
  }

  /** Sends to the task's live session, or lets sendMessage resume or create one. */
  async sendByTaskId(
    taskId: string,
    message: string,
    attachments?: MessageAttachmentRef[]
  ): Promise<{ sessionId: string | null; newSessionId?: string }> {
    const found = this.findSessionByTaskId(taskId)
    if (found) {
      console.log(`[AgentManager] sendByTaskId: found live session ${found.sessionId} for task ${taskId}`)
      const result = await this.sendMessage(found.sessionId, message, taskId, found.session.agentId, attachments)
      return { sessionId: found.sessionId, ...result }
    }
    console.log(`[AgentManager] sendByTaskId: no live session for task ${taskId}, delegating to sendMessage for recovery`)
    const result = await this.sendMessage('', message, taskId, undefined, attachments)
    return { sessionId: null, ...result }
  }

  async sendMessage(
    sessionId: string,
    message: string,
    taskId?: string,
    agentId?: string,
    attachments?: MessageAttachmentRef[]
  ): Promise<{ newSessionId?: string }> {
    const resolved = this.resolveSession(sessionId, 'sendMessage')
    let session = resolved?.session
    if (resolved) sessionId = resolved.sessionId

    // Session gone from memory: RESUME first (keeps the conversation), else start a new one.
    if (!session && taskId) {
      // Regular tasks carry their agent; the Captain (a coordinator row
      // with no agent_id) passes it in.
      const task = this.db.getTask(taskId)
      const resolvedAgentId = task?.agent_id || agentId

      if (resolvedAgentId) {
        const persistedSessionId = task?.session_id
        if (persistedSessionId) {
          try {
            console.log(`[AgentManager] Session ${sessionId} not found, attempting resume from ${persistedSessionId} for task ${taskId}`)
            console.log(`[SessionTracker] RESUME_ATTEMPT old=${sessionId} persisted=${persistedSessionId} task=${taskId} reason=session_not_in_memory`)
            const adapter = this.getAdapter(resolvedAgentId)
            if (adapter) {
              const resumedId = await this.resumeAdapterSession(adapter, resolvedAgentId, taskId, persistedSessionId)
              session = this.sessions.get(resumedId)
              if (session) {
                sessionId = resumedId
              }
            }
          } catch (error) {
            // An active writer means the conversation still exists. Starting a
            // replacement here would silently discard its context and overwrite
            // the persisted resume anchor.
            const resumeError = error instanceof Error ? error.message : String(error)
            if (resumeError.includes('already has an active writer') || resumeError.includes('thread-store conflict')) {
              throw new Error(`Cannot resume this conversation because its runtime is still active. The existing session has been preserved. Retry after the runtime has released it. ${resumeError}`)
            }
            console.warn(`[AgentManager] Resume failed, will create new session:`, error)
          }
        }

        if (!session) {
          console.log(`[AgentManager] Creating new session for task ${taskId}`)
          // A direct message continues existing work; it is not held back by
          // the concurrency limits.
          const newSessionId = await this.startSessionNow(resolvedAgentId, taskId, undefined, true)
          session = this.sessions.get(newSessionId)
          if (!session) throw new Error('Failed to restart session')
          sessionId = newSessionId
          console.log(`[SessionTracker] CREATED_FALLBACK session=${newSessionId} task=${taskId} reason=resume_failed_or_no_persisted_session`)
        }

        this.sendInBackground(session, sessionId, message, attachments)
        return { newSessionId: sessionId }
      }
    }

    if (!session) throw new Error(`Session not found: ${sessionId}`)
    this.sendInBackground(session, sessionId, message, attachments)
    return {}
  }

  /** Fire-and-forget, so the IPC response is not blocked and the renderer does not freeze. */
  private sendInBackground(session: AgentSession, sessionId: string, message: string, attachments?: MessageAttachmentRef[]): void {
    this.doSendAdapterMessage(session, sessionId, message, attachments).catch((err) => {
      console.error(`[AgentManager] doSendAdapterMessage failed for session ${sessionId}:`, err)
      return this.handleSessionError(sessionId, session, err)
    })
  }

  /**
   * Shows why a background send failed, so the user can fix it and retry with
   * "continue". The session stays recoverable: the next send clears the error.
   */
  private async handleSessionError(sessionId: string, session: AgentSession, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[AgentManager] Session ${sessionId} error:`, message)
    if (findCreditExhaustionMessage([message]) && await this.tryAutomaticFallback(sessionId, session, message)) {
      return
    }
    session.status = 'error'
    this.emitSystemError(
      sessionId,
      session.taskId,
      `send-error-${Date.now()}`,
      `Could not send the message: ${message}\n\nThe session is still here — fix the issue and retry with "continue".`
    )
    this.emitStatus(sessionId, session, 'error')
  }

  private async doSendAdapterMessage(
    session: AgentSession,
    sessionId: string,
    message: string,
    attachments?: MessageAttachmentRef[]
  ): Promise<void> {
    session.autoAbortNotified = false

    if (session.status === 'error') {
      // An incompatible session is not recoverable; other errors (e.g. rate limits) are.
      if (session.adapter) {
        const adapterStatus = await session.adapter.getStatus(sessionId, {} as SessionConfig)
        if (adapterStatus.message?.includes('INCOMPATIBLE_SESSION_ID')) {
          throw new Error('Session is in error state: incompatible session')
        }
      }
      console.log(`[AgentManager] Clearing error state for session ${sessionId} to allow recovery`)
      session.status = 'working'
      session.pollingStarted = false
    }
    if (!session.adapter) throw new Error('Adapter not initialized')
    // Attachments added mid-session must be referenceable immediately.
    if (session.workspaceDir) {
      syncAttachmentsToWorkspace(this.db, session.taskId, session.workspaceDir)
    }

    // AgentLearning is preserved.
    session.status = 'working'
    session.lastActivityAt = Date.now()
    const currentTask = this.db.getTask(session.taskId)
    if (currentTask?.status !== TaskStatus.AgentLearning) {
      this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.AgentWorking })
    }
    this.emitStatus(sessionId, session, 'working')

    this.sendToRenderer('agent:output', {
      sessionId,
      taskId: session.taskId,
      type: 'message',
      data: {
        id: `user-message-${Date.now()}`,
        role: 'user',
        content: buildDisplayMessage(message, attachments),
        partType: 'text'
      }
    })

    const sessionConfig = await this.buildSessionConfig(
      session.agentId,
      session.taskId,
      session.workspaceDir || process.cwd()
    )

    const promptText = buildMessageWithAttachmentContext(session.workspaceDir, message, attachments)
    await session.adapter.sendPrompt(sessionId, [{ type: MessagePartType.TEXT, text: promptText }], sessionConfig)

    if (!session.pollingStarted) {
      console.log(`[AgentManager] Starting polling for session ${sessionId} (preserving dedup state)`)
      session.pollingStarted = true
      // Passing the session keeps its dedup state, so old messages are not re-sent.
      this.poller.start(sessionId, session.adapter, sessionConfig, session)
    }
  }

  async respondToPermission(
    sessionId: string,
    approved: boolean,
    message?: string,
    optionId?: string,
    responseType?: 'permission' | 'question',
    requestId?: string
  ): Promise<void> {
    const resolved = this.resolveSession(sessionId, 'respondToPermission')
    if (!resolved) throw new Error(`Session not found: ${sessionId}`)
    const { session } = resolved
    await respondToPermission(this.host, this.poller, resolved.sessionId, session, this.getAdapter(session.agentId), {
      approved, message, optionId, responseType, requestId
    })
  }

  async stopAllSessions(): Promise<void> {
    console.log(`[AgentManager] Stopping all ${this.sessions.size} sessions`)
    this.admission.clear()
    this.poller.stopAll()
    this.lifetime.stopReaper()
    await Promise.allSettled(
      // Shutdown preserves task status.
      [...this.sessions.keys()].map((sessionId) => this.stopSession(sessionId, false))
    )
  }

  getSessionStatus(sessionId: string): { status: string; agentId: string; taskId: string } | null {
    const session = this.resolveSession(sessionId)?.session
    if (!session) return null
    return { status: session.status, agentId: session.agentId, taskId: session.taskId }
  }

  getActiveSessionsForTask(taskId: string): string[] {
    return [...this.sessions.entries()]
      .filter(([, session]) => session.taskId === taskId && session.status !== 'error')
      .map(([sessionId]) => sessionId)
  }

  async getProviders(serverUrl?: string, directory?: string, backendType?: string): Promise<{ providers: { id: string; name: string; [key: string]: unknown }[]; default: Record<string, string> } | null> {
    try {
      const defaultAgent = this.defaultAgent()
      const baseUrl = serverUrl || defaultAgent?.server_url || DEFAULT_SERVER_URL
      const resolvedBackend = backendType || getAgentProvider(defaultAgent)

      // Only OpenCode and Pi expose configurable providers/models.
      if (resolvedBackend !== CodingAgentType.OPENCODE && resolvedBackend !== CodingAgentType.PI) {
        console.log(`[AgentManager] Backend "${resolvedBackend}" does not support provider listing, skipping`)
        return null
      }

      const adapter = this.getAdapterByType(resolvedBackend)
      if (!adapter?.getProviders) {
        console.log(`[AgentManager] Adapter for "${resolvedBackend}" does not support getProviders`)
        return null
      }

      // Pushing config can disturb running sessions, which is acceptable here:
      // this is user-initiated from settings. Failures are logged by the adapter.
      await adapter.notifyConfigChanged?.().catch(() => undefined)

      return await adapter.getProviders(baseUrl, directory)
    } catch (error: unknown) {
      console.log('[AgentManager] Could not get providers:', error instanceof Error ? error.message : error)
      return null
    }
  }

  private defaultAgent(): AgentRecord | undefined {
    const agents = this.db.getAgents()
    return agents.find((agent) => agent.is_default) || agents[0]
  }

  syncSkillsFromWorkspace(sessionId: string): SkillSyncResult {
    const session = this.sessions.get(sessionId)
    if (!session?.workspaceDir) {
      console.log(`[AgentManager] syncSkillsFromWorkspace: no session or workspaceDir for ${sessionId} (sessions count: ${this.sessions.size})`)
      return emptySkillSyncResult()
    }
    // #74: what the session learned belongs to its task's project.
    const projectId = session.taskId ? this.db.getTask(session.taskId)?.project_id ?? null : null
    return syncSkillsFromDirectory(this.db, session.workspaceDir, { projectId })
  }

  /** Receives every event sent to clients; the mobile API server relays them over its WebSocket. */
  addExternalListener(fn: (channel: string, data: unknown) => void): void {
    this.projection.addExternalListener(fn)
  }

  private sendToRenderer(channel: string, data: unknown): void {
    // Transcript output is written to the durable projection, which pushes it
    // to every client as `transcript:changed`. Clients do not listen to the
    // raw output events, so they are not broadcast.
    if (channel === 'agent:output' || channel === 'agent:output-batch') {
      try {
        this.projection.persist(channel, data)
      } catch (err) {
        console.error('[AgentManager] Failed to persist transcript parts:', err)
      }
      return
    }

    this.projection.broadcast(channel, data)

    if (channel === 'agent:status' && data && typeof data === 'object') {
      const { sessionId, status, taskId } = data as { sessionId?: string; status?: string; taskId?: string }
      if (sessionId && status) {
        const prevStatus = this.lastSentStatus.get(sessionId)
        this.lastSentStatus.set(sessionId, status)
        notifyStatusTransition(this.db, () => this.mainWindow, prevStatus, status, taskId)
      }
    }
  }
}
