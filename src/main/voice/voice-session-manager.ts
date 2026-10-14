/** Electron compatibility host for the host-neutral recognition owner. */
import { app, globalShortcut, systemPreferences } from 'electron'
import { join } from 'path'
import type { MicrophonePermission } from '../../shared/voice'
import { VoiceSessionManagerCore } from './voice-session-manager-core'
import { VoiceModelManager } from './voice-model-manager'
import { VoiceWorkerClient } from './voice-worker-client'
import { VoiceRuntimeOwner } from './voice-runtime-installer'
import { VoiceSpeechService } from './voice-speech-service'
import type { VoiceActionAgents, VoiceActionDb } from './voice-action-service'
export { VOICE_ENGINE_READY_TIMEOUT_MS, VOICE_ANSWER_WAIT_MS } from './voice-session-manager-core'

export interface VoiceSessionManagerOptions {
  db: VoiceActionDb & { setSetting: (key: string, value: string) => void }
  agents: VoiceActionAgents
  /** Broadcasts one event to the desktop renderer and to mobile clients. */
  notify: (channel: string, data: unknown) => void
  /**
   * Sends one event to the desktop renderer only. Speech audio uses this:
   * samples must never go through the mobile text channel (design §5.11).
   */
  notifyRenderer?: (channel: string, data: unknown) => void
  modelRootDir?: string
  /** Where the downloaded speech-synthesis models live. */
  ttsModelRootDir?: string
  /** Where the optional speech runtime is installed. */
  runtimeRootDir?: string
  worker?: VoiceWorkerClient
  /** Injected in tests so no real download runs. */
  models?: VoiceModelManager
  /** Injected in tests so no synthesis worker starts. */
  speech?: VoiceSpeechService
}

export class VoiceSessionManager extends VoiceSessionManagerCore {
  constructor(options: VoiceSessionManagerOptions) {
    const modelRootDir = options.modelRootDir ?? join(app.getPath('userData'), 'voice-models')
    const runtimeRootDir = options.runtimeRootDir ?? join(app.getPath('userData'), 'voice-runtime')
    super({
      ...options,
      notifyRenderer: options.notifyRenderer ?? options.notify,
      modelRootDir, runtimeRootDir,
      worker: options.worker ?? new VoiceWorkerClient(),
      models: options.models ?? new VoiceModelManager({ rootDir: modelRootDir }),
      runtime: new VoiceRuntimeOwner({ rootDir: runtimeRootDir, installation: 'electron-compatibility' }),
      speech: options.speech ?? new VoiceSpeechService({ db: options.db, modelRootDir: options.ttsModelRootDir ?? join(app.getPath('userData'), 'voice-tts-models'), notifyRenderer: options.notifyRenderer ?? options.notify }),
      permissions: { kind: 'native', get: () => {
        if (process.platform !== 'darwin') return 'unsupported'
        const value = systemPreferences.getMediaAccessStatus('microphone')
        return value === 'granted' || value === 'denied' || value === 'not-determined' ? value : 'unsupported'
      }, request: async (): Promise<MicrophonePermission> => process.platform === 'darwin' ? await systemPreferences.askForMediaAccess('microphone') ? 'granted' : 'denied' : 'unsupported' },
      shortcuts: { kind: 'native', register: (key, callback) => globalShortcut.register(key, callback), unregister: (key) => globalShortcut.unregister(key) },
      actions: { kind: 'electron-compatibility' }, canUseCustomModelDir: () => true,
    })
  }
}
