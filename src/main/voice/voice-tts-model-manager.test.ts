import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'fs'
import { stat, open } from 'fs/promises'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  VoiceTtsModelManager,
  describeDownloadFailure,
  extractTarBz2,
  sha256OfFile,
  stripRoot,
  type VoiceTtsModelManagerOptions,
} from './voice-tts-model-manager'
import { findTtsManifestEntry } from './voice-tts-manifest'
import { AuthenticatedSecretStorage } from '../platform/authenticated-secret-storage'
import { VoiceModelInventoryOwner, type VoiceModelInventoryOwnerOptions } from './voice-model-inventory-owner'

/**
 * The manager writes a downloaded archive into the user's application data, so
 * the two things that matter are: nothing is unpacked unless the checksum
 * matches, and no entry can write outside the model directory.
 */

/** A two-file `.tar.bz2` built for this test, wrapped in one directory. */
const FIXTURE_TAR_BZ2 = [
  'QlpoOTFBWSZTWf9V/FwAAc3//f+8I4BQA//ifmf98P7v//BAgABALgAABAAEAAQASFADPgAAADjJgmhkMjIyaGgDQZGEA0Gj',
  'TIYhoAcZME0MhkZGTQ0AaDIwgGg0aZDENADjJgmhkMjIyaGgDQZGEA0GjTIYhoAcZME0MhkZGTQ0AaDIwgGg0aZDENAAqSQR',
  'qaT0mU9MU8k9TZA0htIADNTGiMTBNM1NPKcZoOUnjJ7z0O/St2zzrdB7DfddRcdUlfE3Dx6l8ek2DZPgLA3iiTslGwbZiXAb',
  'RQZUS4oi8UE/g3Sx8xQTY4uKuLuVpr6LX5o2wm8SxJHTKO6UTQQowLD4lOIpebx7jj1u908ROcUcRRNwTgJRK2KqqqpTWJym',
  'CbRNuunja6rs1rMG2cBpPCdrzZjMPQnqTMdyX+sm+OAn9zznIdLCqVUqhtJsaQm6WLAmgn4koTk3/F3+Tl8l3n5eDyaCd3SJ',
  'YmvC6pRLoTtqJ2OG7r4SYkxX7OOF6q+oyMsr2BOMtGYlYEuKyJt6mBM5b/jG7PlhnLEz3qwk8HDfgZ8+dKKzHKfoW6xrsCZk',
  '0Vp6UTVqpMMjIvdLNZqk3jJMgyrE05qJV+a1sUtlYlTC4wxMNfPGpnLF9tThJi8xsnVOU8phuH0nhLvQV/I8JbsHWFt4yOYu',
  'S47xxz06T0lH5ncMxeXmoZXlapeWPLOyWJ5Hbo/o3kYk5ifYTOTEntTaHrNL7zInqM49xrD2JpJmPbNftk5D1Eo8BR1j3pzE',
  '95O6apOHVrAnim4TPJSiqq/CjqJkcJMjE3TOTSTYT4TEl5LE2jMT5SxMJJiTaS0kynyE6pPGmgmYlEoTdJumdcTOLJNYmJLi',
  'a8vTmJom/KzpoJsGz1K1BrkxGtOYnTOsTaJ1ztHwJo1dfgcS3RazeNY1hrzbJuk4znG4Nkc4o+JROgc46BcH/i7kinChIf6r',
  '+Lg=',
].join('')

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '20x-tts-models-'))
})

describe('portable local synthesis model ownership', () => {
  const id = 'kitten-nano-en-v0_2'
  // Strict portable archives contain the exact reviewed root, without macOS metadata outside it.
  const payload = Buffer.from('QlpoOTFBWSZTWR0ZuiEAAOt/gMmAAQBAA/+AECEAQP6p3sAESDAAttQlTUT0Jk9BGmEzQBM0CUSmT1HomCYEwBMEBVQppoyNAAMg0yaB+2cqwEg4Hy1QRO7UQRCVrZmDBwELFfUHgnIQRCNJeSK7O616mnjGGRVQhBFEQdL2tYChYTfrkGpag1gz6LgIiMhjeFaoDrTU+CRc0L1q7Lg82SJKlCthopRq6qCcTHw8vHIbuSAiBnLgd76SawFB2LuSKcKEgOjN0Qg=', 'base64')
  function portable(options: Partial<VoiceTtsModelManagerOptions> = {}) {
    // Synthetic archive exercises the real hash, reader, extractor, publication
    // and removal. It is not a speech-model or live-download acceptance claim.
    const entry = findTtsManifestEntry(id)!, original = structuredClone(entry)
    entry.archive.sha256 = createHash('sha256').update(payload).digest('hex')
    entry.archive.sizeBytes = payload.length; entry.archive.rootDir = 'wrapper'
    entry.files = { model: 'tokens.txt', voices: 'tokens.txt', tokens: 'tokens.txt', dataDir: 'espeak-ng-data' }
    try { return new VoiceTtsModelManager({ rootDir: root, host: { downloads: 'enabled', inventory: 'memory-only-fixture', assertCurrent() {}, beforeRequest() {} }, retry: { attempts: 1, baseDelayMs: 0 }, fetchImpl: (async () => new Response(new Uint8Array(payload))) as typeof fetch, ...options }) }
    finally { Object.assign(entry, original) }
  }
  function durable(openFile?: VoiceModelInventoryOwnerOptions['openFile']) {
    const modelRootDir = join(root, 'models'), inventoryRootDir = join(root, 'inventories')
    mkdirSync(modelRootDir)
    const storage = new AuthenticatedSecretStorage(Buffer.alloc(32, 74), 'synthetic-model-manager'), entry = findTtsManifestEntry(id)!, original = structuredClone(entry)
    entry.archive.sha256 = createHash('sha256').update(payload).digest('hex'); entry.archive.sizeBytes = payload.length; entry.archive.rootDir = 'wrapper'
    entry.files = { model: 'tokens.txt', voices: 'tokens.txt', tokens: 'tokens.txt', dataDir: 'espeak-ng-data' }
    try {
      const options = { profileRootDir: root, modelRootDir, inventoryRootDir, storage, openFile, assertCurrent() {} }
      const inventory = new VoiceModelInventoryOwner(options)
      const manager = portable({ rootDir: modelRootDir, host: { downloads: 'enabled', inventory, assertCurrent() {}, beforeRequest() {} } })
      return { manager, inventory, storage, options, synthetic: structuredClone(entry) }
    } finally { Object.assign(entry, original) }
  }
  it('requires an explicit durable owner or fixture marker instead of silently choosing in-memory authority', () => {
    expect(() => new VoiceTtsModelManager({ rootDir: root, host: { downloads: 'enabled', assertCurrent() {}, beforeRequest() {} } as unknown as VoiceTtsModelManagerOptions['host'] })).toThrow('VOICE_TTS_INVENTORY_OWNER_REQUIRED')
  })
  it('composes real publication/receipt cleanup with authenticated same-key restart deletion', async () => {
    const value = durable()
    try {
      expect((await value.manager.install(id)).installed).toBe(true)
      expect(readdirSync(value.options.modelRootDir)).toEqual([id]); expect(readdirSync(value.options.inventoryRootDir)).toEqual([`${id}.committed`])
      await value.manager.close(); expect(value.storage.isEncryptionAvailable()).toBe(true)
      const entry = findTtsManifestEntry(id)!, original = structuredClone(entry); Object.assign(entry, value.synthetic)
      let restarted: VoiceTtsModelManager
      try { const inventory = new VoiceModelInventoryOwner(value.options); restarted = portable({ rootDir: value.options.modelRootDir, host: { downloads: 'enabled', inventory, assertCurrent() {}, beforeRequest() {} } }) }
      finally { Object.assign(entry, original) }
      try { await restarted.remove(id); expect(readdirSync(value.options.modelRootDir)).toEqual([]); expect(readdirSync(value.options.inventoryRootDir)).toEqual([]) }
      finally { await restarted.close() }
    } finally { await value.manager.close(); value.storage.dispose() }
  })
  it('keeps model shutdown blocked by an unacknowledged actual inventory handle close', async () => {
    let rejectClose = true, captured = false
    const value = durable((async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      if (!captured && String(args[0]).endsWith('.tmp')) { captured = true; const close = handle.close.bind(handle); handle.close = async () => { if (rejectClose) throw new Error('Raw close not acknowledged'); await close() } }
      return handle
    }) as typeof open)
    try {
      await expect(value.manager.install(id)).rejects.toThrow('Raw close not acknowledged'); expect(value.inventory.inflightCount).toBeGreaterThan(0)
      await expect(value.manager.close()).rejects.toThrow('VOICE_TTS_MODELS_SHUTDOWN_INCOMPLETE'); expect(value.storage.isEncryptionAvailable()).toBe(true)
      rejectClose = false; await value.manager.close(); expect(value.inventory.inflightCount).toBe(0)
      expect(readdirSync(value.options.modelRootDir).some(name => name.includes('.stage-'))).toBe(true)
      expect(readdirSync(value.options.modelRootDir).some(name => name.endsWith('.install-lock'))).toBe(false)
    } finally { rejectClose = false; await value.manager.close(); value.storage.dispose() }
  })
  it('publishes a checksummed contained tree and removes only its own exact inventory', async () => {
    const manager = portable()
    try {
      expect((await manager.install(id)).installed).toBe(true)
      expect(readFileSync(join(root, id, 'tokens.txt'), 'utf8')).toBe('a b c')
      expect(readdirSync(root)).toEqual([id])
      await manager.remove(id); expect(existsSync(join(root, id))).toBe(false)
    } finally { await manager.close() }
  })
  it.each(['extra', 'changed', 'historical'])('preserves %s bytes rather than adopting a directory for deletion', async kind => {
    const manager = portable()
    try {
      await manager.install(id)
      const path = join(root, id)
      if (kind === 'extra') writeFileSync(join(path, 'personal-notes.txt'), 'Keep this')
      if (kind === 'changed') writeFileSync(join(path, 'tokens.txt'), 'x y z')
      const remover = kind === 'historical' ? portable() : manager
      try { await expect(remover.remove(id)).rejects.toThrow('VOICE_TTS_MODEL_REMOVAL_UNOWNED'); expect(existsSync(path)).toBe(true); if (kind === 'extra') expect(readFileSync(join(path, 'personal-notes.txt'), 'utf8')).toBe('Keep this') }
      finally { if (remover !== manager) await remover.close() }
    } finally { await manager.close() }
  })
  it('refuses symlinked and incomplete namespaces and preserves unrelated root files', async () => {
    const manager = portable(), outside = join(root, 'unrelated')
    mkdirSync(outside); writeFileSync(join(outside, 'personal.txt'), 'Keep')
    symlinkSync(outside, join(root, id), 'dir')
    try { await expect(manager.install(id)).rejects.toThrow('VOICE_TTS_MODEL_NAMESPACE_AMBIGUOUS'); await expect(manager.remove(id)).rejects.toThrow('VOICE_TTS_MODEL_PATH_UNSAFE'); expect(readFileSync(join(outside, 'personal.txt'), 'utf8')).toBe('Keep') }
    finally { await manager.close() }
  })
  it('refuses unavailable downloads and unknown removals before filesystem/network effects', async () => {
    const fetcher = vi.fn<typeof fetch>(), path = join(root, 'not-created')
    const manager = portable({ rootDir: path, fetchImpl: fetcher, host: { downloads: 'disabled', inventory: 'memory-only-fixture', assertCurrent() {}, beforeRequest() { throw new Error('Unexpected request') } } })
    try { await expect(manager.install(id)).rejects.toThrow('VOICE_TTS_DOWNLOAD_UNAVAILABLE'); await expect(manager.remove('../unrelated')).rejects.toThrow('Unknown voice model'); expect(fetcher).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false) }
    finally { await manager.close() }
  })
  it('retains an ignored fetch cancellation and private stage until raw response cleanup finishes', async () => {
    let resolveResponse!: (value: Response) => void
    let announceStarted!: () => void
    const started = new Promise<void>(resolve => { announceStarted = resolve })
    // The fetch intentionally ignores AbortSignal, representing accepted raw work.
    const fetcher = vi.fn<typeof fetch>(() => { announceStarted(); return new Promise<Response>(resolve => { resolveResponse = resolve }) })
    const manager = portable({ fetchImpl: fetcher })
    const installation = manager.install(id); const failure = installation.catch(error => error)
    await started
    await expect(manager.close(5)).rejects.toThrow('VOICE_TTS_MODELS_SHUTDOWN_INCOMPLETE')
    expect(manager.inflightCount).toBeGreaterThan(0); expect(readdirSync(root).some(name => name.includes('.stage-'))).toBe(true)
    resolveResponse(new Response(new Uint8Array(payload))); expect(await failure).toBeInstanceOf(Error)
    await manager.close(); expect(manager.inflightCount).toBe(0); expect(readdirSync(root)).toEqual([])
  })
  it('rechecks management authority after raw download and never publishes after withdrawal', async () => {
    let current = true, resolveResponse!: (response: Response) => void, start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const manager = portable({ fetchImpl: (() => { start(); return new Promise(resolve => { resolveResponse = resolve }) }) as typeof fetch })
    const install = manager.runManagementMutation(() => manager.install(id), () => { if (!current) throw new Error('Permission withdrawn') })
    const failure = install.catch(error => error); await started; current = false; resolveResponse(new Response(new Uint8Array(payload)))
    expect(await failure).toBeInstanceOf(Error); expect(existsSync(join(root, id))).toBe(false)
    await manager.close(); expect(readdirSync(root)).toEqual([])
  })
  it('rejects archive bytes beyond the fixed manifest rather than publishing truncated output', async () => {
    const manager = portable({ fetchImpl: (async () => new Response(new Uint8Array(Buffer.concat([payload, Buffer.from('extra')])))) as typeof fetch })
    try { await expect(manager.install(id)).rejects.toThrow(); expect(existsSync(join(root, id))).toBe(false); expect(readdirSync(root)).toEqual([]) }
    finally { await manager.close() }
  })
  it('keeps a rejected body reader and private stage owned until actual cancel acknowledgement', async () => {
    let cancelled!: () => void, release!: () => void
    const enteredCancel = new Promise<void>(resolve => { cancelled = resolve })
    const closedReader = new Promise<void>(resolve => { release = resolve })
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(payload.length + 1)) }, cancel() { cancelled(); return closedReader } })
    const manager = portable({ fetchImpl: (async () => new Response(stream)) as typeof fetch })
    const install = manager.install(id), failure = install.catch(error => error)
    await enteredCancel
    await expect(manager.close(5)).rejects.toThrow('VOICE_TTS_MODELS_SHUTDOWN_INCOMPLETE')
    expect(manager.inflightCount).toBeGreaterThan(0); expect(readdirSync(root).some(name => name.includes('.stage-'))).toBe(true)
    release(); expect(await failure).toBeInstanceOf(Error); await manager.close(); expect(readdirSync(root)).toEqual([])
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('stripRoot', () => {
  it('drops the single wrapping directory', () => {
    expect(stripRoot('kokoro-int8-en-v0_19/model.int8.onnx')).toBe('model.int8.onnx')
    expect(stripRoot('root/espeak-ng-data/en_dict')).toBe(join('espeak-ng-data', 'en_dict'))
  })

  it('refuses an entry that climbs out of the directory', () => {
    expect(stripRoot('root/../../etc/passwd')).toBeNull()
    expect(stripRoot('../evil')).toBeNull()
  })

  it('refuses an absolute entry', () => {
    expect(stripRoot('/etc/passwd')).toBeNull()
    expect(stripRoot('C:\\Windows\\system32')).toBeNull()
  })

  it('skips the wrapping directory itself', () => {
    expect(stripRoot('root/')).toBeNull()
    expect(stripRoot('root')).toBeNull()
  })
})

describe('install', () => {
  it('refuses a voice whose checksum is not recorded', async () => {
    const manager = new VoiceTtsModelManager({ rootDir: root })
    await expect(manager.install('not-a-voice')).rejects.toThrow(/Unknown voice model/)
  })

  it('refuses bytes that do not match the recorded checksum', async () => {
    const manager = new VoiceTtsModelManager({
      rootDir: root,
      fetchImpl: (async () =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch,
    })
    await expect(manager.install('kitten-nano-en-v0_2')).rejects.toThrow(/did not match its checksum/)
    // Nothing usable is left behind.
    expect(await manager.resolve('kitten-nano-en-v0_2')).toBeNull()
  })

  it('reports a voice as not installed until every file is there', async () => {
    const manager = new VoiceTtsModelManager({ rootDir: root })
    const dir = join(root, 'kitten-nano-en-v0_2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'model.fp16.onnx'), 'x')
    expect(await manager.resolve('kitten-nano-en-v0_2')).toBeNull()

    writeFileSync(join(dir, 'voices.bin'), 'x')
    writeFileSync(join(dir, 'tokens.txt'), 'x')
    mkdirSync(join(dir, 'espeak-ng-data'), { recursive: true })
    const resolved = await manager.resolve('kitten-nano-en-v0_2')
    expect(resolved?.family).toBe('kitten')
    expect(resolved?.model).toBe(join(dir, 'model.fp16.onnx'))
    expect(resolved?.dataDir).toBe(join(dir, 'espeak-ng-data'))
  })

  it('lists a voice with its size, licence and speaker count', async () => {
    const manager = new VoiceTtsModelManager({ rootDir: root })
    const states = await manager.list('kokoro-en-v0_19')
    const kokoro = states.find((s) => s.id === 'kokoro-en-v0_19')
    expect(kokoro?.active).toBe(true)
    expect(kokoro?.installed).toBe(false)
    expect(kokoro?.downloadable).toBe(true)
    expect(kokoro?.speakerCount).toBe(8)
    expect(kokoro?.license).toBe('Apache-2.0')
  })

  it('gives the disk space back when a voice is deleted', async () => {
    const manager = new VoiceTtsModelManager({ rootDir: root })
    const dir = join(root, 'kitten-nano-en-v0_2')
    mkdirSync(join(dir, 'espeak-ng-data'), { recursive: true })
    writeFileSync(join(dir, 'model.fp16.onnx'), 'x')
    await manager.remove('kitten-nano-en-v0_2')
    expect(existsSync(dir)).toBe(false)
  })
})

describe('extractTarBz2', () => {
  it('rejects out-of-root metadata through the owned extraction promise without an unhandled entry error', async () => {
    const archive = join(root, 'strict-fixture.tar.bz2'), target = join(root, 'strict-output')
    writeFileSync(archive, Buffer.from(FIXTURE_TAR_BZ2, 'base64'))
    await expect(extractTarBz2(archive, target, undefined, undefined, { rootName: 'wrapper', maxBytes: 1024 * 1024, beforeWrite() {} })).rejects.toThrow('VOICE_TTS_ARCHIVE_UNSAFE')
    expect(existsSync(join(root, '._wrapper'))).toBe(false)
  })
  it('unpacks a real bzip2 archive and drops the wrapping directory', async () => {
    const archive = join(root, 'fixture.tar.bz2')
    writeFileSync(archive, Buffer.from(FIXTURE_TAR_BZ2, 'base64'))
    const target = join(root, 'out')

    await extractTarBz2(archive, target)

    expect(readFileSync(join(target, 'tokens.txt'), 'utf8')).toBe('a b c')
    expect(readFileSync(join(target, 'espeak-ng-data', 'en_dict'), 'utf8')).toBe('dict')
    // The wrapping directory is gone, so the worker reads a fixed layout.
    expect(existsSync(join(target, 'wrapper'))).toBe(false)
  })
})

describe('sha256OfFile', () => {
  it('hashes a file the same way the catalogue records it', async () => {
    const file = join(root, 'x.bin')
    writeFileSync(file, 'abc')
    expect(await sha256OfFile(file)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})

describe('a dropped connection', () => {
  /**
   * A download this size drops part of the way through. Measured in the
   * Electron main process, the 26 MB archive dropped at 19.5 MB and at 8.8 MB
   * on consecutive attempts, through both network stacks. A single-shot fetch
   * reports that to the user as "TypeError: terminated".
   */
  const PART = 'kitten-nano-en-v0_2.tar.bz2.part'

  function dropped(bytes: number, status: number): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes))
        },
        pull(controller) {
          controller.error(
            Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') })
          )
        },
      }),
      { status }
    )
  }

  /** The offset a request asks to resume from, or 0 for a whole file. */
  function rangeOffset(headers: Record<string, string> | undefined): number {
    const value = headers?.Range
    return value ? Number(/^bytes=(\d+)-$/.exec(value)?.[1] ?? -1) : 0
  }

  async function partSize(): Promise<number> {
    return (await stat(join(root, PART)).catch(() => null))?.size ?? 0
  }

  it('asks for the rest, never for the whole file again', async () => {
    const asked: number[] = []
    const onDisk: number[] = []
    const manager = new VoiceTtsModelManager({
      rootDir: root,
      retry: { attempts: 3, baseDelayMs: 1 },
      fetchImpl: (async (_url: string, init: { headers: Record<string, string> }) => {
        asked.push(rangeOffset(init.headers))
        onDisk.push(await partSize())
        return dropped(1024, asked.length === 1 ? 200 : 206)
      }) as unknown as typeof fetch,
    })

    await expect(manager.install('kitten-nano-en-v0_2')).rejects.toThrow()

    expect(asked).toHaveLength(3)
    // The first attempt takes the whole file; each later one resumes from
    // exactly what is already on disk.
    expect(asked[0]).toBe(0)
    expect(asked[1]).toBe(onDisk[1])
    expect(asked[2]).toBe(onDisk[2])
  })

  it('tells the user in words, never as "TypeError: terminated"', async () => {
    const manager = new VoiceTtsModelManager({
      rootDir: root,
      retry: { attempts: 2, baseDelayMs: 1 },
      fetchImpl: (async () => dropped(512, 206)) as unknown as typeof fetch,
    })

    await expect(manager.install('kitten-nano-en-v0_2')).rejects.toThrow(
      /could not be downloaded after 2 attempts: the connection closed early/
    )
    await expect(manager.install('kitten-nano-en-v0_2')).rejects.not.toThrow(/TypeError/)
  })

  it('completes as soon as an attempt gets through', async () => {
    const entry = findTtsManifestEntry('kitten-nano-en-v0_2')
    const payload = Buffer.from(FIXTURE_TAR_BZ2, 'base64')
    // The manifest checksum belongs to the real 26 MB archive, so this test
    // points the entry at the fixture. Every other step is the real code path.
    const original = { sha256: entry!.archive.sha256, sizeBytes: entry!.archive.sizeBytes }
    entry!.archive.sha256 = createHash('sha256').update(payload).digest('hex')
    entry!.archive.sizeBytes = payload.length

    let attempts = 0
    const manager = new VoiceTtsModelManager({
      rootDir: root,
      retry: { attempts: 4, baseDelayMs: 1 },
      fetchImpl: (async (_url: string, init: { headers: Record<string, string> }) => {
        attempts += 1
        // The server honours the range, exactly as the real one does.
        const from = rangeOffset(init.headers)
        if (attempts < 3) return dropped(32, from > 0 ? 206 : 200)
        return new Response(payload.subarray(from), { status: from > 0 ? 206 : 200 })
      }) as unknown as typeof fetch,
    })

    try {
      const state = await manager.install('kitten-nano-en-v0_2')

      expect(state.installed).toBe(true)
      expect(attempts).toBe(3)
      expect(readFileSync(join(root, 'kitten-nano-en-v0_2', 'tokens.txt'), 'utf8')).toBe('a b c')
      // The archive is not kept once it is unpacked.
      expect(existsSync(join(root, 'kitten-nano-en-v0_2.tar.bz2'))).toBe(false)
      expect(existsSync(join(root, PART))).toBe(false)
    } finally {
      entry!.archive.sha256 = original.sha256
      entry!.archive.sizeBytes = original.sizeBytes
    }
  })

  it('stops retrying when the user cancels', async () => {
    let attempts = 0
    const manager: VoiceTtsModelManager = new VoiceTtsModelManager({
      rootDir: root,
      retry: { attempts: 5, baseDelayMs: 1 },
      fetchImpl: (async () => {
        attempts += 1
        manager.cancel('kitten-nano-en-v0_2')
        return dropped(128, 206)
      }) as unknown as typeof fetch,
    })

    await expect(manager.install('kitten-nano-en-v0_2')).rejects.toThrow(/cancelled/)
    expect(attempts).toBe(1)
  })
})

describe('describeDownloadFailure', () => {
  it('turns a terminated fetch into a sentence', () => {
    const err = Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') })
    expect(describeDownloadFailure(err)).toBe('the connection closed early (other side closed)')
  })

  it('keeps a reason that already reads well', () => {
    expect(describeDownloadFailure(new Error('the server answered 404'))).toBe('the server answered 404')
  })

  it('copes with something that is not an error at all', () => {
    expect(describeDownloadFailure('odd')).toBe('odd')
  })
})
