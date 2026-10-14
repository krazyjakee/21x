/**
 * Lifecycle of the isolated speech worker (design §5.1).
 *
 * The client owns the child process, the audio pipe and the restart policy.
 * Nothing here decodes audio: a crash in the worker must leave main and the
 * renderer running.
 */

import { nodeWorkerRuntime } from '../node-worker-runtime'
import { fork, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { isAbsolute, join } from 'path'
import { existsSync } from 'fs'
import type { ResolvedModel } from './voice-model-manager'
import type { VoiceEngineStatus } from '../../shared/voice'

/** Release the model after this much idle time to give the memory back. */
const VOICE_IDLE_UNLOAD_MS = 5 * 60 * 1000

interface WorkerMessage {
  t: 'status' | 'partial' | 'segment' | 'final' | 'error' | 'pong'
  index?: number
  state?: string
  turnId?: string
  text?: string
  message?: string
  code?: string
  modelId?: string
  engine?: string
  loadMs?: number
  rss?: number
}

export interface VoiceWorkerClientOptions {
  scriptPath: string
  /** Actual owning bundled Node selector; portable owners never guess Node. */
  runtime: () => ReturnType<typeof nodeWorkerRuntime>
  assertModulePath?: (path: string | null) => void
}

export class VoiceWorkerClient extends EventEmitter {
  private child: ChildProcess | null = null
  private loadedModel: ResolvedModel | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private restarts = 0
  /** Absolute path of the optional runtime the user installed. */
  private modulePath: string | null = null
  /** Seconds of silence that end a sentence. */
  private endpointSilence = 1.2
  private readonly scriptPath: string
  private readonly host: VoiceWorkerClientOptions | null
  private closing = false
  private lease = 0
  private readonly children = new Map<ChildProcess, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()

  constructor(options: string | VoiceWorkerClientOptions = defaultWorkerScript()) {
    super()
    this.host = typeof options === 'string' ? null : options
    this.scriptPath = typeof options === 'string' ? options : options.scriptPath
    if (this.host && (!isAbsolute(this.scriptPath) || typeof this.host.runtime !== 'function')) throw new Error('VOICE_WORKER_HOST_INVALID')
  }
  get portable(): boolean { return this.host !== null }
  get inflightCount(): number { return this.operations.size + this.children.size }
  assertOpen(): void { if (this.closing) throw new Error('VOICE_WORKER_CLOSED') }

  /**
   * Points the worker at the runtime the user installed into the application
   * data directory. A new path stops the current process, so the next turn
   * loads the new runtime.
   */
  setRuntimeModulePath(modulePath: string | null): void {
    this.assertOpen(); this.host?.assertModulePath?.(modulePath)
    if (this.modulePath === modulePath) return
    this.modulePath = modulePath
    this.stop()
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null)
  }

  get isLoaded(): boolean {
    return Boolean(this.loadedModel)
  }

  /** Starts the worker if needed and loads a model. Idempotent per model. */
  load(model: ResolvedModel, endpointSilenceSeconds?: number): Promise<void> {
    try { this.assertOpen() } catch (error) { return Promise.reject(error) }
    const raw = this.loadOwned(model, endpointSilenceSeconds)
    this.operations.add(raw); void raw.then(() => this.operations.delete(raw), () => this.operations.delete(raw)); return raw
  }
  private async loadOwned(model: ResolvedModel, endpointSilenceSeconds?: number): Promise<void> {
    if (!existsSync(this.scriptPath)) {
      this.emit('status', {
        state: 'engine_missing',
        message: 'The voice worker was not found in this build.',
      } satisfies VoiceEngineStatus)
      return
    }
    if (this.loadedModel && this.loadedModel.dir === model.dir && this.isRunning) return
    const lease = ++this.lease
    if (!this.child && this.children.size) await Promise.allSettled([...this.children.values()])
    if (this.closing || lease !== this.lease) return
    this.endpointSilence = endpointSilenceSeconds ?? this.endpointSilence

    this.spawn()
    this.loadedModel = model
    this.emit('status', { state: 'loading' } satisfies VoiceEngineStatus)
    this.send({
      t: 'load',
      modelId: model.id,
      model: {
        encoder: model.encoder,
        decoder: model.decoder,
        joiner: model.joiner,
        tokens: model.tokens,
        // `offline` (Parakeet) builds an OfflineRecognizer; anything else the
        // streaming one. The worker defaults to streaming when this is absent.
        kind: model.kind ?? 'streaming',
      },
      endpointSilence: this.endpointSilence,
    })
  }

  /** `conversation` keeps the microphone open and emits one segment per pause. */
  startTurn(turnId: string, mode: 'dictation' | 'command' | 'conversation' = 'dictation'): void {
    this.clearIdleTimer()
    this.send({ t: 'start', turnId, mode })
  }

  /**
   * Pushes one 16 kHz mono PCM frame. Frames are length-prefixed on the pipe.
   *
   * The renderer keeps sending audio for a moment after the worker has gone —
   * it is a separate process and the news travels by IPC. Writing to that dead
   * pipe raises EPIPE, and an unhandled stream error takes the whole
   * application down. Losing a frame of audio is not worth a crash, so every
   * failure here is swallowed.
   */
  pushAudio(frame: Buffer): void {
    const stdin = this.child?.stdin
    if (this.closing || frame.length > 65536 || !stdin || stdin.destroyed || !stdin.writable || stdin.writableLength > 1_048_576) return
    const header = Buffer.alloc(4)
    header.writeUInt32LE(frame.length, 0)
    try {
      // Back-pressure is handled by the stream itself; a dropped write only
      // loses audio, it never blocks the main event loop. The callback catches
      // the failure that arrives after the write returns.
      stdin.write(Buffer.concat([header, frame]), () => {})
    } catch {
      /* the worker went away mid-turn */
    }
  }

  endTurn(turnId: string): void {
    this.send({ t: 'end', turnId })
    this.scheduleIdleUnload()
  }

  cancelTurn(turnId: string): void {
    this.send({ t: 'cancel', turnId })
    this.scheduleIdleUnload()
  }

  /** Releases the model but keeps the process, so the next turn starts sooner. */
  unload(): void {
    this.send({ t: 'unload' })
    this.loadedModel = null
  }

  stop(): void {
    this.lease++
    this.clearIdleTimer()
    this.loadedModel = null
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.kill()
    } catch {
      /* the process is already gone */
    }
    const escalation = setTimeout(() => { if (this.children.has(child)) { try { child.kill('SIGKILL') } catch { /* retain */ } } }, 200)
    void this.children.get(child)?.finally(() => clearTimeout(escalation))
  }
  async stopAcknowledged(): Promise<void> { this.stop(); await Promise.allSettled([...this.children.values()]) }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new RangeError('VOICE_WORKER_DEADLINE_INVALID')
    this.closing = true; this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([(async () => { while (this.children.size || this.operations.size) await Promise.allSettled([...this.children.values(), ...this.operations]) })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('VOICE_WORKER_DRAIN_INCOMPLETE')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }

  // ── Internals ─────────────────────────────────────────────

  /**
   * One control message to the worker.
   *
   * The channel closes as soon as the process exits, and sending on a closed
   * channel throws. Voice going quiet is acceptable; the application falling
   * over is not.
   */
  private send(message: Record<string, unknown>): void {
    if (this.closing) return
    const child = this.child
    if (!child || !child.connected) return
    try {
      child.send(message, undefined, undefined, () => {})
    } catch {
      /* the worker went away */
    }
  }

  private spawn(): void {
    if (this.isRunning) return
    if (this.closing) return
    const runtime = this.host ? this.host.runtime() : nodeWorkerRuntime()
    if (this.host && (!isAbsolute(runtime.execPath) || Object.keys(runtime.env).some(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE'))) throw new Error('VOICE_WORKER_RUNTIME_INVALID')
    const child = fork(this.scriptPath, [], {
      execPath: runtime.execPath,
      env: {
        ...runtime.env,
        // The runtime is installed on request into the application data
        // directory, so the worker loads it by absolute path.
        ...(this.modulePath ? { VOICE_ENGINE_MODULE: this.modulePath } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      execArgv: [],
    })
    this.child = child
    let settled!: () => void
    const receipt = new Promise<void>(resolve => { settled = resolve }); this.children.set(child, receipt)
    const active = () => !this.closing && this.child === child

    // Every pipe needs an error listener. Node throws an unhandled stream
    // error, which in the main process is a crash and an application restart —
    // and the audio pipe fails routinely, whenever the worker goes away while
    // the renderer is still sending.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return
        if (active()) { this.reportError('The voice worker pipe failed.', 'worker_pipe'); this.stop() }
      })
    }
    // A process that cannot be spawned emits this. Unhandled, it is fatal.
    child.on('error', () => {
      if (active()) { this.reportError('The voice worker could not be started.', 'worker_spawn'); this.stop() }
    })

    child.on('message', (raw) => { if (active()) this.onMessage(raw as WorkerMessage) })
    child.stdout?.on('data', () => { /* Drain trusted worker diagnostics without publishing them. */ })
    child.stderr?.on('data', () => { /* Native diagnostics stay off public/log channels. */ })
    child.once('close', (code) => {
      this.children.delete(child); settled()
      if (!active()) return
      const wasLoaded = this.loadedModel
      this.child = null
      this.loadedModel = null
      if (code === 0) return
      this.reportError('The voice worker stopped unexpectedly.', 'worker_exit')
      // One automatic restart. A repeated crash leaves voice off rather than
      // spawning processes in a loop.
      if (wasLoaded && this.restarts < 1) {
        this.restarts += 1
        void this.load(wasLoaded).catch(() => this.reportError('The voice worker could not restart.', 'worker_restart'))
      }
    })
  }

  private onMessage(message: WorkerMessage): void {
    if (!message || typeof message !== 'object' || typeof message.t !== 'string' || message.text !== undefined && (typeof message.text !== 'string' || message.text.length > 65536)) return
    if (message.turnId !== undefined && (typeof message.turnId !== 'string' || message.turnId.length > 128 || /[\u0000-\u001f]/.test(message.turnId))) return
    if (message.modelId !== undefined && (typeof message.modelId !== 'string' || message.modelId.length > 128 || /[\u0000-\u001f]/.test(message.modelId))) return
    if (message.engine !== undefined && (typeof message.engine !== 'string' || message.engine.length > 64 || /[\u0000-\u001f]/.test(message.engine))) return
    if (message.index !== undefined && (!Number.isSafeInteger(message.index) || message.index < 0 || message.index > 100000)) return
    switch (message.t) {
      case 'status':
        if (message.state === 'ready') {
          this.emit('status', {
            state: 'ready',
            modelId: message.modelId ?? 'unknown',
            engine: message.engine ?? 'sherpa-onnx',
          } satisfies VoiceEngineStatus)
        } else if (message.state === 'engine_missing') {
          this.loadedModel = null
          this.emit('status', {
            state: 'engine_missing',
            message: 'The local speech runtime is not installed.',
          } satisfies VoiceEngineStatus)
        } else if (message.state === 'error') {
          this.loadedModel = null
          this.emit('status', {
            state: 'error',
            message: 'The speech model failed to load.',
          } satisfies VoiceEngineStatus)
        }
        return
      case 'partial':
        if (message.turnId && message.text) this.emit('partial', message.turnId, message.text)
        return
      case 'segment':
        if (message.turnId && message.text) {
          this.emit('segment', message.turnId, message.text, message.index ?? 0)
        }
        return
      case 'final':
        if (message.turnId) this.emit('final', message.turnId, message.text ?? '')
        return
      case 'error':
        this.reportError('Speech recognition failed.', typeof message.code === 'string' && /^[a-z_]{1,64}$/.test(message.code) ? message.code : 'recognition_failed')
        return
      default:
        return
    }
  }
  private reportError(message: string, code: string): void {
    if (this.closing) return
    if (this.listenerCount('error')) this.emit('error', message, code)
    else this.emit('status', { state: 'error', message } satisfies VoiceEngineStatus)
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => this.unload(), VOICE_IDLE_UNLOAD_MS)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

/** The worker is copied next to the main bundle by `electron.vite.config.ts`. */
function defaultWorkerScript(): string {
  return join(__dirname, 'voice', 'voice-worker.js')
}
