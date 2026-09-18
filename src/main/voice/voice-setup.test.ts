import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

/**
 * One user action must install everything voice needs. After it, the user has
 * only to switch voice on — no directory to pick, no second download to start.
 */

const installer = vi.hoisted(() => ({
  detectVoiceRuntime: vi.fn(),
  installVoiceRuntime: vi.fn(),
  removeVoiceRuntime: vi.fn(async () => undefined),
  unsupportedHardwareReason: vi.fn((): string | null => null),
  VOICE_RUNTIME_APPROX_BYTES: 180 * 1024 * 1024,
}))
vi.mock('./voice-runtime-installer', () => installer)

const { VoiceSessionManager } = await import('./voice-session-manager')
const { DEFAULT_VOICE_MODEL_ID } = await import('./voice-model-manifest')
import type { VoiceModelManager } from './voice-model-manager'
import type { VoiceWorkerClient } from './voice-worker-client'

const ABSENT = { installed: false, version: null, modulePath: null, sizeBytes: 1 }
const PRESENT = {
  installed: true,
  version: '1.12.0',
  modulePath: '/data/voice-runtime/node_modules/sherpa-onnx-node',
  sizeBytes: 1,
}
const RESOLVED_MODEL = {
  id: DEFAULT_VOICE_MODEL_ID,
  dir: '/data/voice-models/en',
  encoder: '/data/voice-models/en/encoder.onnx',
  decoder: '/data/voice-models/en/decoder.onnx',
  joiner: '/data/voice-models/en/joiner.onnx',
  tokens: '/data/voice-models/en/tokens.txt',
  kind: 'offline' as const,
}
const LEGACY_ID = 'sherpa-streaming-zipformer-en'

class FakeWorker extends EventEmitter {
  load = vi.fn(async () => {
    this.emit('status', { state: 'ready', modelId: DEFAULT_VOICE_MODEL_ID, engine: 'sherpa-onnx' })
  })
  startTurn = vi.fn()
  pushAudio = vi.fn()
  endTurn = vi.fn()
  cancelTurn = vi.fn()
  unload = vi.fn()
  stop = vi.fn()
  setRuntimeModulePath = vi.fn()
  isRunning = true
  isLoaded = true
}

function makeManager(modelPresent: boolean) {
  const store: Record<string, string> = { voice_enabled: 'true' }
  const notify = vi.fn()
  const worker = new FakeWorker()
  const models = {
    list: vi.fn(async () => [] as never[]),
    listLegacyInstalled: vi.fn(async () => [] as never[]),
    install: vi.fn(async () => ({ id: DEFAULT_VOICE_MODEL_ID, installed: true })),
    resolve: vi.fn(async () => (modelPresent ? RESOLVED_MODEL : null)),
    remove: vi.fn(async () => undefined),
    removeAll: vi.fn(async () => undefined),
    isInstalled: vi.fn(async () => modelPresent),
  }
  const db = {
    getTasks: vi.fn(() => []),
    getTask: vi.fn(() => undefined),
    createTask: vi.fn(() => undefined),
    updateTask: vi.fn(() => undefined),
    getAgents: vi.fn(() => []),
    getSetting: vi.fn((key: string) => store[key]),
    setSetting: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
  }
  const manager = new VoiceSessionManager({
    db: db as never,
    agents: {} as never,
    notify,
    runtimeRootDir: '/data/voice-runtime',
    models: models as unknown as VoiceModelManager,
    worker: worker as unknown as VoiceWorkerClient,
  })
  return { manager, worker, notify, models, db, store }
}

function progressStages(notify: ReturnType<typeof vi.fn>): string[] {
  return notify.mock.calls
    .filter(([channel]) => channel === 'voice:runtimeProgress')
    .map(([, data]) => (data as { stage: string }).stage)
}

beforeEach(() => {
  installer.detectVoiceRuntime.mockReset()
  installer.installVoiceRuntime.mockReset()
  installer.unsupportedHardwareReason.mockReset().mockReturnValue(null)
})

describe('one-action voice setup', () => {
  it('offers Parakeet v3 to a fresh install', () => {
    expect(DEFAULT_VOICE_MODEL_ID).toBe('nemo-parakeet-tdt-0.6b-v3')
  })

  it('installs the runtime and the model, then loads it', async () => {
    // Absent at the first check, present after the install.
    installer.detectVoiceRuntime
      .mockResolvedValueOnce(ABSENT)
      .mockResolvedValue(PRESENT)
    installer.installVoiceRuntime.mockResolvedValue(PRESENT)

    const ctx = makeManager(false)
    // The model appears once it has been installed.
    ctx.models.resolve
      .mockResolvedValueOnce(null)
      .mockResolvedValue(RESOLVED_MODEL)

    const runtime = await ctx.manager.installRuntime()

    expect(installer.installVoiceRuntime).toHaveBeenCalledTimes(1)
    expect(ctx.models.install).toHaveBeenCalledWith(DEFAULT_VOICE_MODEL_ID)
    expect(ctx.store.voice_model_id).toBe(DEFAULT_VOICE_MODEL_ID)
    // The model is loaded at the end, so the user has nothing left to do.
    expect(ctx.worker.load).toHaveBeenCalledWith(RESOLVED_MODEL, expect.any(Number))
    expect(runtime.installed).toBe(true)
    expect(progressStages(ctx.notify).at(-1)).toBe('complete')
  })

  it('downloads only the model when the runtime is already there', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(false)
    ctx.models.resolve.mockResolvedValueOnce(null).mockResolvedValue(RESOLVED_MODEL)

    await ctx.manager.installRuntime()

    expect(installer.installVoiceRuntime).not.toHaveBeenCalled()
    expect(ctx.models.install).toHaveBeenCalledTimes(1)
  })

  it('downloads nothing when both are already there', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)

    await ctx.manager.installRuntime()

    expect(installer.installVoiceRuntime).not.toHaveBeenCalled()
    expect(ctx.models.install).not.toHaveBeenCalled()
    expect(ctx.worker.load).toHaveBeenCalledWith(RESOLVED_MODEL, expect.any(Number))
  })

  it('reports a failed model download instead of claiming success', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(false)
    ctx.models.resolve.mockResolvedValue(null)
    ctx.models.install.mockRejectedValue(new Error('checksum mismatch'))

    await expect(ctx.manager.installRuntime()).rejects.toThrow(/checksum mismatch/)
    expect(progressStages(ctx.notify).at(-1)).toBe('error')
    expect(ctx.worker.load).not.toHaveBeenCalled()
  })

  it('reports a failed runtime install instead of downloading a model', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(ABSENT)
    installer.installVoiceRuntime.mockRejectedValue(new Error('npm was not found'))
    const ctx = makeManager(false)

    await expect(ctx.manager.installRuntime()).rejects.toThrow(/npm was not found/)
    expect(ctx.models.install).not.toHaveBeenCalled()
    expect(progressStages(ctx.notify).at(-1)).toBe('error')
  })

  it('refuses a model download on hardware the runtime has no build for', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    installer.unsupportedHardwareReason.mockReturnValue('The local speech runtime has no build for Windows on arm64.')
    const ctx = makeManager(false)

    await expect(ctx.manager.installModel(DEFAULT_VOICE_MODEL_ID)).rejects.toThrow(/no build for Windows on arm64/)
    expect(ctx.models.install).not.toHaveBeenCalled()
  })
})

/**
 * A model from before Parakeet stays usable until the user moves off it. The
 * move is one download and one delete, in either order, and neither step can
 * leave voice without a model.
 */
describe('a legacy model already on disk', () => {
  const LEGACY_RESOLVED = { ...RESOLVED_MODEL, id: LEGACY_ID, kind: 'streaming' as const }

  it('is kept by the one-action setup rather than downloading a second model over it', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)
    ctx.store.voice_model_id = LEGACY_ID
    ctx.models.resolve.mockResolvedValue(LEGACY_RESOLVED)

    await ctx.manager.installRuntime()

    expect(ctx.models.install).not.toHaveBeenCalled()
    expect(ctx.worker.load).toHaveBeenCalledWith(LEGACY_RESOLVED, expect.any(Number))
    expect(ctx.store.voice_model_id).toBe(LEGACY_ID)
  })

  it('is replaced by Parakeet v3 when that is downloaded, and stays on disk until deleted', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)
    ctx.store.voice_model_id = LEGACY_ID

    await ctx.manager.installModel(DEFAULT_VOICE_MODEL_ID)

    expect(ctx.models.install).toHaveBeenCalledWith(DEFAULT_VOICE_MODEL_ID)
    expect(ctx.store.voice_model_id).toBe(DEFAULT_VOICE_MODEL_ID)
    expect(ctx.models.remove).not.toHaveBeenCalled()
  })

  it('falls back to Parakeet v3, not to another legacy model, when the one in use is deleted', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)
    ctx.store.voice_model_id = LEGACY_ID
    ctx.models.list.mockResolvedValue([
      { id: LEGACY_ID, installed: true, legacy: true },
      { id: 'nemotron-streaming-en-560ms', installed: true, legacy: true },
      { id: DEFAULT_VOICE_MODEL_ID, installed: true },
    ] as never)

    await ctx.manager.removeModel(LEGACY_ID)

    expect(ctx.store.voice_model_id).toBe(DEFAULT_VOICE_MODEL_ID)
  })

  it('falls back to the default when nothing else is installed, so setup offers Parakeet v3', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(false)
    ctx.store.voice_model_id = LEGACY_ID
    ctx.models.list.mockResolvedValue([{ id: LEGACY_ID, installed: false, legacy: true }] as never)

    await ctx.manager.removeModel(LEGACY_ID)

    expect(ctx.store.voice_model_id).toBe(DEFAULT_VOICE_MODEL_ID)
    expect(ctx.manager.getState()).toBe('model_needed')
  })

  it('removes a directory the catalogue no longer names', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)

    await ctx.manager.removeModel('some-model-from-2024')

    expect(ctx.models.remove).toHaveBeenCalledWith('some-model-from-2024')
  })
})

describe('choosing a model', () => {
  it('switches the model the worker uses', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)
    await ctx.manager.refreshRuntime()

    await ctx.manager.selectModel('nemotron-streaming-en-560ms')

    expect(ctx.store.voice_model_id).toBe('nemotron-streaming-en-560ms')
    // The old model is released and the new one is loaded.
    expect(ctx.worker.unload).toHaveBeenCalled()
    expect(ctx.worker.load).toHaveBeenCalled()
  })

  it('clears a hand-installed directory, so the choice is what runs', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)
    ctx.store.voice_custom_model_dir = '/somewhere/by-hand'

    await ctx.manager.selectModel('nemo-fast-conformer-en-480ms')

    expect(ctx.store.voice_custom_model_dir).toBe('')
  })

  it('falls back to another installed model when the one in use is deleted', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)
    ctx.store.voice_model_id = 'nemotron-streaming-en-560ms'
    ctx.models.list.mockResolvedValue([
      { id: 'nemotron-streaming-en-560ms', installed: true },
      { id: 'sherpa-streaming-zipformer-en', installed: true },
    ] as never)

    await ctx.manager.removeModel('nemotron-streaming-en-560ms')

    expect(ctx.models.remove).toHaveBeenCalledWith('nemotron-streaming-en-560ms')
    expect(ctx.store.voice_model_id).toBe('sherpa-streaming-zipformer-en')
  })

  it('keeps the choice when a different model is deleted', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)
    ctx.store.voice_model_id = 'sherpa-streaming-zipformer-en'

    await ctx.manager.removeModel('nemotron-streaming-en-560ms')

    expect(ctx.store.voice_model_id).toBe('sherpa-streaming-zipformer-en')
  })
})

describe('a model change never strands an open turn', () => {
  it('cancels the turn before it swaps the model', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)
    await ctx.manager.refreshRuntime()
    ctx.worker.emit('status', { state: 'ready', modelId: DEFAULT_VOICE_MODEL_ID, engine: 'x' })
    await ctx.manager.startTurn('dictation', {})

    await ctx.manager.selectModel('nemo-fast-conformer-en-480ms')

    expect(ctx.worker.cancelTurn).toHaveBeenCalled()
    expect(ctx.manager.getState()).not.toBe('listening')
  })

  it('cancels the turn before it deletes a model', async () => {
    installer.detectVoiceRuntime.mockResolvedValue(PRESENT)
    const ctx = makeManager(true)
    await ctx.manager.refreshRuntime()
    ctx.worker.emit('status', { state: 'ready', modelId: DEFAULT_VOICE_MODEL_ID, engine: 'x' })
    await ctx.manager.startTurn('dictation', {})

    await ctx.manager.removeModel('nemo-fast-conformer-en-480ms')

    expect(ctx.worker.cancelTurn).toHaveBeenCalled()
  })
})
