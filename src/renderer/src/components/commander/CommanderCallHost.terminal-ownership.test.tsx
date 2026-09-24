import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { CommanderEvent } from '@shared/commander'
import type {
  VoiceSpeechChunkEvent,
  VoiceSpeechEndEvent,
  VoiceSpeechStartEvent,
} from '@shared/voice-tts'
import { EventEmitter } from 'events'

type TestTtsWorker = EventEmitter & {
  scriptPath: string
  load: (request: { engine: 'system' }) => void
  speak: () => void
  cancel: () => void
  stop: () => void
}
const mocks = vi.hoisted(() => ({
  selected: 'session-1',
  setActive: vi.fn(async (_id: string | null) => ({})),
  send: vi.fn(async (_id: string, _text: string): Promise<unknown> => ({})),
  bargeIn: vi.fn(async (_id: string) => ({})),
  events: new Set<(event: CommanderEvent) => void>()
}))
vi.mock('@/lib/ipc-client', async (original) => ({
  ...(await original<typeof import('@/lib/ipc-client')>()),
  commanderApi: { onEvent: (cb: (e: CommanderEvent) => void) => { mocks.events.add(cb); return () => mocks.events.delete(cb) } },
  commanderVoiceApi: { setActive: mocks.setActive, send: mocks.send, bargeIn: mocks.bargeIn }
}))
vi.mock('@/stores/commander-store', () => ({
  useCommanderStore: (selector: (s: { selectedSessionId: string }) => unknown) => selector({ selectedSessionId: mocks.selected })
}))

const ttsCallbacks = vi.hoisted(() => {
  const callbacks = {
    start: new Set<(event: VoiceSpeechStartEvent) => void>(),
    end: new Set<(event: VoiceSpeechEndEvent) => void>(),
    chunk: new Set<(event: VoiceSpeechChunkEvent) => void>(),
  }
  window.electronAPI.voice.tts = {
    getSnapshot: vi.fn(async () => ({
      enabled: false,
      engine: 'system' as const,
      status: { state: 'loading' as const },
      voices: [],
      voiceId: '',
      speed: 1,
      maxChars: 0,
      speakActionResults: true,
      onlyVoiceTurns: true,
      models: [],
      speaking: false,
      elevenlabs: {
        keySet: false,
        disclosureAccepted: false,
        modelId: '',
        models: [],
        voices: [],
        error: null,
        usage: null,
      },
    })),
    onSpeechStart: vi.fn((cb: (event: VoiceSpeechStartEvent) => void) => { callbacks.start.add(cb); return () => callbacks.start.delete(cb) }),
    onSpeechEnd: vi.fn((cb: (event: VoiceSpeechEndEvent) => void) => { callbacks.end.add(cb); return () => callbacks.end.delete(cb) }),
    onSpeechChunk: vi.fn((cb: (event: VoiceSpeechChunkEvent) => void) => { callbacks.chunk.add(cb); return () => callbacks.chunk.delete(cb) }),
    onStatus: vi.fn(() => () => {}),
    onModelProgress: vi.fn(() => () => {}),
    stop: vi.fn(async () => {})
  } as unknown as typeof window.electronAPI.voice.tts
  return callbacks
})

import { CommanderCallHost } from './CommanderCallHost'
import { CommanderVoiceControls } from './CommanderVoiceControls'
import { VoiceOverlay } from '@/components/voice/VoiceOverlay'
import { __resetCommanderCall } from '@/stores/commander-call-store'
import { useVoiceStore } from '@/stores/voice-store'
import { clearDictationTarget } from '@/lib/voice-dictation-target'
import { __resetCommanderActivity } from '@/lib/activity/commander-activity-adapter'
import { __resetVoiceAttribution } from '@/lib/activity/voice-activity-adapter'
import { voiceCapture } from '@/lib/voice-capture'
import { voicePlayback } from '@/lib/voice-playback'

const savedOutcome = vi.mocked(window.electronAPI.voice.onOutcome).mock.calls[0][0]
const initial = useVoiceStore.getState()
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(window.electronAPI.voice.cancelTurn).mockImplementation(async () => {})
  __resetCommanderCall()
  __resetCommanderActivity()
  __resetVoiceAttribution()
  clearDictationTarget()
  mocks.selected = 'session-1'
  mocks.events.clear()
  useVoiceStore.setState({
    ...initial, available: true, enabled: true, permission: 'granted',
    runtime: { installed: true, version: '1', modulePath: '/tmp/voice', sizeBytes: 0 },
    engine: { state: 'ready', modelId: 'm', engine: 'sherpa-onnx' },
    tts: { enabled: true, status: { state: 'ready' } } as never,
    turnId: null, state: 'idle', partial: '', final: '', speaking: false, speechText: '',
    initializeTts: vi.fn(async () => {}),
    setTtsEnabled: vi.fn(async () => {}),
    startTurn: vi.fn(async () => {
      if (!useVoiceStore.getState().turnId) useVoiceStore.setState({ turnId: 'mic-1', state: 'listening' })
      return useVoiceStore.getState().turnId
    }),
    cancel: vi.fn(async () => { useVoiceStore.setState({ turnId: null, state: 'idle', partial: '' }) }),
    stopPlaybackNow: vi.fn()
  }, true)
})
afterEach(() => { cleanup(); __resetCommanderCall(); __resetCommanderActivity(); __resetVoiceAttribution(); clearDictationTarget(); vi.restoreAllMocks(); voicePlayback.stop(); vi.unstubAllGlobals() })
function view() { return render(<><CommanderCallHost /><CommanderVoiceControls /><VoiceOverlay /></>) }




vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/pf-desktop-test'),
    getName: vi.fn(() => 'pf-desktop'),
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn()
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn()
  },
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn()
  },
  clipboard: {
    write: vi.fn(async () => undefined),
    writeText: vi.fn(async () => undefined),
    readText: vi.fn(async () => ''),
    clear: vi.fn()
  },
  ClipboardItem: class {
    constructor(public readonly items: Record<string, unknown>) {}
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }))
  },
  BrowserWindow: vi.fn(),
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
    isRegistered: vi.fn(() => false)
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true)
  },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(),
    isStarted: vi.fn(() => false)
  }
}))

const mainVoiceManagerPath = '../../../../main/voice/voice-session-manager'
const { VoiceSessionManager } = await import(/* @vite-ignore */ mainVoiceManagerPath)

/** A worker stand-in. Nothing here decodes audio; the tests drive it directly. */
class FakeWorker extends EventEmitter {
  load = vi.fn(async () => {
    this.emit('status', { state: 'ready', modelId: 'test-model', engine: 'fake' })
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

function makeManager(settings: Record<string, string> = { voice_enabled: 'true' }) {
  const store = { ...settings }
  const notify = vi.fn()
  const worker = new FakeWorker()
  const db = {
    getTasks: vi.fn(() => []),
    getTask: vi.fn(() => undefined),
    createTask: vi.fn(() => undefined),
    updateTask: vi.fn(() => undefined),
    getAgents: vi.fn(() => []),
    getTranscriptParts: vi.fn(() => []),
    getSetting: vi.fn((key: string) => store[key]),
    setSetting: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
  }
  const agents = {
    startTask: vi.fn(),
    sendByTaskId: vi.fn(),
    respondToPermission: vi.fn(),
    findSessionByTaskId: vi.fn(),
    getSessionStatus: vi.fn(),
    getLastAssistantMessage: vi.fn(),
  }
  const manager = new VoiceSessionManager({
    db: db as never,
    agents: agents as never,
    notify,
    modelRootDir: '/tmp/voice-models-test',
    runtimeRootDir: '/tmp/voice-runtime-test-absent',
    worker: worker as never,
  })
  return { manager, worker, notify, db, agents, store }
}

/** Puts the manager in the ready state without touching the file system. */
function makeReadyManager(settings?: Record<string, string>) {
  const ctx = makeManager(settings)
  // Pretend the runtime and a model are both present.
  ;(ctx.manager as unknown as { runtime: unknown }).runtime = {
    installed: true,
    version: '1.0.0',
    modulePath: '/tmp/voice',
    sizeBytes: 0,
  }
  ;(ctx.manager as unknown as { models: { resolve: () => Promise<unknown> } }).models.resolve =
    async () => ({
      id: 'test-model',
      dir: '/tmp/model',
      encoder: '/tmp/model/encoder.onnx',
      decoder: '/tmp/model/decoder.onnx',
      joiner: '/tmp/model/joiner.onnx',
      tokens: '/tmp/model/tokens.txt',
    })
  ctx.worker.emit('status', { state: 'ready', modelId: 'test-model', engine: 'fake' })
  return ctx
}


import { ipcMain } from 'electron'
const mainVoiceIpcPath = '../../../../main/ipc/voice'
const { registerVoiceHandlers } = await import(/* @vite-ignore */ mainVoiceIpcPath)
vi.mock('../../../../main/ipc/commander',()=>({getCommanderService:()=>null}))
const savedState = vi.mocked(window.electronAPI.voice.onState).mock.calls[0][0]

const ids = vi.hoisted(() => ({ queue: [] as string[], next: 0 }))
vi.mock('@paralleldrive/cuid2', () => ({ createId: () => ids.queue.shift() ?? `review-id-${++ids.next}` }))
function bridge() {
  const ctx = makeReadyManager()
  registerVoiceHandlers({voiceSessionManager:ctx.manager,db:ctx.db} as never)
  const handlers=new Map(vi.mocked(ipcMain.handle).mock.calls.map(([name,handler])=>[name,handler]))
  const invoke=(name:string,payload:unknown)=>handlers.get(name)!({} as never,payload)
  const held: Array<() => void> = []
  let holdOutcomes = false
  ctx.notify.mockImplementation((channel, payload) => {
    if (channel === 'voice:state') savedState(payload)
    if (channel === 'voice:speech:start') for(const cb of ttsCallbacks.start) cb(payload)
    if (channel === 'voice:speech:end') for(const cb of ttsCallbacks.end) cb(payload)
    if (channel === 'voice:outcome') {
      if (holdOutcomes) held.push(() => savedOutcome(payload))
      else savedOutcome(payload)
    }
  })
  vi.mocked(window.electronAPI.voice.cancelTurn).mockImplementation(async (id, epoch) => {
    await invoke('voice:cancelTurn',{turnId:id,turnEpoch:epoch})
  })
  const stop = vi.spyOn(voiceCapture, 'stop').mockImplementation(() => {})
  vi.spyOn(voiceCapture, 'start').mockResolvedValue(true)
  useVoiceStore.setState({startTurn: initial.startTurn, cancel: initial.cancel})
  return {...ctx, invoke, stop, hold: () => {holdOutcomes = true}, flush: () => { for (const deliver of held.splice(0)) deliver() }}
}
const audioSources: Array<{
  stop: ReturnType<typeof vi.fn>
  onended: (() => void) | null
}> = []
class ReviewAudioContext {
  state='running';currentTime=0;destination={}
  createAnalyser(){return {fftSize:256,frequencyBinCount:128,connect(){},disconnect(){},getByteTimeDomainData(a:Uint8Array){a.fill(128)}}}
  createBuffer(_channels:number,length:number,rate:number){const data=new Float32Array(length);return {duration:length/rate,getChannelData:()=>data}}
  createBufferSource(){const source={buffer:null,onended:null,connect(){},start:vi.fn(),stop:vi.fn()};audioSources.push(source);return source}
  resume(){return Promise.resolve()}
  close(){return Promise.resolve()}
}


vi.mock('child_process', async () => {
  const actual = (await import('node:module')).createRequire(import.meta.url)('child_process')
  const { EventEmitter } = await import('events')
  const fork = vi.fn(() => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false,
    connected: true, send: vi.fn(), kill: vi.fn()
  }))
  return { ...actual, fork, default: { ...actual, fork } }
})
import { fork } from 'child_process'

describe('terminal ownership: real worker failure contract', () => {
  it.each([false, true])('current confirmed-action crash settles even with queued audio=%s', async (queued) => {
    const ctx = bridge()
    ctx.store.voice_tts_enabled = 'true'
    ctx.store.voice_tts_speak_results = 'true'
    ctx.db.createTask.mockReturnValue({ id: 'created-task', title: 'Owned result' } as never)
    const speech = ctx.manager.speech
    const ttsWorker = (speech as unknown as { worker: TestTtsWorker }).worker
    // Only the process transport and audio device are faked. The worker client's
    // actual load, speak, exit, restart and error delivery methods are used.
    ttsWorker.scriptPath = process.execPath
    ttsWorker.load({ engine: 'system' })
    const child = vi.mocked(fork).mock.results.at(-1)!.value
    child.emit('message', { t: 'status', state: 'ready', sampleRate: 24000 })
    const command = await ctx.manager.startTurn('command', {})
    if ('error' in command) throw Error(command.error)
    view()
    await act(async () => {
      ctx.worker.emit('final', command.turnId, 'create a task called Owned result')
      await Promise.resolve(); await Promise.resolve()
    })
    await act(async () => { await ctx.invoke('voice:confirm', { ...command }) })
    const speechId = voicePlayback.currentSpeechId
    expect(speechId).toBeTruthy()
    expect(speech.speaking).toBe(true)
    expect(ctx.manager.getState()).toBe('speaking')
    vi.stubGlobal('AudioContext', ReviewAudioContext)
    if (queued) await act(async () => {
      child.emit('message', { t: 'chunk', speechId, sampleRate: 24000, pcm: Buffer.alloc(4800).toString('base64') })
    })
    ctx.notify.mockClear()
    await act(async () => {
      child.emit('exit', 1)
      // Successful worker restart does not synthesize or finish the lost passage.
      const restarted = vi.mocked(fork).mock.results.at(-1)!.value
      expect(restarted).not.toBe(child)
      restarted.emit('message', { t: 'status', state: 'ready', sampleRate: 24000 })
    })
    if (queued) await act(async () => { audioSources.at(-1)?.onended?.() })
    expect(voicePlayback.hasQueuedAudio).toBe(false)
    expect.soft(speech.speaking).toBe(false)
    expect.soft(ctx.manager.getState()).toBe('idle')
    expect.soft(voicePlayback.currentSpeechId).toBeNull()
    expect.soft(useVoiceStore.getState().speaking).toBe(false)
    expect.soft(ctx.notify.mock.calls.some(([c, e]) => c === 'voice:speech:end' && e.speechId === speechId && e.reason === 'error')).toBe(true)
    await act(async () => ctx.manager.stopSpeaking())
    ttsWorker.stop()
  })
})



describe('terminal ownership: adjacent answer continuation', () => {
  it.each([false, true])('stale answer failure cannot settle replacement waiting lifecycle: reused ID=%s', async (reused) => {
    const ctx = bridge()
    ctx.store.voice_tts_enabled = 'true'
    const speech = ctx.manager.speech
    const voices = [{ id: 'system:review', label: 'Review', engine: 'system', speakerId: 0, modelId: '', language: 'en', description: '' }]
    const ready = deferred<typeof voices>()
    const speechHarness = speech as unknown as {
      listVoices: () => Promise<typeof voices>
      worker: TestTtsWorker
    }
    vi.spyOn(speechHarness, 'listVoices').mockReturnValue(ready.promise)
    const ttsWorker = speechHarness.worker
    vi.spyOn(ttsWorker, 'load').mockImplementation(() => ttsWorker.emit('status', { state: 'ready', sampleRate: 24000 }))
    vi.spyOn(ttsWorker, 'speak').mockImplementation(() => {})
    vi.spyOn(ttsWorker, 'cancel').mockImplementation(() => {})
    ids.queue = ['old-turn', 'old-epoch', reused ? 'old-turn' : 'new-turn', 'new-epoch']
    const old = await ctx.manager.startTurn('conversation', {})
    if ('error' in old) throw Error(old.error)
    ctx.manager.expectSpokenAnswer(old.turnId, 'old-task')
    let pending!: Promise<boolean>
    await act(async () => { pending = ctx.manager.speakAgentAnswer('old-task', 'The old answer.'); await Promise.resolve() })
    const current = await ctx.manager.startTurn('command', { selectedTaskId: 'new-task' })
    if ('error' in current) throw Error(current.error)
    ctx.db.getTask.mockReturnValue({ id: 'new-task', title: 'New task', status: 'agent_working' } as never)
    await act(async () => {
      ctx.worker.emit('final', current.turnId, 'tell the agent please explain the result')
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    expect(ctx.agents.sendByTaskId).toHaveBeenCalledWith('new-task', 'please explain the result')
    expect(ctx.manager.getState()).toBe('waiting_for_agent')
    ctx.notify.mockClear()
    await act(async () => { ready.resolve(voices); await pending })
    expect.soft(ctx.manager.getState()).toBe('waiting_for_agent')
    expect.soft((ctx.manager as unknown as {
      lifecycleOwner: { turnId: string; turnEpoch: string | null } | null
    }).lifecycleOwner).toEqual({ turnId: current.turnId, turnEpoch: current.turnEpoch })
    expect.soft(ctx.notify.mock.calls.filter(([c]) => c === 'voice:state')).toEqual([])
    ctx.manager.shutdown()
  })
})
