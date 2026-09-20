import { ipcMain, dialog } from 'electron'
import { VOICE_TTS_ELEVENLABS_EMPTY_STATE, isVoiceTtsEngineId } from '../../shared/voice-tts'
import { CommanderVoice } from '../voice/commander-voice'
import { assertTrustedSender } from '../ipc-sender'
import type { VoiceSessionManager } from '../voice/voice-session-manager'
import { getCommanderService } from './commander'
import type { IpcDeps } from './deps'

// The renderer only captures audio and draws state. Every decision — turn
// identity, intent validation, target resolution, confirmation policy and
// execution — stays in VoiceSessionManager (design §5.1).

const UNAVAILABLE = 'Voice control is not available in this build.'
const VOICE_TURN_MODES = ['dictation', 'command', 'conversation'] as const
type VoiceTurnModeName = (typeof VOICE_TURN_MODES)[number]

export function registerVoiceHandlers({ voiceSessionManager, db }: IpcDeps): void {
  const requireVoice = (): VoiceSessionManager => {
    if (!voiceSessionManager) throw new Error(UNAVAILABLE)
    return voiceSessionManager
  }
  const speech = (): VoiceSessionManager['speech'] => requireVoice().speech

  // Commander voice mode (#64). Built on first use: the Commander handlers
  // register after this file, so the service does not exist yet here.
  let commanderVoice: CommanderVoice | null = null
  const requireCommanderVoice = (): CommanderVoice => {
    if (commanderVoice) return commanderVoice
    const commander = getCommanderService()
    if (!commander) throw new Error('The Commander is not available.')
    commanderVoice = new CommanderVoice({
      commander,
      speech: speech(),
      resolveProjectName: (projectId) => db.getProject(projectId)?.name
    })
    return commanderVoice
  }

  ipcMain.handle('voice:getSnapshot', async () => {
    if (!voiceSessionManager) {
      return {
        enabled: false,
        engine: { state: 'engine_missing', message: UNAVAILABLE },
        models: [],
        shortcut: '',
        runtime: { installed: false, version: null, modulePath: null, sizeBytes: 0 },
        state: 'disabled',
        turnId: null,
        partial: '',
        final: ''
      }
    }
    return voiceSessionManager.snapshot()
  })

  ipcMain.handle('voice:setEnabled', async (_, payload: { enabled: boolean }) => requireVoice().setEnabled(Boolean(payload?.enabled)))

  ipcMain.handle('voice:getPermission', () => ({ status: voiceSessionManager?.getMicrophonePermission() ?? 'unsupported' }))

  ipcMain.handle('voice:requestPermission', async () => ({ status: await requireVoice().requestMicrophonePermission() }))

  ipcMain.handle('voice:startTurn', async (_, payload: { mode?: string; context?: Record<string, unknown> }) => {
    // Validate against the whole set. Coercing an unknown value to 'dictation'
    // silently threw away 'conversation', which ended the loop after the first
    // sentence instead of keeping the microphone open.
    const mode = VOICE_TURN_MODES.includes(payload?.mode as VoiceTurnModeName)
      ? (payload.mode as VoiceTurnModeName)
      : 'dictation'
    return requireVoice().startTurn(mode, (payload?.context ?? {}) as Parameters<VoiceSessionManager['startTurn']>[1])
  })

  // Audio arrives as raw 16-bit PCM in a Uint8Array, never as base64. The
  // renderer batches about 100 ms per call, so a spoken turn costs ~10 IPC
  // messages per second instead of one per 20 ms frame.
  ipcMain.handle('voice:pushAudio', (_, payload: { turnId: string; chunk: Uint8Array }) => {
    if (!voiceSessionManager || !payload?.turnId || !payload.chunk) return
    voiceSessionManager.pushAudio(payload.turnId, Buffer.from(payload.chunk))
  })

  ipcMain.handle('voice:endTurn', (_, payload: { turnId: string }) => {
    voiceSessionManager?.endTurn(payload?.turnId)
  })

  ipcMain.handle('voice:cancelTurn', (_, payload: { turnId?: string; turnEpoch?: string }) => {
    voiceSessionManager?.cancelTurn(payload?.turnId, payload?.turnEpoch)
  })

  ipcMain.handle('voice:confirm', async (_, payload: { turnId: string; turnEpoch?: string; choice?: { taskId?: string; agentName?: string } }) => {
    await requireVoice().confirm(payload.turnId, payload?.choice, payload?.turnEpoch)
    return { success: true }
  })

  ipcMain.handle('voice:dismiss', (_, payload: { turnId: string; turnEpoch?: string }) => {
    voiceSessionManager?.dismiss(payload?.turnId, payload?.turnEpoch)
  })

  // The local speech runtime is an optional install (see docs/voice.md). Until
  // it is present, the renderer hides every voice control.
  ipcMain.handle('voice:getRuntime', async () => {
    if (!voiceSessionManager) return { installed: false, version: null, modulePath: null, sizeBytes: 0 }
    return voiceSessionManager.refreshRuntime()
  })

  ipcMain.handle('voice:installRuntime', async () => requireVoice().installRuntime())

  ipcMain.handle('voice:removeRuntime', async () => requireVoice().removeRuntime())

  ipcMain.handle('voice:installModel', async (_, payload: { id: string }) => requireVoice().installModel(payload.id))

  ipcMain.handle('voice:removeModel', async (_, payload: { id: string }) => requireVoice().removeModel(payload.id))

  ipcMain.handle('voice:selectModel', async (_, payload: { id: string }) => requireVoice().selectModel(payload.id))

  ipcMain.handle('voice:removeAllModels', async () => {
    await requireVoice().removeAllModels()
    return { success: true }
  })

  ipcMain.handle('voice:setCustomModelDir', async (_, payload: { dir: string }) => requireVoice().setCustomModelDir(payload?.dir ?? ''))

  ipcMain.handle('voice:pickModelDir', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return { dir: null }
    return { dir: result.filePaths[0] }
  })

  ipcMain.handle('voice:setEndpointSilence', async (_, payload: { seconds: number }) => {
    await requireVoice().setEndpointSilence(Number(payload?.seconds) || 1.2)
    return { success: true }
  })

  ipcMain.handle('voice:setShortcut', async (_, payload: { accelerator: string }) => requireVoice().setShortcut(payload?.accelerator ?? ''))

  // Spoken answers (design §5.7).
  // Speech is produced in a worker and played by the renderer. Main decides
  // what may be spoken; the renderer only plays what it is sent.

  ipcMain.handle('voice:tts:getSnapshot', async () => {
    if (!voiceSessionManager) {
      return {
        enabled: false,
        engine: 'system',
        status: { state: 'unavailable', message: 'Spoken answers are not available in this build.' },
        voices: [],
        voiceId: '',
        speed: 1,
        maxChars: 1200,
        speakActionResults: false,
        onlyVoiceTurns: true,
        models: [],
        speaking: false,
        elevenlabs: VOICE_TTS_ELEVENLABS_EMPTY_STATE
      }
    }
    return voiceSessionManager.speech.snapshot()
  })

  ipcMain.handle('voice:tts:setEnabled', async (_, payload: { enabled: boolean }) => speech().setEnabled(Boolean(payload?.enabled)))

  ipcMain.handle('voice:tts:setEngine', async (_, payload: { engine: string }) => {
    // A value outside the known engines is refused rather than coerced, so a
    // broken renderer cannot leave speech pointing at nothing.
    if (!isVoiceTtsEngineId(payload?.engine)) throw new Error('Unknown speech engine.')
    return speech().setEngine(payload.engine)
  })

  ipcMain.handle('voice:tts:setVoice', async (_, payload: { voiceId: string }) => speech().setVoice(String(payload?.voiceId ?? '')))

  ipcMain.handle('voice:tts:setSpeed', async (_, payload: { speed: number }) => speech().setSpeed(Number(payload?.speed)))

  ipcMain.handle('voice:tts:setMaxChars', async (_, payload: { maxChars: number }) => speech().setMaxChars(Number(payload?.maxChars)))

  ipcMain.handle('voice:tts:setSpeakActionResults', async (_, payload: { on: boolean }) => speech().setSpeakActionResults(Boolean(payload?.on)))

  ipcMain.handle('voice:tts:setOnlyVoiceTurns', async (_, payload: { on: boolean }) => speech().setOnlyVoiceTurns(Boolean(payload?.on)))

  ipcMain.handle('voice:tts:installModel', async (_, payload: { id: string }) => speech().installModel(String(payload?.id ?? '')))

  ipcMain.handle('voice:tts:selectModel', async (_, payload: { id: string }) => speech().selectModel(String(payload?.id ?? '')))

  ipcMain.handle('voice:tts:removeModel', async (_, payload: { id: string }) => speech().removeModel(String(payload?.id ?? '')))

  ipcMain.handle('voice:tts:preview', async (_, payload: { voiceId: string }) => {
    return { spoken: await requireVoice().speakPreview(String(payload?.voiceId ?? '')) }
  })

  ipcMain.handle('voice:tts:speak', async (_, payload: { text: string; taskId?: string }) => {
    return { spoken: await requireVoice().speakText(String(payload?.text ?? ''), payload?.taskId) }
  })

  ipcMain.handle('voice:tts:stop', () => {
    voiceSessionManager?.stopSpeaking()
  })

  // ElevenLabs (#64). The key goes in and never comes out: every reply is a
  // snapshot, and the snapshot says only whether a key is set.
  ipcMain.handle('voice:tts:elevenlabs:setKey', async (_, payload: { key: string }) => speech().setElevenLabsKey(String(payload?.key ?? '')))

  ipcMain.handle('voice:tts:elevenlabs:clearKey', async () => speech().clearElevenLabsKey())

  ipcMain.handle('voice:tts:elevenlabs:acceptDisclosure', async () => speech().acceptElevenLabsDisclosure())

  ipcMain.handle('voice:tts:elevenlabs:refresh', async () => speech().refreshElevenLabs())

  ipcMain.handle('voice:tts:elevenlabs:setModel', async (_, payload: { modelId: string }) =>
    speech().setElevenLabsModel(String(payload?.modelId ?? ''))
  )

  // Commander voice mode (#64). Main speaks the session's replies and reports
  // while a session is active, and barge-in cancels speech and the turn together.
  ipcMain.handle('voice:commander:setActive', (_, payload: { sessionId: string | null }) => {
    const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : null
    // Closing voice mode before the bridge exists is nothing to do.
    if (!sessionId && !commanderVoice) return { active: null }
    requireCommanderVoice().setActiveSession(sessionId)
    return { active: sessionId }
  })

  ipcMain.handle('voice:commander:bargeIn', (_, payload: { sessionId: string }) => {
    if (typeof payload?.sessionId !== 'string' || !payload.sessionId) return { cancelled: false }
    return requireCommanderVoice().bargeIn(payload.sessionId)
  })

  ipcMain.handle('voice:commander:send', async (event, payload: { sessionId: string; text: string }) => {
    // This path records a human authorization root, just like typed chat.
    // Authenticate before reading payloads or initializing the voice bridge.
    assertTrustedSender(event, 'voice:commander:send')
    if (typeof payload?.sessionId !== 'string' || !payload.sessionId) throw new Error('sessionId is required')
    return requireCommanderVoice().send(payload.sessionId, String(payload?.text ?? ''))
  })

  // The renderer sent a spoken sentence to an agent. The answer that comes back
  // is the reply to it, so it may be read aloud.
  ipcMain.handle('voice:expectAnswer', (_, payload: { turnId: string; taskId?: string }) => {
    if (!payload?.turnId) return
    voiceSessionManager?.expectSpokenAnswer(payload.turnId, payload.taskId)
  })

  // The user typed a message instead of speaking it. Whatever answer was
  // expected by voice is no longer the answer that is coming, so it is
  // forgotten — otherwise the reply to something typed is read aloud.
  ipcMain.handle('voice:answerNotExpected', (_, payload: { taskId?: string }) => {
    voiceSessionManager?.forgetSpokenAnswer(payload?.taskId)
  })
}
