import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({
  events: new Map<string, Set<(e: any) => void>>(),
  start: vi.fn(async () => ({ turnId: 'mic-1' })),
  end: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
  send: vi.fn(async () => ({})), active: vi.fn(async () => ({})),
  barge: vi.fn(async () => ({})), audio: vi.fn(),
  capture: vi.fn(async () => true), stop: vi.fn()
}))
vi.hoisted(() => { (window.electronAPI.voice as any).tts = { getSnapshot: () => ({}) } })
vi.mock('@/lib/ipc-client', async original => ({
  ...await original<typeof import('@/lib/ipc-client')>(),
  voiceApi: new Proxy({ startTurn: m.start, endTurn: m.end, cancelTurn: m.cancel, pushAudio: m.audio }, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target]
      if (prop.startsWith('on')) return (cb: (e: any) => void) => {
        if (!m.events.has(prop)) m.events.set(prop, new Set())
        m.events.get(prop)!.add(cb)
        return () => m.events.get(prop)!.delete(cb)
      }
      return async () => ({})
    }
  }),
  voiceTtsApi: new Proxy({}, { get(_target, prop: string) {
    if (prop.startsWith('on')) return (cb: (e: any) => void) => {
      const key = 'tts:' + prop; if (!m.events.has(key)) m.events.set(key, new Set()); m.events.get(key)!.add(cb); return () => m.events.get(key)!.delete(cb)
    }; return async () => ({})
  }}),
  commanderVoiceApi: { send: m.send, setActive: m.active, bargeIn: m.barge }
}))
vi.mock('@/lib/voice-capture', () => ({ voiceCapture: { start: m.capture, stop: m.stop, isCapturing: false } }))
import { useVoiceStore } from './stores/voice-store'
import { __resetCommanderCall, useCommanderCallStore as call } from './stores/commander-call-store'
import { CommanderCallHost } from './components/commander/CommanderCallHost'
import { useVoiceControl } from './hooks/use-voice-control'
import { useGlobalShortcuts } from './components/layout/hooks/use-global-shortcuts'
import { clearDictationTarget, getActiveComposer, registerComposer, setActiveComposer } from './lib/voice-dictation-target'
import { useUIStore } from './stores/ui-store'
const initial = useVoiceStore.getState()
function Shell() { useVoiceControl(); useGlobalShortcuts({} as any, vi.fn()); return <CommanderCallHost /> }
function emit(name: string, event: any) { act(() => m.events.get(name)?.forEach(cb => cb(event))) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function start() { render(<Shell />); await act(async () => { await call.getState().start('session-a') }) }
async function press() { await act(async () => { await call.getState().beginPushToTalk() }) }
function release() { act(() => call.getState().endPushToTalk()) }
function final(id = 'mic-1') {
  emit('onFinal', { turnId: id, text: 'archive the project' })
  emit('onState', { state: 'idle' })
  emit('onDictate', { turnId: id, text: 'archive the project' })
  emit('onOutcome', { turnId: id, status: 'dictation', text: 'archive the project' })
}
beforeEach(() => {
  __resetCommanderCall(); clearDictationTarget(); vi.clearAllMocks()
  m.start.mockImplementation(async () => ({ turnId: 'mic-1' }))
  m.capture.mockImplementation(async () => true)
  useVoiceStore.setState({ ...initial, available: true, enabled: true, turnId: null, finalizingTurnId: null,
    engine: { state: 'ready', modelId: 'test', engine: 'fake' } as any,
    runtime: { installed: true } as any, models: [{ installed: true }] as any,
    permission: 'granted', tts: { enabled: true, status: { state: 'ready' } } as any,
    initialize: vi.fn(async () => {}), initializeTts: vi.fn(async () => {}) }, true)
  useUIStore.setState({ activeModal: null, sidebarView: 'commander' })
})
afterEach(() => { cleanup(); __resetCommanderCall(); clearDictationTarget(); vi.restoreAllMocks() })
it('control: default PTT starts without acquiring a microphone', async () => { await start(); expect(m.start).not.toHaveBeenCalled(); expect(call.getState().status).toBe('live') })
it('control: release before final submits once', async () => { await start(); await press(); release(); final(); expect(m.send).toHaveBeenCalledExactlyOnceWith('session-a', 'archive the project') })
it('worker final before key release still submits once', async () => { await start(); await press(); final(); expect(m.send).toHaveBeenCalledExactlyOnceWith('session-a', 'archive the project') })
it('ordinary dictation final before manual stop still inserts text', async () => {
  render(<Shell />)
  const field = document.createElement('textarea'); document.body.appendChild(field)
  registerComposer('task-foreign', { getField: () => field }); setActiveComposer('task-foreign')
  await act(async () => { await useVoiceStore.getState().startTurn('dictation') })
  final(); expect(field.value).toBe('archive the project'); field.remove()
})
it('control: partial and stale final never submit', async () => { await start(); await press(); emit('onPartial', { turnId: 'mic-1', text: 'archive the project' }); final('old'); expect(m.send).not.toHaveBeenCalled() })
it('released final cannot submit after switching to open mic while its IPC start is pending', async () => {
  await start(); await press(); release()
  const pending = deferred<{ turnId: string }>(); m.start.mockReturnValueOnce(pending.promise)
  let changing!: Promise<void>; act(() => { changing = call.getState().setMicrophoneMode('open-mic') })
  final()
  expect(m.send).not.toHaveBeenCalled()
  await act(async () => { pending.resolve({ turnId: 'mic-2' }); await changing })
})
it('released final cannot enter a restarted different-session call while its IPC start is pending', async () => {
  await start(); await press(); release(); act(() => call.getState().end())
  await act(async () => { await call.getState().start('session-b') })
  const pending = deferred<{ turnId: string }>(); m.start.mockReturnValueOnce(pending.promise)
  let opening!: Promise<void>; act(() => { opening = call.getState().beginPushToTalk() })
  final()
  expect(m.send).not.toHaveBeenCalled()
  await act(async () => { pending.resolve({ turnId: 'mic-2' }); await opening })
})
it('old outcome cannot clear a newly held PTT turn', async () => {
  await start(); await press(); release(); m.start.mockResolvedValueOnce({ turnId: 'mic-2' }); await press()
  emit('onOutcome', { turnId: 'mic-1', status: 'dictation', text: 'old words' })
  expect(useVoiceStore.getState().turnId).toBe('mic-2'); expect(call.getState().pushToTalkHeld).toBe(true)
})
it('release stops capture immediately even while microphone startup is unresolved', async () => {
  await start(); const pending = deferred<boolean>(); m.capture.mockReturnValueOnce(pending.promise)
  let opening!: Promise<void>; act(() => { opening = call.getState().beginPushToTalk() })
  await act(async () => { await Promise.resolve() })
  release(); expect(m.stop).toHaveBeenCalled()
  await act(async () => { pending.resolve(true); await opening })
})
it('End cancels a startup microphone immediately, without waiting on getUserMedia', async () => {
  await start(); const pending = deferred<boolean>(); m.capture.mockReturnValueOnce(pending.promise)
  let opening!: Promise<void>; act(() => { opening = call.getState().beginPushToTalk() })
  await act(async () => { await Promise.resolve() })
  act(() => call.getState().end()); expect(m.cancel).toHaveBeenCalledWith('mic-1')
  await act(async () => { pending.resolve(true); await opening })
})
it('repeat after worker auto-final does not activate native Space defaults', async () => {
  await start(); await press(); final()
  const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true, bubbles: true, cancelable: true })
  window.dispatchEvent(e); expect(e.defaultPrevented).toBe(true)
})
for (const tag of ['button', 'summary', 'a']) it(`Space on focused ${tag} preserves native activation instead of opening mic`, async () => {
  await start(); const control = document.createElement(tag); document.body.appendChild(control); control.focus()
  fireEvent.keyDown(control, { key: ' ', code: 'Space' }); await act(async () => {})
  expect(m.start).not.toHaveBeenCalled(); control.remove()
})
for (const tag of ['input', 'textarea', 'select']) it(`control: Space in ${tag} does not capture`, async () => {
  await start(); const control = document.createElement(tag); document.body.appendChild(control)
  fireEvent.keyDown(control, { key: ' ', code: 'Space' }); expect(m.start).not.toHaveBeenCalled(); control.remove()
})
it('control: repeat while held does not acquire twice', async () => { await start(); await press(); fireEvent.keyDown(window, { key: ' ', code: 'Space', repeat: true }); expect(m.start).toHaveBeenCalledTimes(1) })
it('control: keyup after focus moves to an editor releases the owned turn', async () => {
  await start(); await press(); const input = document.createElement('input'); document.body.appendChild(input)
  fireEvent.keyUp(input, { key: ' ', code: 'Space' }); expect(call.getState().pushToTalkHeld).toBe(false); expect(m.end).toHaveBeenCalledWith('mic-1'); input.remove()
})
it('control: blur releases an established held turn', async () => { await start(); await press(); fireEvent.blur(window); expect(m.end).toHaveBeenCalledWith('mic-1') })
it('control: hidden document releases an established held turn', async () => {
  await start(); await press(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  fireEvent(document, new Event('visibilitychange')); expect(m.end).toHaveBeenCalledWith('mic-1')
})
it('control: view navigation leaves host capture and recipient intact', async () => { await start(); await press(); act(() => useUIStore.setState({ sidebarView: 'tasks' })); release(); final(); expect(m.send).toHaveBeenCalledWith('session-a', 'archive the project') })
it('control: app teardown cancels established microphone', async () => { await start(); await press(); cleanup(); expect(m.cancel).toHaveBeenCalledWith('mic-1'); expect(call.getState().status).toBe('off') })
it('control: open-mic matching segment submits, partial and foreign segment do not', async () => {
  await start(); await act(async () => { await call.getState().setMicrophoneMode('open-mic') })
  emit('onPartial', { turnId: 'mic-1', text: 'archive the' }); emit('onSegment', { turnId: 'other', text: 'archive the project', index: 0 })
  expect(m.send).not.toHaveBeenCalled(); emit('onSegment', { turnId: 'mic-1', text: 'archive the project', index: 0 }); expect(m.send).toHaveBeenCalledTimes(1)
})
it('control: selected device reaches capture without storing labels or audio', async () => { await start(); await act(async () => { await useVoiceStore.getState().setInputDevice('opaque-device-id') }); await press(); expect(m.capture).toHaveBeenCalledWith(expect.any(Object), 'opaque-device-id') })
it('rapid release/repress during initial capture acquisition leaves the latest press live', async () => {
  await start(); const pending = deferred<boolean>(); m.capture.mockReturnValueOnce(pending.promise)
  let opening!: Promise<void>; act(() => { opening = call.getState().beginPushToTalk() })
  await act(async () => { await Promise.resolve() }); release(); await press()
  await act(async () => { pending.resolve(true); await opening })
  expect(call.getState().pushToTalkHeld).toBe(true); expect(call.getState().turnId).not.toBeNull(); expect(getActiveComposer()).toBe('commander-voice')
})

import { useCommanderActivityStore } from './lib/activity/commander-activity-adapter'
import { voicePlayback } from './lib/voice-playback'
import { BargeInGate } from './lib/voice-barge-in'
function pcm(amplitude: number) { const data = new Int16Array(1600); for (let i=0;i<data.length;i++) data[i]= Math.round((i%2?1:-1)*32767*amplitude); return new Uint8Array(data.buffer) }
it('control: PTT stops reply playback and requests cancellation before opening capture', async () => {
  await start(); useCommanderActivityStore.setState({ sessions: { 'session-a': { phase: 'thinking' } as any } })
  const stop = vi.spyOn(voicePlayback, 'stop'); await press()
  expect(stop).toHaveBeenCalled(); expect(m.barge).toHaveBeenCalledWith('session-a')
  expect(m.barge.mock.invocationCallOrder[0]).toBeLessThan(m.start.mock.invocationCallOrder[0])
  useCommanderActivityStore.setState({ sessions: {} })
})
it('control: open mic reuses gate: steady quiet speaker leakage never reaches recognizer', async () => {
  await start(); await act(async () => { await call.getState().setMicrophoneMode('open-mic') })
  emit('tts:onSpeechStart', { speechId: 'reply-quiet', text: 'speaker answer' })
  const handlers = (m.capture.mock.calls[0] as any)[0]
  for (let i=0;i<50;i++) handlers.onAudio(pcm(0.01))
  expect(m.audio).not.toHaveBeenCalled()
})
it('control: open mic gate releases onset after three loud batches', async () => {
  await start(); await act(async () => { await call.getState().setMicrophoneMode('open-mic') })
  emit('tts:onSpeechStart', { speechId: 'reply-interrupt', text: 'speaker answer' })
  const handlers = (m.capture.mock.calls[0] as any)[0]
  for (let i=0;i<10;i++) handlers.onAudio(pcm(0.01))
  for (let i=0;i<3;i++) handlers.onAudio(pcm(0.1))
  expect(m.audio).toHaveBeenCalled(); expect(voicePlayback.currentSpeechId).toBeNull()
})
it('known limitation: amplitude gate accepts loud non-speech at onset, so it does not prove acoustic isolation', () => {
  const interrupted=vi.fn(); const gate=new BargeInGate({onBargeIn:interrupted}); gate.setSpeaking(true)
  const released=[gate.push(pcm(0.1)),gate.push(pcm(0.1)),gate.push(pcm(0.1))]
  expect(interrupted).toHaveBeenCalledTimes(1); expect(released[2]).toHaveLength(3)
})
it('old capture callbacks cannot push audio into a foreign replacement turn', async () => {
  await start(); await press(); const handlers = (m.capture.mock.calls[0] as any)[0]
  await act(async () => { await useVoiceStore.getState().cancel() })
  useVoiceStore.setState({ turnId: 'foreign-turn', captionOwner: 'foreign-owner' })
  handlers.onAudio(pcm(0.1))
  expect(m.audio).not.toHaveBeenCalled()
})
it('PTT worker failure remains a visible call error', async () => {
  await start(); await press()
  emit('onError', { message: 'Speech worker failed.' }); emit('onState', { state: 'idle' })
  expect(call.getState().error).toMatch(/worker failed/i)
})
import { CommanderVoiceControls } from './components/commander/CommanderVoiceControls'
import { useCommanderStore } from './stores/commander-store'
it('mode change during prepare finishes startup in the selected mode', async () => {
  const pending = deferred<void>(); useVoiceStore.setState({ initializeTts: vi.fn(() => pending.promise) })
  render(<Shell />); let starting!: Promise<void>; act(() => { starting=call.getState().start('session-a') })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await call.getState().setMicrophoneMode('open-mic') })
  await act(async () => { pending.resolve(); await starting })
  expect(call.getState().status).toBe('live'); expect(call.getState().microphoneMode).toBe('open-mic')
})
it('control: switching input device during established open mic cancels and reopens on selected device', async () => {
  await start(); useCommanderStore.setState({selectedSessionId:'session-a'}); render(<CommanderVoiceControls />)
  await act(async () => { await call.getState().setMicrophoneMode('open-mic') })
  const select=document.querySelector('#commander-input-device') as HTMLSelectElement
  select.add(new Option('USB','usb'))
  await act(async () => { fireEvent.change(select,{target:{value:'usb'}}) })
  expect(m.cancel).toHaveBeenCalledWith('mic-1'); expect(m.capture).toHaveBeenLastCalledWith(expect.any(Object),'usb')
})
it('changing device during pending open-mic acquisition cannot leave capture on the previous input', async () => {
  await start(); useCommanderStore.setState({selectedSessionId:'session-a'}); render(<CommanderVoiceControls />)
  const pending=deferred<boolean>(); m.capture.mockReturnValueOnce(pending.promise)
  let opening!:Promise<void>; act(() => { opening=call.getState().setMicrophoneMode('open-mic') })
  await act(async () => { await Promise.resolve() })
  const select=document.querySelector('#commander-input-device') as HTMLSelectElement; select.add(new Option('USB','usb'))
  await act(async () => { fireEvent.change(select,{target:{value:'usb'}}) })
  await act(async () => { pending.resolve(true); await opening })
  expect(useVoiceStore.getState().inputDeviceId).toBe('usb'); expect(m.capture).toHaveBeenLastCalledWith(expect.any(Object),'usb')
})
