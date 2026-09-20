import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { VOICE_TTS_EVENTS, VOICE_TTS_SETTING_KEYS, type VoiceTtsStatus, type VoiceTtsVoice } from '../../shared/voice-tts'
import {
  VoiceSpeechService,
  localVoicesForModel,
  type VoiceSpeechLifecycleOwner,
} from './voice-speech-service'
import type { VoiceTtsWorkerClient } from './voice-tts-worker-client'
import type { VoiceTtsModelManager } from './voice-tts-model-manager'

/**
 * The rules of design §5.7 live here: the reason for speaking decides whether a
 * passage is spoken, an answer is only read when the user asked for it by
 * voice, and speech stops the moment the user talks.
 */

const SYSTEM_VOICES: VoiceTtsVoice[] = [
  { id: 'system:Samantha', label: 'Samantha', engine: 'system', speakerId: 0, modelId: '', language: 'en-US', description: '' },
  { id: 'system:Anna', label: 'Anna', engine: 'system', speakerId: 0, modelId: '', language: 'de-DE', description: '' },
]

class FakeWorker extends EventEmitter {
  spoken: Array<{
    speechId: string
    sentences: string[]
    speakerId: number
    speed: number
    systemVoice?: string
    open?: boolean
  }> = []
  cancelled: string[] = []
  loads: unknown[] = []

  load(request: unknown): void {
    this.loads.push(request)
    this.emit('status', { state: 'ready', engine: 'system', modelId: '', voiceId: '', sampleRate: 24000 })
  }
  appended: string[] = []
  finished: string[] = []

  speak(request: {
    speechId: string
    sentences: string[]
    speakerId: number
    speed: number
    systemVoice?: string
    open?: boolean
  }): void {
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

function makeService(settings: Record<string, string> = {}) {
  const store = new Map(Object.entries(settings))
  const worker = new FakeWorker()
  const events: Array<{ channel: string; data: unknown }> = []
  const models = {
    list: async () => [],
    resolve: async () => null,
    install: async () => undefined,
    remove: async () => undefined,
  } as unknown as VoiceTtsModelManager

  const service = new VoiceSpeechService({
    db: {
      getSetting: (key) => store.get(key),
      setSetting: (key, value) => {
        store.set(key, value)
      },
    },
    notifyRenderer: (channel, data) => events.push({ channel, data }),
    modelRootDir: '/nowhere',
    worker: worker as unknown as VoiceTtsWorkerClient,
    models,
    listVoices: async () => SYSTEM_VOICES,
  })
  return { service, worker, events, store }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

interface SpeechServiceHarness {
  listVoices: () => Promise<VoiceTtsVoice[]>
  systemVoices: VoiceTtsVoice[]
  status: VoiceTtsStatus
  models: Pick<VoiceTtsModelManager, 'resolve'>
}

function speechHarness(service: VoiceSpeechService): SpeechServiceHarness {
  return service as unknown as SpeechServiceHarness
}

let clock = 0
beforeEach(() => {
  clock = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

describe('the speaking policy', () => {
  it('reads an agent answer only when spoken answers are on', async () => {
    const off = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'false' })
    await off.service.prepare()
    expect(await off.service.speak({ text: 'Done.', source: 'agent_answer', voiceTurnId: 't1' })).toBe(false)

    const on = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await on.service.prepare()
    expect(await on.service.speak({ text: 'Done.', source: 'agent_answer', voiceTurnId: 't1' })).toBe(true)
  })

  it('refuses an agent answer with no voice turn while the rule is on', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    expect(await service.speak({ text: 'Done.', source: 'agent_answer' })).toBe(false)
  })

  it('reads any agent answer once the rule is switched off', async () => {
    const { service } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.onlyVoiceTurns]: 'false',
    })
    await service.prepare()
    expect(await service.speak({ text: 'Done.', source: 'agent_answer' })).toBe(true)
  })

  it('reads a button press even when automatic reading is off', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'false' })
    await service.prepare()
    expect(await service.speak({ text: 'Read me.', source: 'manual' })).toBe(true)
    expect(await service.speak({ text: 'Sample.', source: 'preview' })).toBe(true)
    expect(await service.speak({ text: 'The answer.', source: 'read_last_answer' })).toBe(true)
  })

  it('says a short action result only when that switch is on', async () => {
    const off = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.speakActionResults]: 'false',
    })
    await off.service.prepare()
    expect(await off.service.speak({ text: 'Task created.', source: 'action_result' })).toBe(false)

    const on = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await on.service.prepare()
    expect(await on.service.speak({ text: 'Task created.', source: 'action_result' })).toBe(true)
  })

  it('never speaks empty text', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    expect(await service.speak({ text: '   ', source: 'manual' })).toBe(false)
  })
})

describe('answer correlation', () => {
  it('reads the answer to the question the user asked by voice', async () => {
    const { service, worker } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)

    expect(await service.speakAgentAnswer('task-1', 'The test failed.')).toBe(true)
    expect(worker.spoken).toHaveLength(1)
  })

  it('says nothing about a task the user never asked about', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)

    expect(await service.speakAgentAnswer('task-2', 'A background answer.')).toBe(false)
  })

  it('reads one answer per question, not every later answer', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)

    expect(await service.speakAgentAnswer('task-1', 'First.')).toBe(true)
    expect(await service.speakAgentAnswer('task-1', 'Second.')).toBe(false)
  })

  it('forgets a question that was never answered in time', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)
    clock += 11 * 60 * 1000

    expect(await service.speakAgentAnswer('task-1', 'Very late.')).toBe(false)
  })

  it('reads the answer to a sentence sent from a task composer', async () => {
    const { service, worker } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    // The renderer sent the spoken sentence to this task's agent.
    service.expectAnswer('task-7', 'turn-3', clock)

    expect(await service.speakAgentAnswer('task-7', 'It is fixed.')).toBe(true)
    expect(worker.spoken[0].sentences).toEqual(['It is fixed.'])
  })

  it('reads the answer when the sender could not name its task', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    // The Captain drawer sends on its own behalf, so no task is known.
    service.expectAnyAnswer('turn-4', clock)

    expect(await service.speakAgentAnswer('whichever-task', 'Done.')).toBe(true)
  })

  it('takes an unnamed answer once, not every answer after it', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnyAnswer('turn-4', clock)

    expect(await service.speakAgentAnswer('task-a', 'First.')).toBe(true)
    expect(await service.speakAgentAnswer('task-b', 'A background answer.')).toBe(false)
  })

  it('lets an unnamed answer expire quickly', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnyAnswer('turn-4', clock)
    clock += 2 * 60 * 1000

    expect(await service.speakAgentAnswer('task-a', 'Too late.')).toBe(false)
  })

  it('prefers the named task over an unnamed expectation', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-1', clock)
    service.expectAnyAnswer('turn-2', clock)

    expect(await service.speakAgentAnswer('task-1', 'The named one.')).toBe(true)
    // The unnamed one is still outstanding for whatever comes next.
    expect(await service.speakAgentAnswer('task-9', 'The next one.')).toBe(true)
  })

  /**
   * An expectation says "an answer from this task is the reply to something
   * said out loud". Typing a message makes that untrue, and without dropping
   * it the reply to what was typed is read aloud — for ten minutes after the
   * user last spoke to that task.
   */
  it('says nothing about an answer to a message that was typed', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)

    service.forgetAnswer('task-1')

    expect(await service.speakAgentAnswer('task-1', 'The reply to the typing.')).toBe(false)
  })

  /**
   * The unnamed expectation matches ANY task, so typing into one task would
   * otherwise consume the expectation armed by speaking into the drawer.
   */
  it('drops the unnamed expectation too, because it matches any task', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnyAnswer('turn-9', clock)

    service.forgetAnyAnswer()

    expect(await service.speakAgentAnswer('task-anything', 'A typed reply.')).toBe(false)
  })

  it('forgets a question when the turn is cancelled', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    service.expectAnswer('task-1', 'turn-9', clock)
    service.forgetAnswer('task-1')

    expect(await service.speakAgentAnswer('task-1', 'Dropped.')).toBe(false)
  })
})

describe('one voice at a time', () => {
  it('makes a stopped speak inert at the system-voice await boundary', async () => {
    const ready = deferred<VoiceTtsVoice[]>()
    const ctx = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    const harness = speechHarness(ctx.service)
    vi.spyOn(harness, 'listVoices').mockReturnValueOnce(ready.promise)

    const stale = ctx.service.speak({ text: 'Old action result.', source: 'action_result' })
    await Promise.resolve()
    ctx.service.stop('cancelled')
    harness.systemVoices = SYSTEM_VOICES
    harness.status = { state: 'ready', engine: 'system', modelId: '', voiceId: 'system:Samantha', sampleRate: 24000 }
    expect(await ctx.service.speak({ text: 'Replacement passage.', source: 'manual', taskId: 'commander:new' })).toBe(true)
    const replacementId = ctx.worker.spoken[0].speechId

    ready.resolve(SYSTEM_VOICES)
    expect(await stale).toBe(false)
    expect(ctx.service.currentTaskId).toBe('commander:new')
    expect(ctx.worker.spoken).toHaveLength(1)
    expect(ctx.worker.cancelled).not.toContain(replacementId)
  })

  it('makes a stopped streaming open inert at the prepare await boundary', async () => {
    const ready = deferred<VoiceTtsVoice[]>()
    const ctx = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    const harness = speechHarness(ctx.service)
    vi.spyOn(harness, 'listVoices').mockReturnValueOnce(ready.promise)

    const stale = ctx.service.beginStreamingAnswer('commander:old', undefined, 'conversation')
    await Promise.resolve()
    ctx.service.stop('cancelled')
    harness.systemVoices = SYSTEM_VOICES
    harness.status = { state: 'ready', engine: 'system', modelId: '', voiceId: 'system:Samantha', sampleRate: 24000 }
    expect(await ctx.service.beginStreamingAnswer('commander:new', undefined, 'conversation')).toBe(true)

    ready.resolve(SYSTEM_VOICES)
    expect(await stale).toBe(false)
    expect(ctx.service.currentTaskId).toBe('commander:new')
    expect(ctx.worker.spoken).toHaveLength(1)
  })

  it('does not let a rejected retired prepare report an error or stop current speech', async () => {
    const ready = deferred<VoiceTtsVoice[]>()
    const ctx = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    const harness = speechHarness(ctx.service)
    vi.spyOn(harness, 'listVoices').mockReturnValueOnce(ready.promise)
    const stale = ctx.service.speak({ text: 'Old action result.', source: 'action_result' })
    await Promise.resolve()
    ctx.service.stop('cancelled')
    harness.systemVoices = SYSTEM_VOICES
    harness.status = { state: 'ready', engine: 'system', modelId: '', voiceId: 'system:Samantha', sampleRate: 24000 }
    await ctx.service.speak({ text: 'Replacement passage.', source: 'manual' })

    ready.reject(new Error('retired enumeration failed'))
    expect(await stale).toBe(false)
    expect(ctx.service.speaking).toBe(true)
    expect(ctx.events.filter((event) =>
      event.channel === VOICE_TTS_EVENTS.speechEnd &&
      (event.data as { reason: string }).reason === 'error')).toEqual([])
  })

  it('makes a retired local-model resolution inert at its await boundary', async () => {
    const model = deferred<Awaited<ReturnType<VoiceTtsModelManager['resolve']>>>()
    const ctx = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.engine]: 'local',
      [VOICE_TTS_SETTING_KEYS.modelId]: 'kitten-nano-en-v0_2',
    })
    const harness = speechHarness(ctx.service)
    harness.systemVoices = SYSTEM_VOICES
    vi.spyOn(harness.models, 'resolve').mockReturnValueOnce(model.promise)
    const stale = ctx.service.speak({ text: 'Old local result.', source: 'action_result' })
    await Promise.resolve()

    ctx.service.stop('cancelled')
    harness.status = { state: 'ready', engine: 'local', modelId: 'kitten-nano-en-v0_2', voiceId: '', sampleRate: 24000 }
    expect(await ctx.service.speak({ text: 'Replacement passage.', source: 'manual', taskId: 'commander:new' })).toBe(true)
    const replacementId = ctx.worker.spoken[0].speechId
    model.resolve({ id: 'kitten-nano-en-v0_2' } as Awaited<ReturnType<VoiceTtsModelManager['resolve']>>)

    expect(await stale).toBe(false)
    expect(ctx.worker.loads).toEqual([])
    expect(ctx.worker.cancelled).not.toContain(replacementId)
    expect(ctx.service.currentTaskId).toBe('commander:new')
  })

  it('makes a retired hosted-engine load inert at its await boundary', async () => {
    const hosted = deferred<void>()
    const ctx = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.engine]: 'elevenlabs',
      [VOICE_TTS_SETTING_KEYS.elevenlabsDisclosure]: 'true',
      [VOICE_TTS_SETTING_KEYS.elevenlabsApiKey]: 'test-key',
    })
    const harness = speechHarness(ctx.service)
    harness.systemVoices = SYSTEM_VOICES
    vi.spyOn(ctx.service.elevenlabs, 'ensureLoaded').mockReturnValueOnce(hosted.promise)
    const stale = ctx.service.speak({ text: 'Old hosted result.', source: 'action_result' })
    await Promise.resolve()

    ctx.service.stop('cancelled')
    ctx.store.set(VOICE_TTS_SETTING_KEYS.engine, 'system')
    harness.status = { state: 'ready', engine: 'system', modelId: '', voiceId: 'system:Samantha', sampleRate: 24000 }
    expect(await ctx.service.speak({ text: 'Replacement passage.', source: 'manual', taskId: 'commander:new' })).toBe(true)
    const replacementId = ctx.worker.spoken[0].speechId
    hosted.resolve()

    expect(await stale).toBe(false)
    expect(ctx.worker.cancelled).not.toContain(replacementId)
    expect(ctx.service.currentTaskId).toBe('commander:new')
  })

  it('stops the passage being read before it starts the next one', async () => {
    const { service, worker } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    await service.speak({ text: 'First passage.', source: 'manual' })
    const first = worker.spoken[0].speechId

    await service.speak({ text: 'Second passage.', source: 'manual' })
    expect(worker.cancelled).toContain(first)
    expect(worker.spoken).toHaveLength(2)
  })

  it('stops at once when the user speaks', async () => {
    const { service, worker, events } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    await service.speak({ text: 'A long answer.', source: 'manual' })
    expect(service.speaking).toBe(true)

    service.stop('cancelled')

    expect(service.speaking).toBe(false)
    expect(worker.cancelled).toHaveLength(1)
    const end = events.filter((e) => e.channel === VOICE_TTS_EVENTS.speechEnd)
    expect(end).toHaveLength(1)
    expect((end[0].data as { reason: string }).reason).toBe('cancelled')
  })

  it('drops a sentence that belongs to a passage that was stopped', async () => {
    const { service, worker, events } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    await service.speak({ text: 'A long answer.', source: 'manual' })
    const speechId = worker.spoken[0].speechId
    service.stop('cancelled')

    worker.emit('chunk', { speechId, index: 0, pcm: Buffer.alloc(4), sampleRate: 24000, text: 'x' })

    expect(events.filter((e) => e.channel === VOICE_TTS_EVENTS.speechChunk)).toHaveLength(0)
  })

  it('reports the audio state to its listener', async () => {
    const { service, worker } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    const states: boolean[] = []
    service.setSpeakingListener((speaking) => states.push(speaking))

    await service.speak({ text: 'One.', source: 'manual' })
    worker.emit('done', worker.spoken[0].speechId, false)

    expect(states).toEqual([true, false])
  })

  it('settles the exact lifecycle when its current worker passage crashes', async () => {
    const { service, worker, events } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
    })
    await service.prepare()
    const owner = { turnId: 'turn-current', turnEpoch: 'epoch-current' }
    const states: Array<{ speaking: boolean; owner?: VoiceSpeechLifecycleOwner }> = []
    service.setSpeakingListener((speaking, lifecycleOwner) => {
      states.push({ speaking, owner: lifecycleOwner })
    })
    await service.speak(
      { text: 'Current action result.', source: 'action_result' },
      () => true,
      owner
    )
    const speechId = worker.spoken[0].speechId

    worker.emit('error', 'worker crashed', speechId)

    expect(service.speaking).toBe(false)
    expect(states).toEqual([
      { speaking: true, owner },
      { speaking: false, owner },
    ])
    expect(events.at(-1)).toMatchObject({
      channel: VOICE_TTS_EVENTS.speechEnd,
      data: { speechId, speechGeneration: expect.any(Number), reason: 'error' },
    })
  })

  it('makes stale and unowned worker errors inert after passage replacement', async () => {
    const { service, worker, events } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
    })
    await service.prepare()
    const oldOwner = { turnId: 'same-turn', turnEpoch: 'old-epoch' }
    const currentOwner = { turnId: 'same-turn', turnEpoch: 'current-epoch' }
    const states: Array<{ speaking: boolean; owner?: VoiceSpeechLifecycleOwner }> = []
    service.setSpeakingListener((speaking, owner) => states.push({ speaking, owner }))
    await service.speak(
      { text: 'Old action result.', source: 'action_result' },
      () => true,
      oldOwner
    )
    const oldSpeechId = worker.spoken[0].speechId
    await service.speak(
      { text: 'Replacement action result.', source: 'action_result' },
      () => true,
      currentOwner
    )
    const currentSpeechId = worker.spoken[1].speechId
    const endCount = events.filter((event) => event.channel === VOICE_TTS_EVENTS.speechEnd).length

    worker.emit('error', 'late old crash', oldSpeechId)
    worker.emit('error', 'unlabelled retired preparation crash')

    expect(service.speaking).toBe(true)
    expect(service.currentTaskId).toBeNull()
    expect(states).toEqual([
      { speaking: true, owner: oldOwner },
      { speaking: false, owner: oldOwner },
      { speaking: true, owner: currentOwner },
    ])
    expect(events.filter((event) => event.channel === VOICE_TTS_EVENTS.speechEnd)).toHaveLength(endCount)

    worker.emit('error', 'current crash', currentSpeechId)
    expect(service.speaking).toBe(false)
    expect(states.at(-1)).toEqual({ speaking: false, owner: currentOwner })
  })

  it('keeps one speaking lifecycle across a same-owner passage replacement', async () => {
    const { service } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
    })
    await service.prepare()
    const owner = { turnId: 'turn-current', turnEpoch: 'epoch-current' }
    const states: Array<{ speaking: boolean; owner?: VoiceSpeechLifecycleOwner }> = []
    service.setSpeakingListener((speaking, lifecycleOwner) => {
      states.push({ speaking, owner: lifecycleOwner })
    })

    await service.speak(
      { text: 'First action result.', source: 'action_result' },
      () => true,
      owner
    )
    await service.speak(
      { text: 'Second action result.', source: 'action_result' },
      () => true,
      owner
    )

    expect(states).toEqual([
      { speaking: true, owner },
      { speaking: true, owner },
    ])
  })
})

describe('what reaches the worker', () => {
  it('sends the cleaned passage, split into sentences', async () => {
    const { service, worker } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()
    await service.speak({ text: '## Result\n\nIt passed. Nothing else to do.', source: 'manual' })

    expect(worker.spoken[0].sentences).toEqual(['Result', 'It passed.', 'Nothing else to do.'])
  })

  it('sends the chosen system voice by name', async () => {
    const { service, worker } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.voiceId]: 'system:Anna',
    })
    await service.prepare()
    await service.speak({ text: 'Hello.', source: 'manual' })

    expect(worker.spoken[0].systemVoice).toBe('Anna')
  })

  it('sends the speaker index of a downloaded voice', async () => {
    const { service, worker } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.engine]: 'local',
      [VOICE_TTS_SETTING_KEYS.modelId]: 'kokoro-en-v0_19',
      [VOICE_TTS_SETTING_KEYS.voiceId]: 'local:kokoro-en-v0_19:7',
    })
    // The worker reports ready for whatever it is asked to load.
    worker.load({ engine: 'local' } as never)
    await service.speak({ text: 'Hello.', source: 'manual' })

    expect(worker.spoken[0].speakerId).toBe(7)
    expect(worker.spoken[0].systemVoice).toBeUndefined()
  })

  it('keeps a preview short whatever the reading limit says', async () => {
    const { service, worker } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.maxChars]: '2400',
    })
    await service.prepare()
    await service.speak({ text: 'word '.repeat(400), source: 'preview' })

    expect(worker.spoken[0].sentences.join(' ').length).toBeLessThanOrEqual(300)
  })
})

describe('choosing a voice', () => {
  it('falls back to an English system voice when nothing is chosen', async () => {
    const { service } = makeService()
    await service.prepare()
    expect(service.voiceId()).toBe('system:Samantha')
  })

  it('ignores a stored voice that belongs to the other engine', async () => {
    const { service } = makeService({
      [VOICE_TTS_SETTING_KEYS.engine]: 'local',
      [VOICE_TTS_SETTING_KEYS.modelId]: 'kitten-nano-en-v0_2',
      [VOICE_TTS_SETTING_KEYS.voiceId]: 'system:Samantha',
    })
    expect(service.voiceId()).toBe('local:kitten-nano-en-v0_2:1')
  })

  it('offers only the speakers the catalogue publishes', () => {
    const voices = localVoicesForModel('kokoro-en-v0_19')
    expect(voices).toHaveLength(8)
    expect(voices.map((v) => v.speakerId)).not.toContain(4)
    expect(voices.every((v) => v.engine === 'local')).toBe(true)
  })
})

describe('reading an answer as it is written', () => {
  /**
   * An agent writes an answer a few words at a time. Waiting for it to stop
   * before saying the first word puts the whole spoken answer behind the agent.
   */
  async function streaming() {
    const ctx = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await ctx.service.prepare()
    ctx.service.expectAnswer('task-1', 'turn-1', clock)
    expect(await ctx.service.beginStreamingAnswer('task-1')).toBe(true)
    return ctx
  }

  it('opens a passage before a single word has arrived', async () => {
    const { service, worker } = await streaming()

    expect(worker.spoken).toHaveLength(1)
    expect(worker.spoken[0].sentences).toEqual([])
    expect(worker.spoken[0].open).toBe(true)
    expect(service.speaking).toBe(true)
  })

  it('reads each sentence as soon as it is finished', async () => {
    const { service, worker } = await streaming()

    service.pushStreamingAnswer('task-1', [{ partId: 'part-1', content: 'The build is green' }])
    expect(worker.appended).toEqual([])

    service.pushStreamingAnswer('task-1', [{ partId: 'part-1', content: 'The build is green. Nothing else' }])
    expect(worker.appended).toEqual(['The build is green.'])

    service.pushStreamingAnswer('task-1', [{ partId: 'part-1', content: 'The build is green. Nothing else failed.' }])
    expect(worker.appended).toEqual(['The build is green.', 'Nothing else failed.'])
  })

  it('never says the same sentence twice', async () => {
    const { service, worker } = await streaming()

    for (let i = 0; i < 5; i++) {
      service.pushStreamingAnswer('task-1', [{ partId: 'part-1', content: 'One. Two. Three.' }])
    }

    expect(worker.appended).toEqual(['One.', 'Two.', 'Three.'])
  })

  it('reads on when the agent starts a new piece of the answer', async () => {
    const { service, worker } = await streaming()

    service.pushStreamingAnswer('task-1', [{ partId: 'part-1', content: 'First piece.' }])
    service.pushStreamingAnswer('task-1', [{ partId: 'part-2', content: 'Second piece.' }])

    expect(worker.appended).toEqual(['First piece.', 'Second piece.'])
  })

  /**
   * The reported bug. An agent says something, uses a tool, and says something
   * else — all in one turn. Both messages are the answer, and both are read.
   * Only the last one was, because the reader took "the newest message" and
   * the two arrived in a single transcript flush.
   */
  it('reads every message of one turn, not only the last', async () => {
    const { service, worker } = await streaming()

    service.pushStreamingAnswer('task-1', [
      { partId: 'text-1', content: 'Let me look at the test.' },
      { partId: 'text-2', content: 'It failed because the token expired.' },
    ])

    expect(worker.appended).toEqual([
      'Let me look at the test.',
      'It failed because the token expired.',
    ])
  })

  it('finishes an earlier message rather than waiting for its last word', async () => {
    const { service, worker } = await streaming()

    // "Looking now" has no full stop, but it is not the last message, so it is
    // complete and must be said rather than held.
    service.pushStreamingAnswer('task-1', [
      { partId: 'text-1', content: 'Looking now' },
      { partId: 'text-2', content: 'The token expired' },
    ])

    expect(worker.appended).toEqual(['Looking now'])
  })

  it('says each message once as the turn goes on', async () => {
    const { service, worker } = await streaming()

    service.pushStreamingAnswer('task-1', [{ partId: 'text-1', content: 'First message.' }])
    // The tool ran; now the second message arrives and the first is repeated
    // in the transcript, as it is on every change.
    service.pushStreamingAnswer('task-1', [
      { partId: 'text-1', content: 'First message.' },
      { partId: 'text-2', content: 'Second message.' },
    ])
    service.pushStreamingAnswer('task-1', [
      { partId: 'text-1', content: 'First message.' },
      { partId: 'text-2', content: 'Second message. And a third sentence.' },
    ])

    expect(worker.appended).toEqual([
      'First message.',
      'Second message.',
      'And a third sentence.',
    ])
  })

  it('reads the last words and closes when the agent stops', async () => {
    const { service, worker } = await streaming()

    service.pushStreamingAnswer('task-1', [{ partId: 'part-1', content: 'It is done' }])
    expect(worker.appended).toEqual([])

    service.pushStreamingAnswer('task-1', [{ partId: 'part-1', content: 'It is done' }], true)
    service.endStreamingAnswer('task-1')

    expect(worker.appended).toEqual(['It is done'])
    expect(worker.finished).toHaveLength(1)
  })

  it('ignores an answer from a task it is not reading', async () => {
    const { service, worker } = await streaming()

    service.pushStreamingAnswer('task-other', [{ partId: 'part-1', content: 'A background answer.' }])

    expect(worker.appended).toEqual([])
  })

  it('stops at the reading limit instead of reading for ever', async () => {
    const ctx = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.maxChars]: '40',
    })
    await ctx.service.prepare()
    ctx.service.expectAnswer('task-1', 'turn-1', clock)
    await ctx.service.beginStreamingAnswer('task-1')

    ctx.service.pushStreamingAnswer('task-1', [{ partId: 'part-1', content: 'One sentence here. Two sentence here. Three sentence here. Four here.' }])

    const spoken = ctx.worker.appended.join(' ')
    expect(spoken.length).toBeLessThanOrEqual(45)
    // And it stays stopped, however much more arrives.
    ctx.service.pushStreamingAnswer('task-1', [{ partId: 'part-1', content: 'One sentence here. Two sentence here. Three sentence here. Four here. Five here.' }])
    expect(ctx.worker.appended.join(' ').length).toBeLessThanOrEqual(45)
  })

  it('refuses to read an answer the user did not ask for', async () => {
    const { service } = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await service.prepare()

    expect(await service.beginStreamingAnswer('task-1')).toBe(false)
  })

  it('reads it when the user switched the rule off', async () => {
    const { service } = makeService({
      [VOICE_TTS_SETTING_KEYS.enabled]: 'true',
      [VOICE_TTS_SETTING_KEYS.onlyVoiceTurns]: 'false',
    })
    await service.prepare()

    expect(await service.beginStreamingAnswer('task-1')).toBe(true)
  })

  it('opens the passage once, not on every change', async () => {
    const { service, worker } = await streaming()

    expect(await service.beginStreamingAnswer('task-1')).toBe(true)
    expect(worker.spoken).toHaveLength(1)
  })
})

/**
 * Barge-in has to be final.
 *
 * The user talks over the answer, so the passage is stopped. But the agent is
 * still writing that same answer, and the interrupting sentence has just been
 * sent, which registers a fresh expectation. Without a memory of what was cut
 * off, the next transcript change opens a new passage against that expectation
 * and reads the interrupted message again from its first word.
 *
 * To the user that is 20x refusing to stop.
 */
describe('an answer the user talked over', () => {
  async function interrupted() {
    const ctx = makeService({ [VOICE_TTS_SETTING_KEYS.enabled]: 'true' })
    await ctx.service.prepare()
    ctx.service.expectAnswer('task-1', 'turn-1', clock)
    await ctx.service.beginStreamingAnswer('task-1')
    ctx.service.pushStreamingAnswer('task-1', [
      { partId: 'part-1', content: 'The build is green. Nothing else failed. ' },
    ])
    expect(ctx.worker.appended.length).toBeGreaterThan(0)

    // The user talks over it. This is what barge-in calls.
    ctx.service.interrupt()
    ctx.worker.appended = []
    ctx.worker.spoken = []

    // The interrupting sentence goes to the agent, so a new answer is expected.
    ctx.service.expectAnswer('task-1', 'turn-2', clock)
    return ctx
  }

  it('is not read again when the rest of it arrives', async () => {
    const { service, worker } = await interrupted()

    // The agent is still writing the message it was cut off in.
    await service.beginStreamingAnswer('task-1')  // no parts: the older call shape
    service.pushStreamingAnswer('task-1', [
      { partId: 'part-1', content: 'The build is green. Nothing else failed. And a third sentence.' },
    ])

    expect(worker.appended).toEqual([])
  })

  it('does not open a passage for it at all', async () => {
    const { service, worker } = await interrupted()
    const rest = [
      { partId: 'part-1', content: 'The build is green. Nothing else failed. And a third sentence.' },
    ]

    // The parts are given, so the service can see there is nothing to say.
    expect(await service.beginStreamingAnswer('task-1', rest)).toBe(false)
    service.pushStreamingAnswer('task-1', rest)

    expect(service.speaking).toBe(false)
    expect(worker.spoken).toEqual([])
  })

  it('still reads the answer to the question that interrupted it', async () => {
    const { service, worker } = await interrupted()

    // A new message of the transcript is the answer to the new question.
    await service.beginStreamingAnswer('task-1')
    service.pushStreamingAnswer('task-1', [
      { partId: 'part-1', content: 'The build is green. Nothing else failed. And a third sentence.' },
      { partId: 'part-2', content: 'Yes, I stopped. ' },
    ])

    expect(worker.appended).toEqual(['Yes, I stopped.'])
  })

  it('forgets the silenced message once the task is spoken to again', async () => {
    const { service, worker } = await interrupted()

    // A plain speak request is the user asking out loud for this message, with
    // the speak button. It was never silenced.
    expect(
      await service.speak({ text: 'The build is green.', source: 'manual', taskId: 'task-1' })
    ).toBe(true)
    expect(worker.spoken).toHaveLength(1)
  })
})
