import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { ClaudePluginManager, type PluginOperations } from './claude-plugin-manager'
import type { MarketplaceCatalog } from './claude-plugins/sources'

const catalog: MarketplaceCatalog = { name: 'fixture', owner: { name: 'fixture' }, plugins: [{ name: 'fixture-plugin', source: { url: 'https://fixture.invalid/plugin.json' } }] }
function gate<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('portable plugin manager lifetime', () => {
  let source: ReturnType<typeof createPortableDbFixture>, root: string, owners: ClaudePluginManager[]
  beforeEach(() => { source = createPortableDbFixture(); root = mkdtempSync(join(tmpdir(), '21x-plugin-owner-')); owners = [] })
  afterEach(async () => {
    await Promise.all(owners.map(owner => owner.close()))
    source.rawDb.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.restoreAllMocks()
  })
  function own(operations?: PluginOperations): ClaudePluginManager {
    const owner = new ClaudePluginManager(source.db, root, operations)
    owners.push(owner)
    return owner
  }

  it('requires an explicit absolute profile without accessing the database on invalid input', () => {
    const sql = vi.spyOn(source.rawDb, 'prepare')
    expect(() => new ClaudePluginManager(source.db, 'relative')).toThrow('must be absolute')
    expect(sql).not.toHaveBeenCalled()
  })

  it('joins an abort-ignoring catalog and refuses all later source access', async () => {
    const catalogGate = gate<MarketplaceCatalog>()
    const fetchCatalog = vi.fn(() => catalogGate.promise), owner = own({ fetchCatalog, download: vi.fn() })
    const sourceId = owner.getMarketplaceSources()[0].id
    const result = owner.fetchMarketplaceCatalog(sourceId)
    const rejected = expect(result).rejects.toThrow('PLUGIN_MANAGER_CLOSED')
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledOnce())
    await expect(owner.close(5)).rejects.toThrow('PLUGIN_SHUTDOWN_INCOMPLETE')
    const sql = vi.spyOn(source.rawDb, 'prepare')
    expect(() => owner.getInstalledPlugins()).toThrow('PLUGIN_MANAGER_CLOSED')
    expect(() => owner.addMarketplaceSource({ name: 'late', source_url: 'late' })).toThrow('PLUGIN_MANAGER_CLOSED')
    catalogGate.resolve(catalog)
    await rejected; await owner.close()
    expect(sql).not.toHaveBeenCalled()
  })

  it('retains an accepted download and late filesystem completion without publishing a plugin', async () => {
    const done = gate<void>()
    const download = vi.fn<PluginOperations['download']>(async () => {
      await done.promise
      const dir = join(root, 'fixture-plugin'); mkdirSync(dir)
      writeFileSync(join(dir, 'fixture.txt'), 'owned fixture')
      return dir
    })
    const owner = own({ fetchCatalog: async () => catalog, download })
    const sourceId = owner.getMarketplaceSources()[0].id
    await owner.fetchMarketplaceCatalog(sourceId)
    const result = owner.installPlugin('fixture-plugin', sourceId)
    const rejected = expect(result).rejects.toThrow('PLUGIN_MANAGER_CLOSED')
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
    await expect(owner.close(5)).rejects.toThrow('PLUGIN_SHUTDOWN_INCOMPLETE')
    expect(download.mock.calls[0][5].aborted).toBe(true)
    const sql = vi.spyOn(source.rawDb, 'prepare')
    done.resolve()
    await rejected; await owner.close()
    expect(sql).not.toHaveBeenCalled()
    sql.mockRestore()
    expect(existsSync(join(root, 'fixture-plugin', 'fixture.txt'))).toBe(true)
    expect(source.db.getInstalledPlugins()).toHaveLength(0)
  })

  it('fences queued discovery before SQL and stops a running scan before later marketplaces', async () => {
    const catalogGate = gate<MarketplaceCatalog>()
    const fetchCatalog = vi.fn(() => catalogGate.promise), owner = own({ fetchCatalog, download: vi.fn() })
    const scan = owner.discoverPlugins()
    const rejected = expect(scan).rejects.toThrow('PLUGIN_MANAGER_CLOSED')
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledOnce())
    owner.shutdown()
    const sql = vi.spyOn(source.rawDb, 'prepare')
    catalogGate.resolve(catalog)
    await rejected; await owner.close()
    expect(fetchCatalog).toHaveBeenCalledOnce(); expect(sql).not.toHaveBeenCalled()
    sql.mockRestore()
    const queued = own({ fetchCatalog: vi.fn(), download: vi.fn() })
    const queuedResult = queued.discoverPlugins()
    queued.shutdown()
    const noSql = vi.spyOn(source.rawDb, 'prepare')
    await expect(queuedResult).rejects.toThrow('PLUGIN_MANAGER_CLOSED')
    await queued.close()
    expect(noSql).not.toHaveBeenCalled()
  })

  it('prevents concurrent and cross-marketplace installs from overwriting the same plugin directory', async () => {
    const done = gate<string>(), download = vi.fn(() => done.promise)
    const owner = own({ fetchCatalog: async () => catalog, download })
    const [first, second] = owner.getMarketplaceSources()
    await owner.fetchMarketplaceCatalog(first.id); await owner.fetchMarketplaceCatalog(second.id)
    const accepted = owner.installPlugin('fixture-plugin', first.id)
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
    await expect(owner.installPlugin('fixture-plugin', second.id)).rejects.toThrow('already in progress')
    const dir = join(root, 'fixture-plugin'); mkdirSync(dir)
    done.resolve(dir)
    expect((await accepted).name).toBe('fixture-plugin')
    await expect(owner.installPlugin('fixture-plugin', second.id)).rejects.toThrow('already installed')
    expect(download).toHaveBeenCalledOnce()
  })

  it('rejects path-shaped names before download or uninstall resource changes', async () => {
    const download = vi.fn(), owner = own({ fetchCatalog: async () => catalog, download })
    await expect(owner.installPlugin('../outside', 'fixture')).rejects.toThrow('Invalid plugin directory name')
    expect(download).not.toHaveBeenCalled()
    const record = source.db.createInstalledPlugin({ name: '../outside', marketplace_id: owner.getMarketplaceSources()[0].id })
    await expect(owner.uninstallPlugin(record.id)).rejects.toThrow('Invalid plugin directory name')
    expect(source.db.getInstalledPlugin(record.id)).toBeDefined()
  })

  it('cancels a late real downloader response before fallback requests, file writes or DB publication', async () => {
    const responseGate = gate<Response>(), cancel = vi.fn()
    const http = vi.fn().mockResolvedValueOnce(Response.json(catalog)).mockImplementationOnce(() => responseGate.promise)
    vi.stubGlobal('fetch', http)
    const owner = own(), sourceId = owner.getMarketplaceSources()[0].id
    await owner.fetchMarketplaceCatalog(sourceId)
    const accepted = owner.installPlugin('fixture-plugin', sourceId)
    const rejected = expect(accepted).rejects.toThrow()
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2))
    await expect(owner.close(5)).rejects.toThrow('PLUGIN_SHUTDOWN_INCOMPLETE')
    responseGate.resolve(new Response(new ReadableStream({ cancel }), { status: 404 }))
    await rejected; await owner.close()
    expect(cancel).toHaveBeenCalledOnce()
    expect(http).toHaveBeenCalledTimes(2)
    expect(existsSync(join(root, 'fixture-plugin', 'plugin.json'))).toBe(false)
    expect(source.db.getInstalledPlugins()).toHaveLength(0)
  })

  it('retains a real downloader body read and rejects its late file write after shutdown', async () => {
    let complete!: () => void
    const body = new ReadableStream<Uint8Array>({ start(controller) { complete = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close() } } })
    const http = vi.fn().mockResolvedValueOnce(Response.json(catalog)).mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', http)
    const owner = own(), sourceId = owner.getMarketplaceSources()[0].id
    await owner.fetchMarketplaceCatalog(sourceId)
    const accepted = owner.installPlugin('fixture-plugin', sourceId)
    const rejected = expect(accepted).rejects.toThrow()
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2))
    await expect(owner.close(5)).rejects.toThrow('PLUGIN_SHUTDOWN_INCOMPLETE')
    complete()
    await rejected; await owner.close()
    expect(existsSync(join(root, 'fixture-plugin', 'plugin.json'))).toBe(false)
    expect(source.db.getInstalledPlugins()).toHaveLength(0)
    expect(http).toHaveBeenCalledTimes(2)
  })
})
