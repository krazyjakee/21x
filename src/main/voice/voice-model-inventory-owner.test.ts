import { afterEach, describe, expect, it } from 'vitest'
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { AuthenticatedSecretStorage } from '../platform/authenticated-secret-storage'
import { VoiceModelInventoryOwner, type VoiceModelInventoryOwnerOptions } from './voice-model-inventory-owner'
import { findTtsManifestEntry } from './voice-tts-manifest'

const entry = structuredClone(findTtsManifestEntry('kitten-nano-en-v0_2')!)
const fixtures: Array<{ root: string; owners: VoiceModelInventoryOwner[]; stores: AuthenticatedSecretStorage[] }> = []
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function fixture(extra: Partial<VoiceModelInventoryOwnerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), '21x-authenticated-tts-inventory-')), modelRootDir = join(root, 'models'), inventoryRootDir = join(root, 'inventories')
  mkdirSync(modelRootDir, { mode: 0o700 })
  const key = Buffer.alloc(32, 82), storage = new AuthenticatedSecretStorage(key, 'synthetic-voice-profile')
  const options = { profileRootDir: root, modelRootDir, inventoryRootDir, storage, assertCurrent() {}, ...extra }
  const owner = new VoiceModelInventoryOwner(options), records = { root, owners: [owner], stores: [storage] }; fixtures.push(records)
  const stage = mkdtempSync(join(modelRootDir, `.${entry.id}.stage-`)), payload = join(stage, 'payload'), final = join(modelRootDir, entry.id)
  mkdirSync(payload)
  for (const path of [entry.files.model, entry.files.voices, entry.files.tokens]) { mkdirSync(dirname(join(payload, path)), { recursive: true }); writeFileSync(join(payload, path), `synthetic-${path}`) }
  mkdirSync(join(payload, entry.files.dataDir), { recursive: true }); writeFileSync(join(payload, entry.files.dataDir, 'en_dict'), 'Synthetic dictionary')
  return { ...records, owner, key, storage, options, modelRootDir, inventoryRootDir, stage, payload, final,
    reopen(keyOverride = key, profile = 'synthetic-voice-profile') { const nextStorage = new AuthenticatedSecretStorage(keyOverride, profile); records.stores.push(nextStorage); const next = new VoiceModelInventoryOwner({ ...options, storage: nextStorage }); records.owners.push(next); return next },
    async publish() { const receipt = await owner.prepare(entry, payload, () => {}); await rename(payload, final); await owner.commit(entry, receipt, () => {}); await rmdir(stage); return receipt } }
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    for (const owner of item.owners) await owner.close()
    for (const storage of item.stores) storage.dispose()
    rmSync(item.root, { recursive: true, force: true })
  }
})

describe('authenticated durable TTS publication ownership', () => {
  it('uses actual AES-GCM ciphertext and exact same-key restart removal, without disposing borrowed storage', async () => {
    const value = fixture(); await value.publish()
    const path = join(value.inventoryRootDir, `${entry.id}.committed`), ciphertext = readFileSync(path)
    expect(ciphertext.subarray(0, 11).toString('ascii')).toBe('21x-secret\x01')
    expect(ciphertext.includes(Buffer.from('synthetic-'))).toBe(false); expect(ciphertext.includes(Buffer.from(value.modelRootDir))).toBe(false)
    expect(value.storage.decryptString(ciphertext)).toContain('21x:voice-model-publication:tts:v1\n')
    expect(readdirSync(value.inventoryRootDir)).toEqual([`${entry.id}.committed`])
    await value.owner.close(); expect(value.storage.isEncryptionAvailable()).toBe(true)
    const restarted = value.reopen(); await restarted.assertCommitted(entry, () => {}); await restarted.remove(entry, () => {})
    expect(existsSync(value.final)).toBe(false); expect(readdirSync(value.inventoryRootDir)).toEqual([]); expect(readdirSync(value.modelRootDir)).toEqual([])
  })
  it.each(['key', 'profile', 'tamper', 'domain', 'manifest', 'oversize', 'symlink'])('refuses %s receipt authority before changing model files', async kind => {
    const value = fixture(); await value.publish(); await value.owner.close()
    const path = join(value.inventoryRootDir, `${entry.id}.committed`)
    if (kind === 'tamper') { const data = readFileSync(path); data[data.length - 1] = data[data.length - 1]! ^ 1; writeFileSync(path, data) }
    if (kind === 'domain') writeFileSync(path, value.storage.encryptString('21x:setting:v1\n{}'))
    if (kind === 'oversize') writeFileSync(path, Buffer.alloc(1_048_641))
    if (kind === 'symlink') { renameSync(path, path + '.preserved'); symlinkSync(path + '.preserved', path) }
    const next = kind === 'key' ? value.reopen(Buffer.alloc(32, 99)) : value.reopen(undefined, kind === 'profile' ? 'foreign-profile' : undefined)
    const requested = kind === 'manifest' ? { ...entry, archive: { ...entry.archive, sha256: '0'.repeat(64) } } : entry
    await expect(next.remove(requested, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_')
    expect(readFileSync(join(value.final, entry.files.tokens), 'utf8')).toBe(`synthetic-${entry.files.tokens}`)
    expect(readdirSync(value.modelRootDir)).toEqual([entry.id])
  })
  it('rejects same-key copied receipts at a different profile or replaced physical model root', async () => {
    const first = fixture(); await first.publish(); const second = fixture()
    mkdirSync(second.inventoryRootDir); writeFileSync(join(second.inventoryRootDir, `${entry.id}.committed`), readFileSync(join(first.inventoryRootDir, `${entry.id}.committed`)))
    await rename(second.payload, second.final); await rmdir(second.stage)
    await expect(second.owner.remove(entry, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_INVALID'); expect(existsSync(second.final)).toBe(true)
    await first.owner.close(); renameSync(first.modelRootDir, first.modelRootDir + '.preserved'); mkdirSync(first.modelRootDir)
    renameSync(join(first.modelRootDir + '.preserved', entry.id), first.final)
    await expect(first.reopen().remove(entry, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_INVALID'); expect(existsSync(first.final)).toBe(true)
  })
  it.each(['extra', 'changed', 'replaced', 'link'])('preserves an %s tree without entering retirement, allowing retry after user removes extras', async kind => {
    const value = fixture(); await value.publish(); const path = join(value.final, entry.files.tokens)
    if (kind === 'extra') writeFileSync(join(value.final, 'personal.txt'), 'Keep this')
    if (kind === 'changed') writeFileSync(path, 'Changed personal content')
    if (kind === 'replaced') { renameSync(path, path + '.personal'); writeFileSync(path, `synthetic-${entry.files.tokens}`) }
    if (kind === 'link') { renameSync(path, path + '.personal'); symlinkSync(path + '.personal', path) }
    await expect(value.owner.remove(entry, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_')
    expect(existsSync(value.final)).toBe(true); expect(readdirSync(value.inventoryRootDir)).toEqual([`${entry.id}.committed`])
    if (kind === 'extra') { expect(readFileSync(join(value.final, 'personal.txt'), 'utf8')).toBe('Keep this'); await unlink(join(value.final, 'personal.txt')); await value.owner.remove(entry, () => {}); expect(existsSync(value.final)).toBe(false) }
  })
  it.each(['prepared', 'published-before-commit', 'committed-plus-prepared'])('refuses incomplete %s restart instead of inferring ownership', async phase => {
    const value = fixture(), receipt = await value.owner.prepare(entry, value.payload, () => {})
    if (phase !== 'prepared') await rename(value.payload, value.final)
    if (phase === 'committed-plus-prepared') {
      const bytes = readFileSync(join(value.inventoryRootDir, `${entry.id}.prepared`))
      await value.owner.commit(entry, receipt, () => {}); writeFileSync(join(value.inventoryRootDir, `${entry.id}.prepared`), bytes)
    }
    await value.owner.close(); const next = value.reopen()
    await expect(next.remove(entry, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_AMBIGUOUS')
    expect(existsSync(phase === 'prepared' ? value.payload : value.final)).toBe(true)
  })
  it('never adopts a historical tree without an authenticated receipt', async () => {
    const value = fixture(); await rename(value.payload, value.final); await rmdir(value.stage); mkdirSync(value.inventoryRootDir)
    await expect(value.owner.remove(entry, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_'); expect(existsSync(value.final)).toBe(true)
  })
  it('rejects publication receipt takeover and non-staged paths', async () => {
    const value = fixture(); await expect(value.owner.prepare(entry, value.modelRootDir, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_TREE_UNSAFE')
    const receipt = await value.owner.prepare(entry, value.payload, () => {}); await rename(value.payload, value.final)
    const foreign = value.reopen(); await expect(foreign.commit(entry, receipt, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_OWNER_MISMATCH')
    expect(existsSync(join(value.inventoryRootDir, `${entry.id}.prepared`))).toBe(true); expect(existsSync(value.final)).toBe(true)
  })
  it('retains an actual delayed ciphertext write through shutdown and preserves incomplete receipts', async () => {
    const entered = deferred<void>(), acknowledgement = deferred<void>()
    const value = fixture({ openFile: (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.tmp')) {
        const write = handle.write.bind(handle)
        handle.write = (async (...writeArgs: Parameters<FileHandle['write']>) => { const result = await write(...writeArgs); entered.resolve(); await acknowledgement.promise; return result }) as FileHandle['write']
      }
      return handle
    }) as typeof open })
    const operation = value.owner.prepare(entry, value.payload, () => {}), failed = operation.catch(error => error)
    await entered.promise; await expect(value.owner.close(5)).rejects.toThrow('VOICE_MODEL_INVENTORY_SHUTDOWN_INCOMPLETE'); expect(value.owner.inflightCount).toBeGreaterThan(0)
    acknowledgement.resolve(); expect(await failed).toBeInstanceOf(Error); await value.owner.close(); expect(value.owner.inflightCount).toBe(0)
    expect(existsSync(value.payload)).toBe(true); expect(readdirSync(value.inventoryRootDir).some(name => name.endsWith('.tmp'))).toBe(true)
    await expect(value.reopen().remove(entry, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_')
  })
  it('rechecks grant withdrawal after raw write and refuses durable publication', async () => {
    const entered = deferred<void>(), acknowledgement = deferred<void>(); let current = true
    const value = fixture({ openFile: (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { await sync(); entered.resolve(); await acknowledgement.promise }
      }
      return handle
    }) as typeof open })
    const operation = value.owner.prepare(entry, value.payload, () => { if (!current) throw new Error('Permission withdrawn') }), failed = operation.catch(error => error)
    await entered.promise; current = false; acknowledgement.resolve(); expect(await failed).toBeInstanceOf(Error)
    expect(existsSync(join(value.inventoryRootDir, `${entry.id}.prepared`))).toBe(false); expect(existsSync(value.payload)).toBe(true)
  })
  it('retains a rejected actual handle-close acknowledgement and retries only that exact handle', async () => {
    let rejectClose = true, handleWithFailedClose: FileHandle | undefined, calls = 0
    const value = fixture({ openFile: (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      if (!handleWithFailedClose && (args[1] as number) & constants.O_WRONLY) {
        handleWithFailedClose = handle; const close = handle.close.bind(handle)
        handle.close = async () => { calls++; if (rejectClose) throw new Error('Unacknowledged close'); await close() }
      }
      return handle
    }) as typeof open })
    await expect(value.owner.prepare(entry, value.payload, () => {})).rejects.toThrow('Unacknowledged close')
    expect(value.owner.inflightCount).toBeGreaterThan(0)
    await expect(value.owner.close()).rejects.toThrow('VOICE_MODEL_INVENTORY_SHUTDOWN_INCOMPLETE')
    expect(value.storage.isEncryptionAvailable()).toBe(true); expect(calls).toBe(2)
    rejectClose = false; await value.owner.close(); expect(calls).toBe(3); expect(value.owner.inflightCount).toBe(0)
  })
  it('refuses unsupported directory durability instead of returning a committed model', async () => {
    const value = fixture({ openFile: (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      if ((await handle.stat()).isDirectory()) handle.sync = async () => { const error = new Error('Directory sync unsupported') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error }
      return handle
    }) as typeof open })
    await expect(value.owner.prepare(entry, value.payload, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_IO_FAILED')
    expect(existsSync(value.final)).toBe(false); expect(existsSync(value.payload)).toBe(true)
  })
  it.each(['added', 'swapped'])('preserves %s user files injected during exact retirement and refuses restart replay', async kind => {
    const value = fixture(); await value.publish(); let injected = false, quarantine = ''
    const guard = () => {
      const name = readdirSync(value.modelRootDir).find(name => name.startsWith(`.${entry.id}.remove-`))
      if (!name || injected || !existsSync(join(value.modelRootDir, name, 'owned'))) return
      quarantine = join(value.modelRootDir, name); injected = true
      if (kind === 'added') writeFileSync(join(quarantine, 'owned', 'personal.txt'), 'Preserve new personal data')
      else { const path = join(quarantine, 'owned', entry.files.tokens); renameSync(path, path + '.original'); writeFileSync(path, 'Preserve replacement data') }
    }
    await expect(value.owner.remove(entry, guard)).rejects.toThrow('VOICE_MODEL_INVENTORY_')
    expect(injected).toBe(true); expect(readFileSync(join(quarantine, 'owned', kind === 'added' ? 'personal.txt' : entry.files.tokens), 'utf8')).toContain('Preserve')
    expect(existsSync(join(value.inventoryRootDir, `${entry.id}.retiring`))).toBe(true)
    await expect(value.reopen().remove(entry, () => {})).rejects.toThrow('VOICE_MODEL_INVENTORY_AMBIGUOUS')
  })
})
