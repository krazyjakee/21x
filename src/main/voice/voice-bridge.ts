import type { BrowserWindow } from 'electron'
import type { AgentManager } from '../agent-manager'
import type { DatabaseManager, TranscriptPartRecord } from '../database'
import { guardedIpcSend } from '../guarded-ipc-send'
import { broadcastToMobileClients } from '../mobile-api-server'
import { assistantTextParts, sinceLastUserMessage } from './voice-answer-parts'
import type { VoiceSessionManager } from './voice-session-manager'

/**
 * The two ways voice events leave the main process.
 *
 * `notify` reaches the desktop renderer and the mobile clients: voice actions
 * reuse the normal task and agent events, so both clients stay in step without
 * a second state writer (design §5.11).
 *
 * `notifyRenderer` reaches the desktop window only. Spoken answers use it: the
 * audio is produced on this computer and played by this window; a phone cannot
 * play a raw sample stream from the local WebSocket, and sending it would push
 * megabytes of samples through a text channel for nothing.
 */
export function voiceEventSenders(getWindow: () => BrowserWindow | null): {
  notify: (channel: string, data: unknown) => void
  notifyRenderer: (channel: string, data: unknown) => void
} {
  const notifyRenderer = (channel: string, data: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) guardedIpcSend(win.webContents, channel, data)
  }
  return {
    notify: (channel, data) => {
      notifyRenderer(channel, data)
      broadcastToMobileClients(channel, data)
    },
    notifyRenderer
  }
}

/**
 * Reads an agent answer aloud as it is written (design §5.7).
 *
 * The answer arrives a few words at a time. Waiting for the agent to stop
 * before saying the first word would put the whole spoken answer behind the
 * agent — on a long answer, minutes behind — so the transcript is followed as
 * it changes and every finished sentence is read straight away.
 *
 * The `working -> idle` edge then closes the passage, and it is also the
 * fallback: an answer that produced no transcript event this session is read in
 * one piece from what was stored.
 *
 * This listener never decides to speak. It hands the passage to the speech
 * service, which speaks it only when the user asked for it by voice.
 */
export function watchAgentAnswersForSpeech(agents: AgentManager, database: DatabaseManager, voice: VoiceSessionManager): void {
  const lastStatus = new Map<string, string>()
  /** Tasks whose newest assistant text is being streamed to the speech service. */
  const writing = new Set<string>()

  agents.addExternalListener((channel, data) => {
    try {
      if (channel === 'transcript:changed') {
        const event = data as { taskId?: string; parts?: TranscriptPartRecord[] }
        if (!event?.taskId || !event.parts?.length) return
        // Every message that changed, in order. A turn can hold several: the
        // agent says something, uses a tool, and says something else. Taking
        // only the newest skipped the first message entirely whenever both
        // landed in one flush.
        const parts = assistantTextParts(event.parts)
        if (parts.length === 0) return
        writing.add(event.taskId)
        void voice
          .streamAgentAnswer(event.taskId, parts)
          .catch((err) => console.error('[voice] reading the answer failed:', err))
        return
      }

      if (channel !== 'agent:status') return
      const event = data as { sessionId?: string; taskId?: string; status?: string }
      if (!event?.sessionId || !event.taskId || !event.status) return
      const taskId = event.taskId

      const previous = lastStatus.get(event.sessionId)
      if (event.status === 'idle') lastStatus.delete(event.sessionId)
      else lastStatus.set(event.sessionId, event.status)
      if (event.status !== 'idle' || previous !== 'working') return

      const open = writing.delete(taskId)

      // With voice switched off no turn can be listening, so nothing will be
      // spoken unless a passage for this task is already playing. Skip reading
      // the transcript; only drop the stale expectation, as speakAgentAnswer would.
      if (!voice.isEnabled() && voice.speech.streamingTaskId !== taskId) {
        if (!open) voice.speech.forgetAnswer(taskId)
        return
      }

      // Close the passage with the last words, which may have arrived after
      // the final transcript event. Only this turn's messages are considered:
      // everything the agent wrote since the user last spoke.
      const all = assistantTextParts(sinceLastUserMessage(database.getTranscriptParts(taskId)))
      // Whatever the user talked over is left out here too. Otherwise the
      // one-piece fallback below reads the whole interrupted answer at the
      // moment the agent stops.
      const parts = voice.audibleAnswerParts(taskId, all)
      if (parts.length > 0 && voice.finishAgentAnswer(taskId, parts)) return

      // Nothing was read as it was written — no transcript event reached us —
      // so the answer is read in one piece instead, every message of it.
      if (open) return
      const text = parts.map((part) => part.content).join('\n\n')
      if (!text.trim()) return
      void voice.speakAgentAnswer(taskId, text).catch((err) => {
        console.error('[voice] speaking the answer failed:', err)
      })
    } catch (err) {
      // Speech must never disturb the agent stream.
      console.error('[voice] reading the answer failed:', err)
    }
  })
}
