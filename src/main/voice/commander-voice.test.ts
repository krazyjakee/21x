import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { CommanderEvent, CommanderMessage } from '../../shared/commander'
import { VOICE_TTS_EVENTS, type VoiceTtsVoice } from '../../shared/voice-tts'
import { CommanderVoice, commanderVoiceKey, spokenReport } from './commander-voice'
import { VoiceSpeechService } from './voice-speech-service'
import type { VoiceTtsWorkerClient } from './voice-tts-worker-client'
import type { VoiceTtsModelManager } from './voice-tts-model-manager'

/**
 * Commander voice mode (#64): the reply is spoken as it streams, reports are
 * spoken only while voice mode is on, and barge-in cancels the speech and the
 * Commander turn together. The real speech service runs over a fake worker.
 */

const VOICES: VoiceTtsVoice[] = [
  { id: 'system:Samantha', label: 'Samantha', engine: 'system', speakerId: 0, modelId: '', language: 'en-US', description: '' },
]

class FakeWorker extends EventEmitter {
  spoken: Array<{ speechId: string; sentences: string[]; open?: boolean }> = []
  appended: string[] = []
  finished: string[] = []
  cancelled: string[] = []
  load(): void {
    this.emit('status', { state: 'ready', engine: 'system', modelId: '', voiceId: '', sampleRate: 24000 })
  }
  speak(request: { speechId: string; sentences: string[]; open?: boolean }): void {
    this.spoken.push(request)
  }
  append(_speechId: string, sentences: string[]): void {
    this.appended.push(...sentences)
  }
  finish(speechId: string): void {
    this.finished.push(speechId)
  }
  cancel(speechId?: string): void {
    if (speechId) this.cancelled.push(speechId)
  }
  unload(): void {}
  stop(): void {}
  setRuntimeModulePath(): void {}
}

class FakeCommander {
  private listeners = new Set<(event: CommanderEvent) => void>()
  cancelled: string[] = []
  sent: Array<{ sessionId: string; text: string }> = []
  running = new Map<string, string>()

  onEvent(listener: (event: CommanderEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: CommanderEvent): void {
    for (const l of [...this.listeners]) l(event)
  }
  cancel(sessionId: string): boolean {
    this.cancelled.push(sessionId)
    const turnId = this.running.get(sessionId)
    if (!turnId) return false
    this.running.delete(sessionId)
    this.emit({ type: 'turn_event', sessionId, turnId, event: { type: 'done', stopReason: 'cancelled' } })
    return true
  }
  activeTurnId(sessionId: string): string | null {
    return this.running.get(sessionId) ?? null
  }
  sendUserMessage(sessionId: string, text: string): { turnId: string; message: CommanderMessage } {
    this.sent.push({ sessionId, text })
    return { turnId: 'next', message: report(sessionId, text) }
  }
}

function report(sessionId: string, content: string, over: Partial<CommanderMessage> = {}): CommanderMessage {
  return {
    id: `r-${Math.random()}`,
    session_id: sessionId,
    role: 'report',
    content,
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    is_error: false,
    project_id: 'p1',
    correlation_id: null,
    created_at: 1,
    ...over,
  }
}

function setup() {
  const worker = new FakeWorker()
  const events: Array<{ channel: string; data: unknown }> = []
  // Spoken answers are switched OFF: voice mode must not depend on that switch.
  const store = new Map<string, string>([['voice_tts_enabled', 'false']])
  const speech = new VoiceSpeechService({
    db: { getSetting: (k) => store.get(k), setSetting: (k, v) => void store.set(k, v) },
    notifyRenderer: (channel, data) => events.push({ channel, data }),
    modelRootDir: '/nowhere',
    worker: worker as unknown as VoiceTtsWorkerClient,
    models: { list: async () => [], resolve: async () => null } as unknown as VoiceTtsModelManager,
    listVoices: async () => VOICES,
  })
  const commander = new FakeCommander()
  const voice = new CommanderVoice({ commander, speech, resolveProjectName: (id) => (id === 'p1' ? 'Web' : null) })
  return { worker, events, speech, commander, voice }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function delta(commander: FakeCommander, sessionId: string, turnId: string, text: string): void {
  commander.emit({ type: 'turn_event', sessionId, turnId, event: { type: 'text_delta', text } })
}

function start(commander: FakeCommander, sessionId: string, turnId: string): void {
  commander.running.set(sessionId, turnId)
  commander.emit({ type: 'turn_started', sessionId, turnId })
}

function done(commander: FakeCommander, sessionId: string, turnId: string): void {
  commander.running.delete(sessionId)
  commander.emit({ type: 'turn_event', sessionId, turnId, event: { type: 'done', stopReason: 'end_turn' } })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('speaking the reply as it streams', () => {
  it('hands each finished sentence over and flushes the tail when the turn ends', async () => {
    const { worker, speech, commander, voice } = setup()
    await speech.prepare()
    voice.setActiveSession('s1')

    start(commander, 's1', 't1')
    await flush()
    expect(worker.spoken[0]).toMatchObject({ sentences: [], open: true })

    delta(commander, 's1', 't1', 'The web project is green. ')
    delta(commander, 's1', 't1', 'Two tasks are wai')
    await flush()
    expect(worker.appended).toEqual(['The web project is green.'])

    delta(commander, 's1', 't1', 'ting on review')
    await flush()
    // The unfinished sentence is held back until the turn ends.
    expect(worker.appended).toEqual(['The web project is green.'])

    done(commander, 's1', 't1')
    await flush()
    expect(worker.appended).toEqual(['The web project is green.', 'Two tasks are waiting on review'])
    expect(worker.finished).toEqual([worker.spoken[0].speechId])
  })

  it('releases the closing sentence of a message when a tool call follows it', async () => {
    const { worker, speech, commander, voice } = setup()
    await speech.prepare()
    voice.setActiveSession('s1')
    start(commander, 's1', 't1')
    delta(commander, 's1', 't1', 'Asking the Captain now')
    commander.emit({ type: 'turn_event', sessionId: 's1', turnId: 't1', event: { type: 'tool_call_start', id: 'c1', name: 'ask_captain', input: {} } })
    await flush()
    expect(worker.appended).toEqual(['Asking the Captain now'])
  })

  it('says nothing for a session that is not in voice mode', async () => {
    const { worker, speech, commander, voice } = setup()
    await speech.prepare()
    voice.setActiveSession('s1')
    start(commander, 's2', 't9')
    delta(commander, 's2', 't9', 'Other session. ')
    await flush()
    expect(worker.spoken).toEqual([])
  })
})

describe('reports', () => {
  it('are spoken only while voice mode is on for that session', async () => {
    const { worker, speech, commander, voice } = setup()
    await speech.prepare()

    commander.emit({ type: 'messages_appended', sessionId: 's1', messages: [report('s1', 'Deployed.')] })
    await flush()
    expect(worker.spoken).toEqual([])

    voice.setActiveSession('s1')
    commander.emit({ type: 'messages_appended', sessionId: 's2', messages: [report('s2', 'Elsewhere.')] })
    await flush()
    expect(worker.spoken).toEqual([])

    commander.emit({ type: 'messages_appended', sessionId: 's1', messages: [report('s1', 'Deployed to production.')] })
    await flush()
    expect(worker.spoken).toHaveLength(1)
    expect(worker.spoken[0].sentences.join(' ')).toBe('Report from Web. Deployed to production.')

    voice.setActiveSession(null)
    commander.emit({ type: 'messages_appended', sessionId: 's1', messages: [report('s1', 'Another.')] })
    await flush()
    expect(worker.spoken).toHaveLength(1)
  })

  it('arriving during a reply is read after it, not over it', async () => {
    const { worker, speech, commander, voice } = setup()
    await speech.prepare()
    voice.setActiveSession('s1')
    start(commander, 's1', 't1')
    delta(commander, 's1', 't1', 'Checking now. ')
    commander.emit({ type: 'messages_appended', sessionId: 's1', messages: [report('s1', 'Build passed.')] })
    await flush()
    expect(worker.spoken).toHaveLength(1)
    expect(worker.appended).toEqual(['Checking now.', 'Report from Web.', 'Build passed.'])
  })

  it('names a report whose project is unknown plainly', () => {
    expect(spokenReport(' Done. ', null)).toBe('A report arrived. Done.')
  })
})

describe('barge-in', () => {
  it('stops the speech, cancels synthesis and cancels the Commander turn', async () => {
    const { worker, speech, commander, voice, events } = setup()
    await speech.prepare()
    voice.setActiveSession('s1')
    start(commander, 's1', 't1')
    delta(commander, 's1', 't1', 'A long reply begins. ')
    await flush()
    const speechId = worker.spoken[0].speechId

    const result = voice.bargeIn('s1')
    expect(result).toEqual({ cancelled: true })
    expect(worker.cancelled).toContain(speechId)
    expect(commander.cancelled).toEqual(['s1'])
    expect(events.some((e) => e.channel === VOICE_TTS_EVENTS.speechEnd)).toBe(true)

    // Words of the cancelled turn that arrive late are never spoken.
    const appended = worker.appended.length
    delta(commander, 's1', 't1', 'More words. ')
    await flush()
    expect(worker.appended.length).toBe(appended)
    expect(worker.spoken).toHaveLength(1)
    expect(speech.streamingTaskId).toBeNull()
  })

  it('a new voice turn cancels the running reply before it is sent', async () => {
    const { speech, commander, voice } = setup()
    await speech.prepare()
    voice.setActiveSession('s1')
    start(commander, 's1', 't1')
    await voice.send('s1', 'Stop, do the other thing')
    expect(commander.cancelled).toEqual(['s1'])
    expect(commander.sent).toEqual([{ sessionId: 's1', text: 'Stop, do the other thing' }])
  })

  it('closing voice mode stops the reading', async () => {
    const { worker, speech, commander, voice } = setup()
    await speech.prepare()
    voice.setActiveSession('s1')
    start(commander, 's1', 't1')
    delta(commander, 's1', 't1', 'Reading. ')
    await flush()
    voice.setActiveSession(null)
    expect(worker.cancelled).toContain(worker.spoken[0].speechId)
    expect(speech.currentTaskId).not.toBe(commanderVoiceKey('s1'))
  })
})
