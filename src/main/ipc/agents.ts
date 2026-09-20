import { takeUserTypedMessage } from './merge-grants'
import { guardedIpcSend } from '../guarded-ipc-send'
import { MAX_IPC_REPLY_BYTES, MAX_IPC_REPLY_VALUES, measureIpcMessage } from '../ipc-message-size'
import { transcriptDisplayPart } from '../transcript-display'
import { ipcMain } from 'electron'
import type { CreateAgentData, UpdateAgentData } from '../database'
import type { IpcDeps } from './deps'
import { flattenProviderModels, rememberBackendModels } from '../agent-manager/skill-model'

type MessageAttachment = { id: string; filename: string; size: number; mime_type: string }

export function registerAgentHandlers({ db, agentManager }: IpcDeps): void {
  ipcMain.handle('agent:getAll', () => db.getAgents())
  ipcMain.handle('agent:create', (_, data: CreateAgentData) => db.createAgent(data))
  ipcMain.handle('agent:update', (_, id: string, data: UpdateAgentData) => {
    const updated = db.updateAgent(id, data)
    // A raised max_parallel_sessions frees slots now, not at the next idle.
    agentManager.drainStartQueue()
    return updated
  })
  ipcMain.handle('agent:delete', (_, id: string) => db.deleteAgent(id))

  // A deferred start is committed to the durable queue before this reply;
  // empty sessionId means there is no live session yet.
  ipcMain.handle('agentSession:start', async (_, agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean) => {
    const outcome = await agentManager.requestSession(agentId, taskId, workspaceDir, skipInitialPrompt)
    if (outcome.status === 'queued') return { sessionId: '', queued: true, queuePosition: outcome.position, queueReason: outcome.reason }
    return { sessionId: outcome.sessionId }
  })

  // High-level task start used by surfaces such as the dashboard board. This
  // preserves the same triage, subtask and admission-control rules as voice,
  // mobile and automation instead of duplicating them in the renderer.
  ipcMain.handle('agentSession:startTask', async (_, taskId: string) => {
    return agentManager.startTask(taskId, { resumeManualStop: true })
  })

  ipcMain.handle('agent:getStartQueue', () => agentManager.getStartQueue())
  ipcMain.handle('agent:getStartRecoveryState', (_, taskId: string) => agentManager.getStartRecoveryState(taskId))

  ipcMain.handle('agentSession:resume', async (_, agentId: string, taskId: string, ocSessionId: string) => {
    const sessionId = await agentManager.resumeSession(agentId, taskId, ocSessionId)
    // No session means it ended normally (task completed/reviewed) and its
    // session_id is already cleared; the renderer cleans up without an error.
    if (!sessionId) return { sessionId: '', ended: true }
    return { sessionId }
  })

  ipcMain.handle('agentSession:abort', async (_, sessionId: string) => {
    await agentManager.abortSession(sessionId)
    return { success: true }
  })

  ipcMain.handle('agentSession:stop', async (_, sessionId: string) => {
    await agentManager.stopSession(sessionId)
    return { success: true }
  })

  ipcMain.handle('agentSession:stopByTaskId', async (_, taskId: string) => {
    const result = await agentManager.stopByTaskId(taskId)
    return { success: true, sessionId: result.sessionId }
  })

  ipcMain.handle('agentSession:switchAgent', async (_, taskId: string, newAgentId: string) => {
    const sessionId = await agentManager.switchAgent(taskId, newAgentId)
    return { sessionId }
  })

  ipcMain.handle('captainRuntime:get', (_, projectId: string) => agentManager.getCaptainRuntime(projectId))
  ipcMain.handle('captainRuntime:switch', async (_, projectId: string, agentId: string) =>
    agentManager.switchCaptainAgent(projectId, agentId))
  ipcMain.handle('captainRuntime:retry', async (_, projectId: string) =>
    agentManager.retryCaptainSwitch(projectId))
  ipcMain.handle('captainRuntime:rollback', (_, projectId: string) =>
    agentManager.rollbackCaptainSwitch(projectId))

  ipcMain.handle('agentSession:sendByTaskId', async (event, taskId: string, message: string, attachments?: MessageAttachment[], deliveryId?: string) => {
    const result = await agentManager.sendByTaskId(
      taskId,
      message,
      attachments,
      takeUserTypedMessage(event, taskId, message),
      deliveryId
    )
    return { success: true, ...result }
  })

  ipcMain.handle(
    'agentSession:send',
    async (event, sessionId: string, message: string, taskId?: string, agentId?: string, attachments?: MessageAttachment[], deliveryId?: string) => {
      const result = await agentManager.sendMessage(
        sessionId,
        message,
        taskId,
        agentId,
        attachments,
        takeUserTypedMessage(event, taskId, message),
        deliveryId
      )
      return { success: true, ...result }
    }
  )

  ipcMain.handle('agentSession:approve', async (_, sessionId: string, approved: boolean, message?: string, responseType?: 'permission' | 'question', requestId?: string) => {
    await agentManager.respondToPermission(sessionId, approved, message, undefined, responseType, requestId)
    return { success: true }
  })

  ipcMain.handle('agentSession:getRawTranscript', async (_, taskId: string) => {
    const result = await agentManager.getRawTranscriptForDebug(taskId)
    if (measureIpcMessage(result, MAX_IPC_REPLY_BYTES, MAX_IPC_REPLY_VALUES).reason) throw new Error('Transcript is too large to copy.')
    return result
  })

  // Durable transcript snapshot: the renderer hydrates transcript state from
  // the main-process projection instead of depending on catching live events.
  // Oversized individual records are replaced by display previews (stored data
  // is unchanged) so a single huge tool output cannot overflow the serializer.
  ipcMain.handle('agentSession:getTranscriptSnapshot', async (_, taskId: string, sinceSeq?: number) => {
    const parts = (await agentManager.getTranscriptSnapshot(taskId, sinceSeq)).map(part => transcriptDisplayPart(part))
    if (measureIpcMessage(parts, MAX_IPC_REPLY_BYTES, MAX_IPC_REPLY_VALUES).reason) throw new Error('Transcript is too large to display')
    return parts
  })

  // Event-sourced projection: delta since a rev cursor (parts changed since then).
  ipcMain.handle('agentSession:getTranscriptDelta', async (_, taskId: string, sinceRev: number) => {
    const { parts, maxRev } = await agentManager.getTranscriptDelta(taskId, sinceRev)
    const result = { parts: parts.map(part => transcriptDisplayPart(part)), maxRev }
    if (measureIpcMessage(result, MAX_IPC_REPLY_BYTES, MAX_IPC_REPLY_VALUES).reason) throw new Error('Transcript delta is too large to display')
    return result
  })

  ipcMain.handle('agentConfig:getProviders', async (_, serverUrl?: string, backendType?: string) => {
    const result = await agentManager.getProviders(serverUrl, undefined, backendType)
    // Lets session setup validate skill preferred models against this listing.
    if (backendType) rememberBackendModels(backendType, flattenProviderModels(result))
    return result
  })

  ipcMain.handle('agent-installer:detect', async () => {
    const { detectInstalledAgents } = await import('../agent-installer/detect.js')
    return detectInstalledAgents()
  })

  ipcMain.handle('agent-installer:install', async (event, { agentName }: { agentName: string }) => {
    const { installAgent } = await import('../agent-installer/install.js')
    return installAgent(agentName, (progress: { stage: string; output: string; percent: number }) => {
      guardedIpcSend(event.sender, 'agent-installer:progress', { agentName, ...progress })
    })
  })
}
