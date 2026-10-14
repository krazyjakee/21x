import { execFile, fork } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import type { DatabaseManager } from '../main/database/manager'
import type { AgentManager } from '../main/agent-manager-core'
import { nodeWorkerRuntime } from '../main/node-worker-runtime'
import { VoiceSessionManagerCore } from '../main/voice/voice-session-manager-core'
import { VoiceModelManager } from '../main/voice/voice-model-manager'
import { VoiceRuntimeOwner, runtimeModulePath } from '../main/voice/voice-runtime-installer'
import { VoiceWorkerClient } from '../main/voice/voice-worker-client'
import { VoiceSpeechService } from '../main/voice/voice-speech-service'
import { VoiceTtsModelManager } from '../main/voice/voice-tts-model-manager'
import { VoiceTtsWorkerClient } from '../main/voice/voice-tts-worker-client'
import { VoiceSystemVoicesOwner } from '../main/voice/voice-system-voices'
import { VoiceModelInventoryOwner } from '../main/voice/voice-model-inventory-owner'
import type { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'

export interface ProductionVoiceResources { node: string; recognitionWorker: string; speechWorker: string }
export interface ProductionVoiceOwner {
  voice: VoiceSessionManagerCore
  speech: VoiceSpeechService
  assertOwners(db: DatabaseManager, agents: AgentManager, storage: AuthenticatedSecretStorage): void
  shutdown(): void
  close(): Promise<void>
}

/** Actual local owners. Native capture, playback, actions and shortcuts have
 * explicit unavailable capabilities until their real host owners are bound. */
export function createProductionVoiceOwner(input: {
  resources: ProductionVoiceResources; profileRoot: string; tempRoot: string
  db: DatabaseManager; agents: AgentManager; storage: AuthenticatedSecretStorage; assertCurrent(): void
  notify(channel: string, payload: unknown): void
}): ProductionVoiceOwner {
  input.assertCurrent()
  for (const path of Object.values(input.resources)) if (!isAbsolute(path) || path.includes('\0')) throw new Error('VOICE_RESOURCES_INVALID')
  const modelRootDir = join(input.profileRoot, 'voice-models'), ttsRoot = join(input.profileRoot, 'voice-tts-models'), runtimeRootDir = join(input.profileRoot, 'voice-runtime')
  const inventoryRootDir = join(input.profileRoot, 'voice-model-inventories')
  const inventory = new VoiceModelInventoryOwner({ profileRootDir: input.profileRoot, inventoryRootDir, modelRootDir: ttsRoot,
    storage: input.storage, assertCurrent: input.assertCurrent })
  const env = { HOME: input.profileRoot, USERPROFILE: input.profileRoot, TMPDIR: input.tempRoot, TEMP: input.tempRoot,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) }
  const runtimeSelector = (): ReturnType<typeof nodeWorkerRuntime> => {
    input.assertCurrent()
    return nodeWorkerRuntime(process.platform, input.resources.node, env, 'standalone')
  }
  const runtime = new VoiceRuntimeOwner({ rootDir: runtimeRootDir, installation: 'unavailable', assertCurrent: input.assertCurrent })
  const assertModule = (path: string | null): void => {
    input.assertCurrent()
    if (path !== null && path !== runtimeModulePath(runtimeRootDir)) throw new Error('VOICE_RUNTIME_OWNER_MISMATCH')
  }
  const worker = new VoiceWorkerClient({ scriptPath: input.resources.recognitionWorker, runtime: runtimeSelector, assertModulePath: assertModule })
  const models = new VoiceModelManager({ rootDir: modelRootDir, portable: true, downloads: 'enabled', assertCurrent: input.assertCurrent, beforeRequest: () => input.assertCurrent(), fetchImpl: fetch })
  const ttsModels = new VoiceTtsModelManager({ rootDir: ttsRoot, fetchImpl: fetch,
    host: { downloads: 'enabled', inventory, assertCurrent: input.assertCurrent, beforeRequest: () => input.assertCurrent() },
    onProgress: state => { input.assertCurrent(); input.notify('voice:tts:modelProgress', { model: state }) } })
  const systemVoices = new VoiceSystemVoicesOwner({ platform: process.platform, capability: 'unavailable', executable: null, env, execFile, assertCurrent: input.assertCurrent })
  const selected = runtimeSelector()
  const ttsWorker = new VoiceTtsWorkerClient({ scriptPath: input.resources.speechWorker, execPath: selected.execPath, env: selected.env, fork,
    assertCurrent: input.assertCurrent, assertRuntimeModule: assertModule, assertModel: model => ttsModels.assertResolvedModel(model) })
  const speech = new VoiceSpeechService({ db: input.db, modelRootDir: ttsRoot, models: ttsModels, worker: ttsWorker, systemVoices,
    notifyRenderer: input.notify, host: { hostedSpeech: 'disabled', audio: 'unavailable', assertCurrent: input.assertCurrent } })
  const voice = new VoiceSessionManagerCore({ db: input.db, agents: input.agents, notify: input.notify, notifyRenderer: input.notify,
    assertCurrent: input.assertCurrent,
    modelRootDir, runtimeRootDir, worker, models, runtime, speech,
    permissions: { kind: 'unavailable' }, shortcuts: { kind: 'unavailable' }, actions: { kind: 'unavailable' } })
  return { voice, speech, assertOwners(db, agents, storage) {
    input.assertCurrent()
    if (db !== input.db || agents !== input.agents || storage !== input.storage) throw new Error('VOICE_OWNER_MISMATCH')
    inventory.assertOwners({ profileRootDir: input.profileRoot, inventoryRootDir, modelRootDir: ttsRoot, storage })
    voice.assertOwners({ db, agents, worker, models, runtime, speech })
    speech.assertOwners({ db, models: ttsModels, worker: ttsWorker, systemVoices })
  }, shutdown: () => voice.shutdown(), close: () => voice.close() }
}
