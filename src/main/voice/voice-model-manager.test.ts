import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { VoiceModelManager, customDirKind, sha256OfFile } from './voice-model-manager'
import {
  DEFAULT_VOICE_MODEL_ID,
  PARAKEET_V3_MODEL_ID,
  VOICE_MODEL_MANIFEST,
  isManifestVerified,
  offeredManifestEntries,
} from './voice-model-manifest'
import type { VoiceModelManifestEntry, VoiceModelState } from '../../shared/voice'

const CONTENT = Buffer.from('a tiny stand-in for a speech model file')
const DIGEST = createHash('sha256').update(CONTENT).digest('hex')

function verifiedEntry(): VoiceModelManifestEntry {
  const file = (name: string) => ({
    name,
    url: `https://example.invalid/${name}`,
    sha256: DIGEST,
    sizeBytes: CONTENT.length,
  })
  return {
    id: 'test-model',
    label: 'Test model',
    description: 'A stand-in used by the tests.',
    languages: ['en'],
    license: 'Apache-2.0',
    licenseUrl: 'https://example.invalid/license',
    minMemoryBytes: 1,
    files: [file('encoder.onnx'), file('decoder.onnx'), file('joiner.onnx'), file('tokens.txt')],
    roles: {
      encoder: 'encoder.onnx',
      decoder: 'decoder.onnx',
      joiner: 'joiner.onnx',
      tokens: 'tokens.txt',
    },
  }
}

let root: string
let added: VoiceModelManifestEntry | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'voice-models-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  if (added) {
    VOICE_MODEL_MANIFEST.splice(VOICE_MODEL_MANIFEST.indexOf(added), 1)
    added = null
  }
})

function addToManifest(entry: VoiceModelManifestEntry): VoiceModelManifestEntry {
  VOICE_MODEL_MANIFEST.push(entry)
  added = entry
  return entry
}

describe('voice model manifest', () => {
  it('marks an entry without a recorded checksum as not downloadable', () => {
    for (const entry of VOICE_MODEL_MANIFEST) {
      const verified = entry.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256))
      expect(isManifestVerified(entry)).toBe(verified)
    }
  })
})

describe('VoiceModelManager', () => {
  it('refuses to download a model that has no recorded checksum', async () => {
    const entry = addToManifest({
      ...verifiedEntry(),
      id: 'unverified',
      files: verifiedEntry().files.map((f) => ({ ...f, sha256: '' })),
    })
    const fetchImpl = vi.fn()
    const manager = new VoiceModelManager({ rootDir: root, fetchImpl: fetchImpl as never })

    await expect(manager.install(entry.id)).rejects.toThrow(/checksum/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('downloads, verifies, and reports the model as installed', async () => {
    const entry = addToManifest(verifiedEntry())
    const fetchImpl = vi.fn(async () => new Response(CONTENT, { status: 200 }))
    const manager = new VoiceModelManager({ rootDir: root, fetchImpl: fetchImpl as never })

    await manager.install(entry.id)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(await manager.isInstalled(entry)).toBe(true)
    // The partial file is renamed, never left behind.
    await expect(stat(join(root, entry.id, 'encoder.onnx.part'))).rejects.toThrow()
  })

  it('deletes a file whose checksum does not match', async () => {
    const entry = addToManifest(verifiedEntry())
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('the wrong bytes'), { status: 200 }))
    const manager = new VoiceModelManager({ rootDir: root, fetchImpl: fetchImpl as never })

    await expect(manager.install(entry.id)).rejects.toThrow(/checksum mismatch/i)
    expect(await manager.isInstalled(entry)).toBe(false)
    await expect(stat(join(root, entry.id, 'encoder.onnx'))).rejects.toThrow()
  })

  it('gives the disk space back when a model is deleted', async () => {
    const entry = addToManifest(verifiedEntry())
    const manager = new VoiceModelManager({
      rootDir: root,
      fetchImpl: (async () => new Response(CONTENT, { status: 200 })) as never,
    })
    await manager.install(entry.id)
    await manager.remove(entry.id)
    expect(await manager.isInstalled(entry)).toBe(false)
    await expect(stat(join(root, entry.id))).rejects.toThrow()
  })

  it('removes every model at once', async () => {
    const entry = addToManifest(verifiedEntry())
    const manager = new VoiceModelManager({
      rootDir: root,
      fetchImpl: (async () => new Response(CONTENT, { status: 200 })) as never,
    })
    await manager.install(entry.id)
    await manager.removeAll()
    await expect(stat(root)).rejects.toThrow()
  })

  it('resolves a model directory installed by hand', async () => {
    const custom = join(root, 'hand-installed')
    await mkdir(custom, { recursive: true })
    await writeFile(join(custom, 'encoder-epoch-99.int8.onnx'), CONTENT)
    await writeFile(join(custom, 'decoder-epoch-99.onnx'), CONTENT)
    await writeFile(join(custom, 'joiner-epoch-99.int8.onnx'), CONTENT)
    await writeFile(join(custom, 'tokens.txt'), CONTENT)

    const manager = new VoiceModelManager({ rootDir: root })
    const resolved = await manager.resolve('nothing-installed', custom)
    expect(resolved).not.toBeNull()
    expect(resolved?.encoder).toContain('encoder-epoch-99.int8.onnx')
    expect(resolved?.tokens).toContain('tokens.txt')
  })

  it('tells a hand-installed Parakeet directory from a streaming one by its name', async () => {
    for (const name of ['sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'my-offline-model']) {
      const custom = join(root, name)
      await mkdir(custom, { recursive: true })
      for (const file of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
        await writeFile(join(custom, file), CONTENT)
      }
      const manager = new VoiceModelManager({ rootDir: root })
      expect((await manager.resolve('nothing-installed', custom))?.kind).toBe('offline')
    }
    expect(customDirKind('/models/sherpa-onnx-streaming-zipformer-en-2023-06-26')).toBe('streaming')
    expect(customDirKind('C:\\models\\parakeet-v3')).toBe('offline')
  })

  it('reports nothing when the directory is incomplete', async () => {
    const custom = join(root, 'incomplete')
    await mkdir(custom, { recursive: true })
    await writeFile(join(custom, 'encoder.onnx'), CONTENT)

    const manager = new VoiceModelManager({ rootDir: root })
    expect(await manager.resolve('nothing-installed', custom)).toBeNull()
  })

  it('lists a model with its size, licence, and language', async () => {
    const entry = addToManifest(verifiedEntry())
    const manager = new VoiceModelManager({ rootDir: root })
    const listed = (await manager.list()).find((m) => m.id === entry.id)
    expect(listed).toMatchObject({
      label: 'Test model',
      description: 'A stand-in used by the tests.',
      license: 'Apache-2.0',
      languages: ['en'],
      installed: false,
      downloadable: true,
      sizeBytes: CONTENT.length * 4,
    })
  })
})

describe('sha256OfFile', () => {
  it('matches the digest of the bytes on disk', async () => {
    const path = join(root, 'sample.bin')
    await writeFile(path, CONTENT)
    expect(await sha256OfFile(path)).toBe(DIGEST)
  })
})

/**
 * The lifecycle of one model as the settings page sees it:
 * not installed → downloading → verifying → ready, or → failed. The download
 * is mocked, so nothing here touches the network.
 */
describe('model lifecycle states', () => {
  function phasesSeen(states: VoiceModelState[]): string[] {
    const seen: string[] = []
    for (const state of states) {
      const phase = !state.installing ? 'idle' : (state.phase ?? 'downloading')
      if (seen.at(-1) !== phase) seen.push(phase)
    }
    return seen
  }

  it('starts as not installed and not installing', async () => {
    const entry = addToManifest(verifiedEntry())
    const manager = new VoiceModelManager({ rootDir: root })
    const listed = (await manager.list()).find((m) => m.id === entry.id)
    expect(listed).toMatchObject({ installed: false, installing: false, progress: 0, downloadable: true })
    expect(listed?.phase).toBeUndefined()
    expect(listed?.error).toBeUndefined()
  })

  it('moves through downloading and verifying to ready', async () => {
    const entry = addToManifest(verifiedEntry())
    const events: VoiceModelState[] = []
    const manager = new VoiceModelManager({
      rootDir: root,
      fetchImpl: (async () => new Response(CONTENT, { status: 200 })) as never,
      onProgress: (state) => events.push({ ...state }),
    })

    const result = await manager.install(entry.id)

    const phases = phasesSeen(events)
    expect(phases[0]).toBe('downloading')
    expect(phases.at(-1)).toBe('idle')
    // Each of the four files is verified after it lands.
    expect(phases.filter((phase) => phase === 'verifying')).toHaveLength(4)
    expect(phases.indexOf('verifying')).toBeGreaterThan(phases.indexOf('downloading'))
    expect(events.at(-1)?.installing).toBe(false)
    expect(result).toMatchObject({ id: entry.id, installed: true, installing: false, kind: 'streaming' })
    expect(result.phase).toBeUndefined()
  })

  it('reports progress as a fraction of the whole model', async () => {
    const entry = addToManifest(verifiedEntry())
    const progress: number[] = []
    let last: { installing: boolean } | undefined
    const manager = new VoiceModelManager({
      rootDir: root,
      fetchImpl: (async () => new Response(CONTENT, { status: 200 })) as never,
      onProgress: (state) => {
        last = state
        // The closing event is a state change (installing: false), not a progress step.
        if (state.installing) progress.push(state.progress)
      },
    })
    await manager.install(entry.id)
    expect(last?.installing).toBe(false)
    expect(progress[0]).toBe(0)
    expect(Math.max(...progress)).toBe(1)
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1])
  })

  it('ends as failed, with a reason the user can act on, when the download breaks', async () => {
    const entry = addToManifest(verifiedEntry())
    const events: VoiceModelState[] = []
    const manager = new VoiceModelManager({
      rootDir: root,
      fetchImpl: (async () => new Response(null, { status: 503 })) as never,
      onProgress: (state) => events.push({ ...state }),
    })

    await expect(manager.install(entry.id)).rejects.toThrow(/503.*try again/i)
    const listed = (await manager.list()).find((m) => m.id === entry.id)
    expect(listed).toMatchObject({ installed: false, installing: false })
    expect(listed?.error).toMatch(/503/)
    expect(events.at(-1)?.error).toMatch(/503/)
  })

  it('names the network when the server cannot be reached', async () => {
    const entry = addToManifest(verifiedEntry())
    const manager = new VoiceModelManager({
      rootDir: root,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as never,
    })
    await expect(manager.install(entry.id)).rejects.toThrow(/could not reach the server/i)
  })

  it('refuses a model this computer is too small for, and says by how much', async () => {
    const entry = addToManifest({ ...verifiedEntry(), minMemoryBytes: Number.MAX_SAFE_INTEGER })
    const fetchImpl = vi.fn()
    const manager = new VoiceModelManager({ rootDir: root, fetchImpl: fetchImpl as never })
    await expect(manager.install(entry.id)).rejects.toThrow(/needs about .* GB of memory and this computer has/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('clears the failure once a retry succeeds', async () => {
    const entry = addToManifest(verifiedEntry())
    let attempts = 0
    const manager = new VoiceModelManager({
      rootDir: root,
      fetchImpl: (async () => {
        attempts += 1
        return attempts === 1 ? new Response(null, { status: 500 }) : new Response(CONTENT, { status: 200 })
      }) as never,
    })
    await expect(manager.install(entry.id)).rejects.toThrow()
    const retried = await manager.install(entry.id)
    expect(retried.installed).toBe(true)
    expect(retried.error).toBeUndefined()
  })
})

/**
 * A model from an earlier release is recognised on disk, shown, and offered
 * for deletion — never for download.
 */
describe('legacy models', () => {
  const legacyEntry = () => VOICE_MODEL_MANIFEST.find((entry) => entry.legacy)!

  async function placeOnDisk(id: string, files = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']) {
    const dir = join(root, id)
    await mkdir(dir, { recursive: true })
    for (const file of files) await writeFile(join(dir, file), CONTENT)
  }

  it('flags an installed legacy catalogue entry and refuses to download it', async () => {
    const entry = legacyEntry()
    await placeOnDisk(entry.id)
    const fetchImpl = vi.fn()
    const manager = new VoiceModelManager({ rootDir: root, fetchImpl: fetchImpl as never })

    const listed = (await manager.list()).find((m) => m.id === entry.id)
    expect(listed).toMatchObject({ legacy: true, installed: true, downloadable: false, kind: 'streaming' })
    expect(await manager.listLegacyInstalled()).toHaveLength(1)

    await expect(manager.install(entry.id)).rejects.toThrow(/no longer offered.*Parakeet v3/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('still resolves an installed legacy model, so voice keeps working until it is replaced', async () => {
    const entry = legacyEntry()
    await placeOnDisk(entry.id)
    const manager = new VoiceModelManager({ rootDir: root })
    expect((await manager.resolve(entry.id))?.kind).toBe('streaming')
  })

  it('lists a directory no catalogue entry names as an older model with its size', async () => {
    await placeOnDisk('whisper-tiny-en-2024')
    const manager = new VoiceModelManager({ rootDir: root })

    const stray = (await manager.list()).find((m) => m.id === 'whisper-tiny-en-2024')
    expect(stray).toMatchObject({
      legacy: true,
      installed: true,
      downloadable: false,
      sizeBytes: CONTENT.length * 4,
    })
    expect(stray?.label).toContain('whisper-tiny-en-2024')
  })

  it('deletes an older model and gives the disk space back', async () => {
    await placeOnDisk('whisper-tiny-en-2024')
    const manager = new VoiceModelManager({ rootDir: root })
    await manager.remove('whisper-tiny-en-2024')
    await expect(stat(join(root, 'whisper-tiny-en-2024'))).rejects.toThrow()
    expect(await manager.listLegacyInstalled()).toHaveLength(0)
  })

  it('reports nothing legacy on a fresh install', async () => {
    const manager = new VoiceModelManager({ rootDir: root })
    expect(await manager.listLegacyInstalled()).toHaveLength(0)
    expect((await manager.list()).filter((m) => m.legacy && m.installed)).toHaveLength(0)
  })
})

describe('the shipped catalogue', () => {
  it('offers Parakeet v3 as the default, and nothing else', () => {
    expect(DEFAULT_VOICE_MODEL_ID).toBe(PARAKEET_V3_MODEL_ID)
    expect(VOICE_MODEL_MANIFEST[0].id).toBe(PARAKEET_V3_MODEL_ID)
    expect(offeredManifestEntries().map((entry) => entry.id)).toEqual([PARAKEET_V3_MODEL_ID])
    for (const entry of VOICE_MODEL_MANIFEST) {
      expect(isManifestVerified(entry), `${entry.id} has no checksum`).toBe(true)
      expect(entry.description.length).toBeGreaterThan(10)
      expect(entry.license).toBeTruthy()
      expect(entry.licenseUrl).toMatch(/^https:\/\//)
    }
  })

  it('describes Parakeet v3 as the model card does', () => {
    const parakeet = VOICE_MODEL_MANIFEST[0]
    expect(parakeet).toMatchObject({ kind: 'offline', license: 'CC-BY-4.0' })
    expect(parakeet.legacy).toBeFalsy()
    expect(parakeet.languages).toHaveLength(25)
    expect(parakeet.languages).toEqual(expect.arrayContaining(['en', 'de', 'fr', 'es', 'it', 'uk']))
    expect(parakeet.licenseUrl).toBe('https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3')
    for (const file of parakeet.files) {
      expect(file.url).toContain('sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
    }
    // The int8 export is about 640 MB; a wildly different size means the wrong revision.
    const total = parakeet.files.reduce((sum, f) => sum + f.sizeBytes, 0)
    expect(total).toBeGreaterThan(600_000_000)
    expect(total).toBeLessThan(700_000_000)
  })

  it('keeps every earlier model as a legacy entry, so an install of one is recognised', () => {
    const legacy = VOICE_MODEL_MANIFEST.filter((entry) => entry.legacy).map((entry) => entry.id)
    expect(legacy).toEqual([
      'sherpa-streaming-zipformer-en',
      'nemo-fast-conformer-en-480ms',
      'nemotron-streaming-en-560ms',
    ])
  })

  it('pins every download to one revision, never to a branch', () => {
    for (const entry of VOICE_MODEL_MANIFEST) {
      for (const file of entry.files) {
        expect(file.url, `${entry.id}/${file.name}`).not.toMatch(/\/resolve\/(main|master)\//)
        expect(file.url).toMatch(/\/resolve\/[a-f0-9]{40}\//)
      }
    }
  })

  it('gives every model the same four roles, so one code path loads them all', () => {
    for (const entry of VOICE_MODEL_MANIFEST) {
      const names = entry.files.map((f) => f.name)
      expect(names).toContain(entry.roles.encoder)
      expect(names).toContain(entry.roles.decoder)
      expect(names).toContain(entry.roles.joiner)
      expect(names).toContain(entry.roles.tokens)
    }
  })

  it('marks the model in use', async () => {
    const manager = new VoiceModelManager({ rootDir: root })
    const listed = await manager.list(VOICE_MODEL_MANIFEST[1].id)
    expect(listed.filter((m) => m.active)).toHaveLength(1)
    expect(listed.find((m) => m.active)?.id).toBe(VOICE_MODEL_MANIFEST[1].id)
  })
})
