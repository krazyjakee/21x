import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { VoiceSessionManagerCore } from '../main/voice/voice-session-manager-core'
import { VoiceSpeechService } from '../main/voice/voice-speech-service'
import { VoiceModelManager } from '../main/voice/voice-model-manager'
import { VoiceRuntimeOwner } from '../main/voice/voice-runtime-installer'
import { VoiceWorkerClient } from '../main/voice/voice-worker-client'
import { VoiceTtsModelManager } from '../main/voice/voice-tts-model-manager'
import { VoiceTtsWorkerClient, type VoiceTtsWorkerHost } from '../main/voice/voice-tts-worker-client'
import { VoiceSystemVoicesOwner, type VoiceSystemVoicesHost } from '../main/voice/voice-system-voices'
import { VOICE_SETTING_KEYS } from '../shared/voice'
import { VOICE_TTS_SETTING_KEYS } from '../shared/voice-tts'
import { VOICE_MANAGEMENT_CODECS, VOICE_MANAGEMENT_EVENTS, VOICE_MANAGEMENT_OPERATIONS, VOICE_MANAGEMENT_UNAVAILABLE, type VoiceManagementOperation } from '../shared/voice-management-codecs'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { VoiceManagementBackend } from './voice-management-backend'
import { VOICE_MODEL_MANIFEST } from '../main/voice/voice-model-manifest'
import { VOICE_TTS_MODEL_MANIFEST } from '../main/voice/voice-tts-manifest'
import { VOICE_MANAGEMENT_STT_IDS, VOICE_MANAGEMENT_TTS_IDS } from '../shared/voice-management-codecs'

const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'voice-fixture', webviewId: 'main', origin: 'app://voice-fixture' }
let db: ReturnType<typeof createPortableTestDb>, agents: AgentManager, voice: VoiceSessionManagerCore, speech: VoiceSpeechService, backend: VoiceManagementBackend
let root: string, models: VoiceModelManager, runtime: VoiceRuntimeOwner, worker: VoiceWorkerClient, ttsModels: VoiceTtsModelManager, ttsWorker: VoiceTtsWorkerClient, systemVoices: VoiceSystemVoicesOwner
let read = true, write = true, current = true, ownerMatches = true
const invoke = (operation: VoiceManagementOperation, args: unknown[] = [], signal = new AbortController().signal) => backend.registry.invoke(operation, VOICE_MANAGEMENT_CODECS[operation].encodeArguments(args as never), caller, signal)
function deferred<T>() { let resolve!: (v: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (v: T) => resolve(v) } }
beforeEach(async () => {
  db = createPortableTestDb(); root = mkdtempSync(join(tmpdir(), '21x-voice-management-')); read = write = current = ownerMatches = true
  const assertCurrent = (): void => { if (!current || !db.db.open) throw new Error('Fixture owner unavailable') }
  agents = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
  const modelRoot = join(root, 'stt'), ttsRoot = join(root, 'tts'), runtimeRoot = join(root, 'runtime')
  mkdirSync(modelRoot); mkdirSync(ttsRoot)
  models = new VoiceModelManager({ rootDir: modelRoot, portable: true, downloads: 'disabled', assertCurrent })
  runtime = new VoiceRuntimeOwner({ rootDir: runtimeRoot, installation: 'unavailable', assertCurrent })
  worker = new VoiceWorkerClient({ scriptPath: join(root, 'voice-worker.js'), runtime: () => ({ execPath: process.execPath, env: {} }), assertModulePath: path => { assertCurrent(); if (path !== null) throw new Error('No fixture runtime module') } })
  ttsModels = new VoiceTtsModelManager({ rootDir: ttsRoot, host: { downloads: 'disabled', inventory: 'memory-only-fixture', assertCurrent, beforeRequest: () => { throw new Error('No fixture downloads') } } })
  ttsWorker = new VoiceTtsWorkerClient({ scriptPath: join(root, 'tts-worker.js'), execPath: process.execPath, env: {}, fork: vi.fn(() => { throw new Error('No fixture worker launch') }) as unknown as VoiceTtsWorkerHost['fork'], assertCurrent, assertRuntimeModule: () => { throw new Error('No fixture runtime module') }, assertModel: () => { throw new Error('No fixture model load') } })
  systemVoices = new VoiceSystemVoicesOwner({ platform: process.platform, capability: 'unavailable', executable: null, env: {}, execFile: vi.fn(() => { throw new Error('No fixture native listing') }) as unknown as VoiceSystemVoicesHost['execFile'], assertCurrent })
  speech = new VoiceSpeechService({ db, modelRootDir: ttsRoot, models: ttsModels, worker: ttsWorker, systemVoices, host: { hostedSpeech: 'disabled', audio: 'unavailable', assertCurrent }, notifyRenderer: () => {} })
  voice = new VoiceSessionManagerCore({ db, agents, modelRootDir: modelRoot, runtimeRootDir: runtimeRoot, worker, models, runtime, speech, permissions: { kind: 'unavailable' }, shortcuts: { kind: 'unavailable' }, actions: { kind: 'unavailable' }, assertCurrent, notify: () => {}, notifyRenderer: () => {} })
  await voice.initialize()
  backend = new VoiceManagementBackend({ voice, speech, engineEpoch: caller.engineEpoch, assertAvailable: assertCurrent,
    assertVoiceOwners(actual) { if (!ownerMatches || actual.voice !== voice || actual.speech !== speech) throw new Error('Wrong fixture owner'); voice.assertOwners({ db, agents, worker, models, runtime, speech }); speech.assertOwners({ db, models: ttsModels, worker: ttsWorker, systemVoices }) },
    isTrustedDesktop: identity => identity.webviewId === caller.webviewId && identity.origin === caller.origin,
    canManageVoice: (_identity, access) => read && (access === 'read' || write) })
})
afterEach(async () => {
  current = true; ownerMatches = true
  await backend?.close(); await voice?.close(); await agents?.stopAllSessions()
  if (db?.db.open) db.close()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('actual portable voice management owner with SQLite', () => {
  it('keeps the finite management model identities equal to the actual packaged catalogues', () => {
    expect([...VOICE_MANAGEMENT_STT_IDS].sort()).toEqual(VOICE_MODEL_MANIFEST.map(entry => entry.id).sort())
    expect([...VOICE_MANAGEMENT_TTS_IDS].sort()).toEqual(VOICE_TTS_MODEL_MANIFEST.map(entry => entry.id).sort())
  })
  it('publishes all21 finite command schemas, no capture/native/hosted/audio/action grants', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual([...VOICE_MANAGEMENT_OPERATIONS])
    expect(VOICE_MANAGEMENT_EVENTS).toHaveLength(4)
    for (const operation of ['voice:startTurn', 'voice:confirm', 'voice:getPermission', 'voice:setCustomModelDir', 'voice:setShortcut', 'voice:tts:speak', 'voice:tts:elevenlabs:setKey']) await expect(backend.registry.invoke(operation, {}, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    const snapshot = await invoke('voice:getSnapshot')
    expect(snapshot).toMatchObject({ defined: true, value: { enabled: false, state: 'disabled', runtime: { installed: false, modulePath: null } } })
    expect(await invoke('voice:tts:getSnapshot')).toMatchObject({ defined: true, value: { engine: 'system', speaking: false, status: { state: 'unavailable', message: VOICE_MANAGEMENT_UNAVAILABLE }, elevenlabs: { keySet: false, voices: [], models: [] } } })
  })
  it('writes actual STT/TTS settings through the one shared core lease without recursive/nested busy guards', async () => {
    expect(await invoke('voice:setEnabled', [true])).toMatchObject({ defined: true, value: { enabled: true, state: 'permission_needed' } })
    expect(db.getSetting(VOICE_SETTING_KEYS.enabled)).toBe('true')
    expect(await invoke('voice:setEndpointSilence', [1.2])).toEqual({ defined: true, value: { success: true } })
    expect(db.getSetting(VOICE_SETTING_KEYS.endpointSilence)).toBe('1.2')
    expect(await invoke('voice:tts:setEnabled', [true])).toMatchObject({ defined: true, value: { enabled: true, speaking: false } })
    await invoke('voice:tts:setEngine', ['local']); await invoke('voice:tts:setSpeed', [1.25]); await invoke('voice:tts:setMaxChars', [3000])
    await invoke('voice:tts:setSpeakActionResults', [false]); await invoke('voice:tts:setOnlyVoiceTurns', [true]); await invoke('voice:tts:setVoice', [''])
    expect(db.getSetting(VOICE_TTS_SETTING_KEYS.engine)).toBe('local'); expect(db.getSetting(VOICE_TTS_SETTING_KEYS.speed)).toBe('1.25'); expect(db.getSetting(VOICE_TTS_SETTING_KEYS.maxChars)).toBe('3000')
    expect(db.getSetting(VOICE_TTS_SETTING_KEYS.speakActionResults)).toBe('false'); expect(db.getSetting(VOICE_TTS_SETTING_KEYS.onlyVoiceTurns)).toBe('true')
  })
  it('refuses unverified runtime installation and unknown/hosted/model paths before effects', async () => {
    const installer = vi.spyOn(voice, 'installRuntime'), setting = vi.spyOn(db, 'setSetting')
    await expect(invoke('voice:installRuntime')).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' }); expect(installer).not.toHaveBeenCalled(); expect(setting).not.toHaveBeenCalled()
    await expect(backend.registry.invoke('voice:tts:setEngine', { engine: 'elevenlabs' }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    await expect(backend.registry.invoke('voice:installModel', { id: '../private' }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    await expect(backend.registry.invoke('voice:setEndpointSilence', { milliseconds: 1200 }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    await expect(invoke('voice:tts:setVoice', ['system:foreign'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(setting).not.toHaveBeenCalled()
  })
  it('requires trusted current caller, read/write authority and exact actual owner references', async () => {
    const setting = vi.spyOn(db, 'setSetting')
    await expect(backend.registry.invoke('voice:setEnabled', { enabled: true }, { ...caller, webviewId: 'foreign' }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(backend.registry.invoke('voice:setEnabled', { enabled: true }, { ...caller, engineEpoch: 'old' }, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    write = false; await expect(invoke('voice:setEnabled', [true])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await invoke('voice:getRuntime')).toMatchObject({ defined: true })
    read = false; await expect(invoke('voice:getSnapshot')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    read = write = true; ownerMatches = false; await expect(invoke('voice:setEnabled', [true])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(setting).not.toHaveBeenCalled()
  })
  it('retains a delayed actual model operation after abort/close timeout and prevents late SQL or another mutation', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    const original = models.remove.bind(models)
    vi.spyOn(models, 'remove').mockImplementation(async id => { entered.resolve(); await release.promise; return original(id) })
    const abort = new AbortController(), removal = invoke('voice:removeModel', ['nemo-parakeet-tdt-0.6b-v3'], abort.signal)
    const rejected = expect(removal).rejects.toMatchObject({ code: 'CANCELLED' })
    await entered.promise
    await expect(invoke('voice:tts:setSpeed', [1.25])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    abort.abort(); await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(backend.inflightCount).toBe(1)
    const setting = vi.spyOn(db, 'setSetting'); release.resolve(); await rejected; await backend.close()
    expect(setting).not.toHaveBeenCalled(); expect(backend.inflightCount).toBe(0)
  })
  it('rechecks revoked write permission after an awaited owned operation before persistence', async () => {
    const entered = deferred<void>(), release = deferred<void>(), original = models.remove.bind(models)
    vi.spyOn(models, 'remove').mockImplementation(async id => { entered.resolve(); await release.promise; return original(id) })
    const removal = invoke('voice:removeModel', ['nemo-parakeet-tdt-0.6b-v3']), rejected = expect(removal).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await entered.promise; write = false; const setting = vi.spyOn(db, 'setSetting'); release.resolve(); await rejected
    expect(setting).not.toHaveBeenCalled()
  })
  it('uses exact management event projections and withdraws events when read authority changes', async () => {
    const snapshot = await voice.snapshot(), { enabled, engine, models: catalogue, shortcut, runtime: status } = snapshot
    const event = backend.encodeEvent('voice:status', { enabled, engine, models: catalogue, shortcut, runtime: status })
    expect(backend.projectEvent('voice:status', event, caller)).toEqual(event)
    read = false; expect(backend.projectEvent('voice:status', event, caller)).toBeUndefined()
    expect(backend.hasEvent('voice:speech:chunk')).toBe(false); expect(backend.hasEvent('voice:final')).toBe(false)
  })
})
