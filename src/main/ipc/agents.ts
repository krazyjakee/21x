import { guardedIpcSend } from '../guarded-ipc-send'
import { MAX_IPC_REPLY_BYTES, MAX_IPC_REPLY_VALUES, measureIpcMessage } from '../ipc-message-size'
import { transcriptDisplayPart } from '../transcript-display'
import { ipcMain } from 'electron'
import type { CreateAgentData, UpdateAgentData } from '../database'
import type { IpcDeps } from './deps'

type MessageAttachment = { id: string; filename: string; size: number; mime_type: string }

export function registerAgentHandlers({ db, agentManager }: IpcDeps): void {
  ipcMain.handle('agent:getAll', () => db.getAgents())
  ipcMain.handle('agent:create', (_, data: CreateAgentData) => db.createAgent(data))
  ipcMain.handle('agent:update', (_, id: string, data: UpdateAgentData) => db.updateAgent(id, data))
  ipcMain.handle('agent:delete', (_, id: string) => db.deleteAgent(id))

  ipcMain.handle('agentSession:start', async (_, agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean) => {
    const sessionId = await agentManager.startSession(agentId, taskId, workspaceDir, skipInitialPrompt)
    return { sessionId }
  })

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

  ipcMain.handle('agentSession:sendByTaskId', async (_, taskId: string, message: string, attachments?: MessageAttachment[]) => {
    const result = await agentManager.sendByTaskId(taskId, message, attachments)
    return { success: true, ...result }
  })

  ipcMain.handle(
    'agentSession:send',
    async (_, sessionId: string, message: string, taskId?: string, agentId?: string, attachments?: MessageAttachment[]) => {
      const result = await agentManager.sendMessage(sessionId, message, taskId, agentId, attachments)
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
    return agentManager.getProviders(serverUrl, undefined, backendType)
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
