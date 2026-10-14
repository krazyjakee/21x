import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { AgentManager } from '../agent-manager-core'
import { VoiceSessionManagerCore } from './voice-session-manager-core'
import { VoiceWorkerClient } from './voice-worker-client'
import { VoiceModelManager } from './voice-model-manager'
import { VoiceRuntimeOwner, runtimeModulePath, VOICE_RUNTIME_PACKAGE } from './voice-runtime-installer'
import { VoiceSpeechService } from './voice-speech-service'
import { VOICE_MODEL_MANIFEST } from './voice-model-manifest'
import { VOICE_EVENTS, VOICE_SETTING_KEYS, type VoiceModelManifestEntry } from '../../shared/voice'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let root: string, db: ReturnType<typeof createPortableTestDb>, agents: AgentManager
let voice: VoiceSessionManagerCore, models: VoiceModelManager, worker: VoiceWorkerClient, runtime: VoiceRuntimeOwner, speech: VoiceSpeechService
let events: Array<{ channel: string; data: unknown }>, current: boolean, added: VoiceModelManifestEntry | null
const content = Buffer.from('bounded recognition fixture'), digest = createHash('sha256').update(content).digest('hex')
function addModel() {
  const file = (name: string) => ({ name, url: `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/fixture-${name}`, sha256: digest, sizeBytes: content.length })
  added = { id: 'core-test-model', label: 'Core test model', description: 'Fixed synthetic model bytes', license: 'Apache-2.0', licenseUrl: 'https://example.invalid/license', languages: ['en'], minMemoryBytes: 1,
    files: ['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(file), roles: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt' } }
  VOICE_MODEL_MANIFEST.push(added)
  return added
}
function make(fetchImpl: typeof fetch = (async () => new Response(content)) as typeof fetch) {
  const modelRootDir = join(root, 'models'), runtimeRootDir = join(root, 'runtime')
  const assertCurrent = () => { if (!current) throw new Error('HOST_REPLACED') }
  models = new VoiceModelManager({ rootDir: modelRootDir, portable: true, fetchImpl, assertCurrent })
  worker = new VoiceWorkerClient({ scriptPath: join(root, 'missing-owned-worker.cjs'), runtime: () => ({ execPath: process.execPath, env: {} }) })
  runtime = new VoiceRuntimeOwner({ rootDir: runtimeRootDir, installation: 'unavailable', assertCurrent })
  // This actual speech owner never prepares audio or invokes hosted transport.
  // Recognition/action ownership is tested independently of microphone capture.
  speech = new VoiceSpeechService({ db, modelRootDir: join(root, 'tts'), notifyRenderer: () => {}, listVoices: async () => [] })
  voice = new VoiceSessionManagerCore({ db, agents, models, worker, runtime, speech, modelRootDir, runtimeRootDir, assertCurrent,
    notify: (channel, data) => events.push({ channel, data }), notifyRenderer: (channel, data) => events.push({ channel, data }),
    permissions: { kind: 'unavailable' }, shortcuts: { kind: 'unavailable' }, actions: { kind: 'unavailable' } })
  return { db, agents, models, worker, runtime, speech }
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'voice-core-owned-'))); db = createPortableTestDb(); current = true; events = []; added = null
  agents = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
    secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => null, isCodexAppServerAdapter: () => false })
})
afterEach(async () => {
  await voice?.close(); await agents.stopAllSessions()
  const dbRoot = dirname(dirname(db.getWorkspaceDir('fixture'))); db.close()
  await rm(root, { recursive: true, force: true }); await rm(dbRoot, { recursive: true, force: true })
  if (added) VOICE_MODEL_MANIFEST.splice(VOICE_MODEL_MANIFEST.indexOf(added), 1)
  vi.restoreAllMocks()
})

describe('actual host-neutral recognition owner', () => {
  it('projects actual runtime/model/settings reads without spawning unavailable native recognition', async () => {
    const owners = make(), spawn = vi.spyOn(worker, 'load')
    await mkdir(runtimeModulePath(join(root, 'runtime')), { recursive: true })
    await writeFile(join(runtimeModulePath(join(root, 'runtime')), 'package.json'), JSON.stringify({ name: VOICE_RUNTIME_PACKAGE, version: '1.12.0' }))
    db.setSetting(VOICE_SETTING_KEYS.enabled, 'true')
    const snapshot = await voice.snapshot()
    expect(snapshot.enabled).toBe(true); expect(snapshot.runtime).toMatchObject({ installed: true, version: '1.12.0' })
    voice.assertOwners(owners)
    await voice.prepareEngine()
    expect(voice.getMicrophonePermission()).toBe('unsupported')
    expect(await voice.startTurn('command', {})).toEqual({ error: 'Native microphone recognition is unavailable on this host.' })
    expect(spawn).not.toHaveBeenCalled(); expect(worker.inflightCount).toBe(0)
    expect(() => voice.assertOwners({ ...owners, agents: {} as AgentManager })).toThrow('OWNER_MISMATCH')
  })
  it('rejects unavailable shortcut/custom/action/runtime effects before their writes', async () => {
    make(); const before = db.getAllSettings(), write = vi.spyOn(db, 'setSetting')
    await expect(voice.setShortcut('CommandOrControl+V')).rejects.toThrow('SHORTCUT_UNAVAILABLE')
    await expect(voice.setCustomModelDir(join(root, 'ungranted'))).rejects.toThrow('CUSTOM_MODEL_UNAVAILABLE')
    await expect(voice.requestMicrophonePermission()).rejects.toThrow('MICROPHONE_UNAVAILABLE')
    await expect(voice.installRuntime()).rejects.toThrow('INSTALL_UNAVAILABLE')
    expect(write).not.toHaveBeenCalled(); expect(db.getAllSettings()).toEqual(before)
    await expect(stat(join(root, 'runtime'))).rejects.toThrow()
    expect(await voice.startTurn('command', {})).toHaveProperty('error')
  })
  it('joins late initialization and suppresses settings/events after host shutdown', async () => {
    make(); const receipt = deferred<Awaited<ReturnType<VoiceRuntimeOwner['detect']>>>(), entered = deferred<void>()
    vi.spyOn(runtime, 'detect').mockImplementation(() => { entered.resolve(); return receipt.promise })
    const initialize = voice.initialize(); await entered.promise
    await expect(voice.close(10)).rejects.toThrow('DRAIN_INCOMPLETE')
    const eventCount = events.length, settingWrite = vi.spyOn(db, 'setSetting')
    receipt.resolve({ installed: false, modulePath: null, version: null, sizeBytes: 0 })
    await initialize; await voice.close()
    expect(events).toHaveLength(eventCount); expect(settingWrite).not.toHaveBeenCalled()
    expect(voice.inflightCount).toBe(0); await expect(voice.snapshot()).rejects.toThrow('CLOSED')
  })
  it('keeps accepted raw downloads owned through shutdown and never writes the selected model late', async () => {
    const entry = addModel(), receipt = deferred<Response>(), requested = deferred<void>()
    make((async () => { requested.resolve(); return receipt.promise }) as typeof fetch)
    db.setSetting(VOICE_SETTING_KEYS.modelId, 'old-selection')
    const install = voice.installModel(entry.id).catch(error => error); await requested.promise
    await expect(voice.close(10)).rejects.toThrow('DRAIN_INCOMPLETE')
    expect(models.inflightCount).toBeGreaterThan(0)
    const eventCount = events.length
    receipt.resolve(new Response(content)); await install; await voice.close()
    expect(db.getSetting(VOICE_SETTING_KEYS.modelId)).toBe('old-selection')
    expect(events).toHaveLength(eventCount)
    await expect(stat(join(root, 'models', entry.id, 'encoder.onnx'))).rejects.toThrow()
  })
  it('rechecks mutation grant after a raw download and does not publish or replace selected-model settings', async () => {
    const entry = addModel(), receipt = deferred<Response>(), requested = deferred<void>()
    make((async () => { requested.resolve(); return receipt.promise }) as typeof fetch)
    let granted = true
    const grant = () => { voice.assertOwners({ db, agents, models, worker, runtime, speech }); if (!granted) throw new Error('CALLER_REPLACED') }
    const install = voice.runManagementMutation(() => voice.installModel(entry.id), grant).catch(error => error)
    await requested.promise; granted = false; receipt.resolve(new Response(content))
    await install
    expect(db.getSetting(VOICE_SETTING_KEYS.modelId)).toBeUndefined()
    await expect(stat(join(root, 'models', entry.id, 'encoder.onnx'))).rejects.toThrow()
  })
  it('serializes shared management and rejects competing unleased writes', async () => {
    make(); const receipt = deferred<void>(), entered = deferred<void>(), grant = vi.fn()
    const first = voice.runManagementMutation(async () => { entered.resolve(); await receipt.promise; await voice.setEndpointSilence(0.5) }, grant)
    await entered.promise
    await expect(voice.setEnabled(true)).rejects.toThrow('MANAGEMENT_BUSY')
    const second = voice.runManagementMutation(() => voice.setEndpointSilence(1), grant)
    receipt.resolve(); await first; await second
    expect(db.getSetting(VOICE_SETTING_KEYS.endpointSilence)).toBe('1'); expect(grant).toHaveBeenCalled()
  })
  it('exports complete five-field status events and suppresses foreign/stale worker turns', async () => {
    make(); await voice.setEndpointSilence(0.5)
    const statuses = events.filter(event => event.channel === VOICE_EVENTS.status)
    expect(statuses.length).toBeGreaterThan(0)
    for (const status of statuses) expect(Object.keys(status.data as object).sort()).toEqual(['enabled','engine','models','runtime','shortcut'])
    const before = events.length
    worker.emit('partial', 'foreign-turn', 'must remain private')
    worker.emit('final', 'foreign-turn', 'create a task')
    await Promise.resolve(); expect(events).toHaveLength(before)
    const tasks = db.getTasks(); expect(tasks.filter(task => task.title === 'create a task')).toHaveLength(0)
  })
})
