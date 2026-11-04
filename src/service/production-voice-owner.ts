import { execFile, fork } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
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
import { watchAgentAnswersForSpeech } from '../main/voice/voice-answer-watch'
import { CommanderVoice, type CommanderVoiceCommander } from '../main/voice/commander-voice'
import { resolveProductionNpmCli } from './production-installation-host'

export interface ProductionVoiceResources { node: string; recognitionWorker: string; speechWorker: string }
export interface ProductionVoiceOwner {
  voice: VoiceSessionManagerCore
  speech: VoiceSpeechService
  /** Commander voice mode, built on first use from the live Commander service. */
  commanderVoice(commander: CommanderVoiceCommander, resolveProjectName: (projectId: string) => string | null | undefined): CommanderVoice
  assertOwners(db: DatabaseManager, agents: AgentManager, storage: AuthenticatedSecretStorage): void
  shutdown(): void
  close(): Promise<void>
}

/** The first absolute, executable `name` on PATH, or null. */
function findExecutable(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, name)
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } } catch { /* not here */ }
  }
  return null
}

/** The system speech command `voice-tts-worker.js` runs on this platform. */
function systemSpeechCommand(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'say' : platform === 'win32' ? 'powershell.exe' : 'espeak-ng'
}

/**
 * The voice owners for the Tauri host.
 *
 * The WebView captures the microphone (the native host admits audio-only
 * capture for the application page) and plays synthesized speech, exactly as
 * the Electron window does. Recognition, speech synthesis and the optional
 * runtime install run here; spoken task commands go through the same
 * VoiceActionService and canonical task events as Electron.
 */
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
  // Workers get a small environment. PATH is included so the speech worker can
  // find the system voice command, as it does under Electron.
  const env = { HOME: input.profileRoot, USERPROFILE: input.profileRoot, TMPDIR: input.tempRoot, TEMP: input.tempRoot,
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, Path: process.env.Path } : {}) }
  const runtimeSelector = (): ReturnType<typeof nodeWorkerRuntime> => {
    input.assertCurrent()
    return nodeWorkerRuntime(process.platform, input.resources.node, env, 'standalone')
  }
  // The optional runtime installs with npm. The npm CLI found on PATH runs
  // under the bundled Node, so a missing or different system Node is no
  // obstacle; without one, the `npm` on PATH is tried as Electron does.
  const npmCli = resolveProductionNpmCli(process.env)
  const npmEnv = { ...process.env, PATH: [dirname(input.resources.node), process.env.PATH].filter(Boolean).join(delimiter) }
  const runtime = new VoiceRuntimeOwner({ rootDir: runtimeRootDir, installation: 'portable', assertCurrent: input.assertCurrent,
    npm: npmCli ? { command: input.resources.node, args: [npmCli], env: npmEnv } : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], env: npmEnv } })
  const assertModule = (path: string | null): void => {
    input.assertCurrent()
    if (path !== null && path !== runtimeModulePath(runtimeRootDir)) throw new Error('VOICE_RUNTIME_OWNER_MISMATCH')
  }
  const worker = new VoiceWorkerClient({ scriptPath: input.resources.recognitionWorker, runtime: runtimeSelector, assertModulePath: assertModule })
  const models = new VoiceModelManager({ rootDir: modelRootDir, portable: true, downloads: 'enabled', assertCurrent: input.assertCurrent, beforeRequest: () => input.assertCurrent(), fetchImpl: fetch })
  const ttsModels = new VoiceTtsModelManager({ rootDir: ttsRoot, fetchImpl: fetch,
    host: { downloads: 'enabled', inventory, assertCurrent: input.assertCurrent, beforeRequest: () => input.assertCurrent() },
    onProgress: state => { input.assertCurrent(); input.notify('voice:tts:modelProgress', { model: state }) } })
  const systemExecutable = findExecutable(systemSpeechCommand(process.platform), process.env.PATH)
  const systemVoices = new VoiceSystemVoicesOwner({ platform: process.platform, capability: systemExecutable ? 'available' : 'unavailable', executable: systemExecutable, env, execFile, assertCurrent: input.assertCurrent })
  const selected = runtimeSelector()
  const ttsWorker = new VoiceTtsWorkerClient({ scriptPath: input.resources.speechWorker, execPath: selected.execPath, env: selected.env, fork,
    assertCurrent: input.assertCurrent, assertRuntimeModule: assertModule, assertModel: model => ttsModels.assertResolvedModel(model) })
  const speech = new VoiceSpeechService({ db: input.db, modelRootDir: ttsRoot, models: ttsModels, worker: ttsWorker, systemVoices,
    notifyRenderer: input.notify, host: { hostedSpeech: 'disabled', audio: 'desktop', assertCurrent: input.assertCurrent } })
  const voice = new VoiceSessionManagerCore({ db: input.db, agents: input.agents, notify: input.notify, notifyRenderer: input.notify,
    assertCurrent: input.assertCurrent,
    modelRootDir, runtimeRootDir, worker, models, runtime, speech,
    // The WebView asks for the microphone itself, so there is no separate OS
    // gate to report here; `unsupported` is how Electron says the same on
    // Linux and Windows.
    permissions: { kind: 'native', get: () => 'unsupported', request: async () => 'unsupported' },
    shortcuts: { kind: 'unavailable' }, actions: { kind: 'desktop' } })
  // Agent answers to a spoken question are read aloud as they are written.
  // AgentManager listeners cannot be removed, so this one goes quiet on shutdown.
  let closed = false
  watchAgentAnswersForSpeech({ addExternalListener: listener => input.agents.addExternalListener((channel, data) => { if (!closed) listener(channel, data) }) }, input.db, voice)
  let commander: { voice: CommanderVoice; service: CommanderVoiceCommander } | null = null
  return { voice, speech, commanderVoice(service, resolveProjectName) {
    input.assertCurrent()
    if (commander?.service === service) return commander.voice
    commander?.voice.dispose()
    commander = { service, voice: new CommanderVoice({ commander: service, speech, resolveProjectName }) }
    return commander.voice
  }, assertOwners(db, agents, storage) {
    input.assertCurrent()
    if (db !== input.db || agents !== input.agents || storage !== input.storage) throw new Error('VOICE_OWNER_MISMATCH')
    inventory.assertOwners({ profileRootDir: input.profileRoot, inventoryRootDir, modelRootDir: ttsRoot, storage })
    voice.assertOwners({ db, agents, worker, models, runtime, speech })
    speech.assertOwners({ db, models: ttsModels, worker: ttsWorker, systemVoices })
  }, shutdown: () => { closed = true; commander?.voice.dispose(); commander = null; voice.shutdown() }, close: () => voice.close() }
}
