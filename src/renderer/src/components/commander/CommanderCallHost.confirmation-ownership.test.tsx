import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CommanderEvent } from '@shared/commander'
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
import { CommanderCallHost, commanderCallMedia } from './CommanderCallHost'
import { CommanderVoiceControls } from './CommanderVoiceControls'
import { VoiceOverlay } from '@/components/voice/VoiceOverlay'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'
import { useVoiceStore } from '@/stores/voice-store'
import { clearDictationTarget, insertAndSubmit, getActiveComposer } from '@/lib/voice-dictation-target'
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
async function start() { await act(async () => { await useCommanderCallStore.getState().start('session-1') }) }




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

import { EventEmitter } from "events"
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
const matrix = ['session-1', 'session-2'].flatMap(session =>
  [false, true].flatMap(reused =>
    [false, true].flatMap(remount =>
      [false, true].map(delayed => ({session, reused, remount, delayed})))))

describe('Connected main-to-renderer cancellation ownership', () => {
  it.each(matrix)('late aborted reply: session=$session reuse=$reused remount=$remount delayedOutcome=$delayed', async ({session,reused,remount,delayed}) => {
    const ctx = bridge()
    const oldReply = deferred<{turnId: string; turnEpoch?: string}>()
    ids.queue = ['old-turn', 'old-epoch', reused ? 'old-turn' : 'new-turn', 'new-epoch']
    let first!: {turnId: string; turnEpoch?: string}
    let calls = 0
    vi.mocked(window.electronAPI.voice.startTurn).mockImplementation(async (mode, context) => {
      const result = await ctx.manager.startTurn(mode, context)
      if ('error' in result) throw Error(result.error)
      if (++calls === 1) { first = result; return oldReply.promise }
      return result
    })
    const v = view()
    let pending!: Promise<void>
    await act(async () => { pending = useCommanderCallStore.getState().start('session-1') })
    expect(first).toEqual({turnId:'old-turn',turnEpoch:'old-epoch'})
    if (remount) { v.unmount(); view() }
    else act(() => useCommanderCallStore.getState().end())
    await act(async () => { await useCommanderCallStore.getState().start(session) })
    const activeId = reused ? 'old-turn' : 'new-turn'
    expect(useVoiceStore.getState()).toMatchObject({turnId:activeId,turnEpoch:'new-epoch'})
    act(() => useVoiceStore.setState({partial:'replacement words',final:'owned prior sentence',level:0.45}))
    const writes = vi.fn(); const unsub = useVoiceStore.subscribe(writes)
    ctx.worker.cancelTurn.mockClear(); ctx.stop.mockClear(); ctx.notify.mockClear()
    if (delayed) ctx.hold()
    await act(async () => { oldReply.resolve(first); await pending })
    act(() => ctx.flush())
    expect(writes).not.toHaveBeenCalled()
    expect(ctx.stop).not.toHaveBeenCalled()
    expect(ctx.worker.cancelTurn).not.toHaveBeenCalled()
    expect(ctx.notify.mock.calls.filter(([channel])=>channel==='voice:state')).toEqual([])
    expect(ctx.manager.getState()).toBe('listening')
    ctx.manager.pushAudio(activeId, Buffer.alloc(4))
    expect(ctx.worker.pushAudio).toHaveBeenCalledOnce()
    expect(useCommanderCallStore.getState()).toMatchObject({status:'live',sessionId:session,turnId:activeId,error:null})
    expect(commanderCallMedia.userCaption).toEqual({partial:'replacement words',final:'owned prior sentence'})
    expect(commanderCallMedia.inputLevel()).toBe(0.45)
    expect(getActiveComposer()).toBe('commander-voice')
    await act(async () => { expect(insertAndSubmit('surviving words')).toBe(true) })
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(session,'surviving words')
    unsub()
    await act(async () => { useCommanderCallStore.getState().end(); ctx.flush() })
    expect(ctx.worker.cancelTurn).toHaveBeenCalledExactlyOnceWith(activeId)
    expect(ctx.manager.getState()).toBe('idle')
    expect(useCommanderCallStore.getState()).toMatchObject({status:'off',error:null})
    expect(useVoiceStore.getState()).toMatchObject({turnId:null,turnEpoch:null,captionOwner:null})
  })

  it.each([false,true])('three retired replies after live fourth start (reuse=$reused)', async reused => {
    const ctx=bridge()
    ids.queue=Array.from({length:4},(_,i)=>[reused?'same-id':`turn-${i}`,`epoch-${i}`]).flat()
    const replies=Array.from({length:3},()=>deferred<{turnId:string;turnEpoch?:string}>())
    const handles:Array<{turnId:string;turnEpoch?:string}>=[]
    vi.mocked(window.electronAPI.voice.startTurn).mockImplementation(async (mode,context)=> {
      const result=await ctx.manager.startTurn(mode,context)
      if ('error' in result) throw Error(result.error)
      const i=handles.push(result)-1
      return i<3?replies[i].promise:result
    })
    view()
    const pending:Promise<void>[]=[]
    for(let i=0;i<3;i++) {
      await act(async()=>{pending.push(useCommanderCallStore.getState().start(`session-${i}`))})
      act(()=>useCommanderCallStore.getState().end())
    }
    await act(async()=>{await useCommanderCallStore.getState().start('session-3')})
    ctx.worker.cancelTurn.mockClear();ctx.stop.mockClear()
    for(const i of [1,2,0]) await act(async()=>{replies[i].resolve(handles[i]);await pending[i]})
    expect(ctx.worker.cancelTurn).not.toHaveBeenCalled()
    expect(ctx.stop).not.toHaveBeenCalled()
    expect(useVoiceStore.getState()).toMatchObject({turnId:handles[3].turnId,turnEpoch:handles[3].turnEpoch})
    expect(useCommanderCallStore.getState()).toMatchObject({status:'live',sessionId:'session-3',error:null})
    act(()=>useCommanderCallStore.getState().end())
    expect(ctx.worker.cancelTurn).toHaveBeenCalledExactlyOnceWith(handles[3].turnId)
  })
})


describe('Connected retained confirmation ownership', () => {
  it.each(['session-1','session-2'].flatMap(session=>[false,true].map(reused=>({session,reused}))))(
    'dismissing prior confirmation preserves the call ($session reuse=$reused)', async ({session,reused})=>{
      const ctx=bridge()
      ids.queue=['command-turn','command-epoch',reused?'command-turn':'call-turn','call-epoch']
      const command=await ctx.manager.startTurn('command',{})
      if ('error' in command) throw Error(command.error)
      await act(async()=>{
        ctx.worker.emit('final',command.turnId,'create a task called Review the report')
        await Promise.resolve(); await Promise.resolve()
      })
      expect(useVoiceStore.getState().confirmation?.turnId).toBe(command.turnId)
      expect(ctx.manager.getState()).toBe('awaiting_confirmation')
      vi.mocked(window.electronAPI.voice.startTurn).mockImplementation((mode,context)=>ctx.manager.startTurn(mode,context))
      vi.mocked(window.electronAPI.voice.dismiss).mockImplementation(async (id, epoch) => {
        await ctx.invoke('voice:dismiss', { turnId: id, turnEpoch: epoch })
      })
      view()
      await act(async()=>{await useCommanderCallStore.getState().start(session)})
      expect(useCommanderCallStore.getState()).toMatchObject({status:'live',sessionId:session,error:null})
      const activeId=reused?'command-turn':'call-turn'
      expect(useVoiceStore.getState()).toMatchObject({turnId:activeId,turnEpoch:'call-epoch'})
      ctx.stop.mockClear(); ctx.worker.cancelTurn.mockClear(); ctx.notify.mockClear()
      await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Cancel'}));await Promise.resolve()})
      expect.soft(useVoiceStore.getState().confirmation).toBeNull()
      expect.soft(ctx.stop).not.toHaveBeenCalled()
      expect.soft(ctx.manager.getState()).toBe('listening')
      expect.soft(useVoiceStore.getState()).toMatchObject({turnId:activeId,turnEpoch:'call-epoch',captionOwner:'commander-voice'})
      expect(useCommanderCallStore.getState()).toMatchObject({status:'live',sessionId:session,turnId:activeId,error:null})
    }
  )
})


describe('Connected confirmation cancellation controls',()=>{
  it('dismissing a confirmation without another call clears it without executing work',async()=>{
    const ctx=bridge()
    const handle=await ctx.manager.startTurn('command',{})
    if ('error' in handle) throw Error(handle.error)
    await act(async()=>{ctx.worker.emit('final',handle.turnId,'create a task to fix login');await Promise.resolve();await Promise.resolve()})
    expect(useVoiceStore.getState().confirmation?.turnId).toBe(handle.turnId)
    await act(async()=>{
      vi.mocked(window.electronAPI.voice.dismiss).mockImplementation(async (id, epoch) => {
        await ctx.invoke('voice:dismiss', { turnId: id, turnEpoch: epoch })
      })
      await useVoiceStore.getState().dismiss()
    })
    expect(useVoiceStore.getState().confirmation).toBeNull()
    expect(ctx.manager.getState()).toBe('idle')
    expect(ctx.db.createTask).not.toHaveBeenCalled()
  })
  it('leased cancel of a retained confirmation preserves the replacement (dismiss contrast)',async()=>{
    const ctx=bridge()
    const handle=await ctx.manager.startTurn('command',{})
    if ('error' in handle) throw Error(handle.error)
    await act(async()=>{ctx.worker.emit('final',handle.turnId,'create a task to fix login');await Promise.resolve();await Promise.resolve()})
    vi.mocked(window.electronAPI.voice.startTurn).mockImplementation((mode,context)=>ctx.manager.startTurn(mode,context))
    view();await start()
    const owner=useVoiceStore.getState().turnEpoch
    ctx.stop.mockClear();ctx.worker.cancelTurn.mockClear()
    await act(async()=>{await ctx.invoke('voice:cancelTurn',handle)})
    expect(ctx.stop).not.toHaveBeenCalled()
    expect(ctx.worker.cancelTurn).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().turnEpoch).toBe(owner)
    expect(useCommanderCallStore.getState()).toMatchObject({status:'live',error:null})
  })
})
