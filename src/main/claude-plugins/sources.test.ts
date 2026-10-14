import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MarketplaceSourceRecord } from '../database'
import { downloadPluginFiles, fetchCatalogFromSource, readPluginManifest } from './sources'
import { PLUGIN_LIMITS } from './containment'

let root: string, profile: string, marketplace: string
const source = (path: string): MarketplaceSourceRecord => ({ id: 'fixture', name: 'fixture', source_type: 'local', source_url: path, metadata: {}, auto_update: false, created_at: '', updated_at: '' })
const catalog = { name: 'fixture', owner: { name: 'fixture' }, plugins: [{ name: 'plugin', source: './nested/plugin' }] }
function localPlugin(): string {
  const dir = join(marketplace, 'nested', 'plugin')
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'plugin.json'), '{"name":"plugin"}')
  return dir
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plugin-sources-')); profile = join(root, 'profile'); marketplace = join(root, 'marketplace'); mkdirSync(profile); mkdirSync(marketplace) })
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals() })

describe('bounded private plugin acquisition', () => {
  it('publishes a complete nested local source with pluginRoot without modifying its source or sibling installs', async () => {
    const original = localPlugin(); writeFileSync(join(profile, 'unrelated.txt'), 'preserve')
    const installed = await downloadPluginFiles(profile, 'plugin', { path: './plugin' }, source(marketplace), './nested')
    expect(readFileSync(join(installed, 'plugin.json'), 'utf8')).toBe('{"name":"plugin"}')
    expect(readFileSync(join(original, 'plugin.json'), 'utf8')).toBe('{"name":"plugin"}')
    expect(readFileSync(join(profile, 'unrelated.txt'), 'utf8')).toBe('preserve')
    expect(readdirSync(profile).sort()).toEqual(['plugin', 'unrelated.txt'])
  })

  it('refuses publication after the actual contained staging plan loses its grant', async () => {
    localPlugin()
    const publish = vi.fn((dir: string) => { expect(readFileSync(join(dir, 'plugin.json'), 'utf8')).toContain('plugin'); throw new Error('Grant withdrawn') })
    await expect(downloadPluginFiles(profile, 'plugin', { path: './nested/plugin' }, source(marketplace), undefined, undefined, publish)).rejects.toThrow()
    expect(publish).toHaveBeenCalledOnce(); expect(readdirSync(profile)).toEqual([])
    expect(existsSync(join(marketplace, 'nested', 'plugin'))).toBe(true)
  })

  it('rechecks every redirect and nested GitHub file address before network effects', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://ungranted.invalid/catalog' } }))
    vi.stubGlobal('fetch', fetcher)
    const sourceRow = { ...source(marketplace), source_type: 'url', source_url: 'https://granted.invalid/catalog' }
    await expect(fetchCatalogFromSource(sourceRow, undefined, address => { if (address.includes('ungranted')) throw new Error('Address grant withdrawn') })).rejects.toThrow('Address grant withdrawn')
    expect(fetcher).toHaveBeenCalledOnce()
    fetcher.mockReset(); fetcher.mockImplementation(async () => Response.json([{ name: 'plugin.json', path: 'plugin.json', type: 'file', download_url: 'https://ungranted.invalid/plugin.json' }]))
    await expect(downloadPluginFiles(profile, 'plugin', { source: 'github', repo: 'fixture/repo' }, undefined, undefined, undefined, undefined,
      address => { if (address.includes('ungranted')) throw new Error('Address grant withdrawn') })).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce(); expect(readdirSync(profile)).toEqual([])
  })

  it('refuses a pre-existing partial tree without fetching or changing its files', async () => {
    mkdirSync(join(profile, 'plugin')); writeFileSync(join(profile, 'plugin', 'old.txt'), 'keep')
    const http = vi.fn(); vi.stubGlobal('fetch', http)
    await expect(downloadPluginFiles(profile, 'plugin', { url: 'https://fixture.invalid/plugin.json' })).rejects.toThrow('already exists')
    expect(http).not.toHaveBeenCalled(); expect(readFileSync(join(profile, 'plugin', 'old.txt'), 'utf8')).toBe('keep')
  })

  it('keeps private staging owned until an ignored read and reader cleanup settle, then removes only staging', async () => {
    let finish!: () => void, acknowledge!: () => void
    const cancelled = new Promise<void>(resolve => { acknowledge = resolve })
    const cancel = vi.fn(() => cancelled)
    const body = new ReadableStream<Uint8Array>({ start(controller) { finish = () => controller.enqueue(new TextEncoder().encode('{}')) }, cancel })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } })))
    const controller = new AbortController()
    const operation = downloadPluginFiles(profile, 'plugin', { url: 'https://fixture.invalid/plugin.json' }, undefined, undefined, controller.signal)
    const rejected = expect(operation).rejects.toThrow()
    await vi.waitFor(() => expect(readdirSync(profile).some(name => name.startsWith('.plugin-stage-'))).toBe(true))
    expect(existsSync(join(profile, 'plugin'))).toBe(false)
    controller.abort(); finish()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(readdirSync(profile).some(name => name.startsWith('.plugin-stage-'))).toBe(true)
    acknowledge(); await rejected
    expect(readdirSync(profile)).toEqual([])
  })

  it('preserves a destination created while a download is pending', async () => {
    let finish!: () => void
    const body = new ReadableStream<Uint8Array>({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close() } } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } })))
    const operation = downloadPluginFiles(profile, 'plugin', { url: 'https://fixture.invalid/plugin.json' })
    const rejected = expect(operation).rejects.toThrow('appeared')
    await vi.waitFor(() => expect(readdirSync(profile).some(name => name.startsWith('.plugin-stage-'))).toBe(true))
    mkdirSync(join(profile, 'plugin')); writeFileSync(join(profile, 'plugin', 'outside.txt'), 'preserve')
    finish(); await rejected
    expect(readdirSync(profile)).toEqual(['plugin'])
    expect(readFileSync(join(profile, 'plugin', 'outside.txt'), 'utf8')).toBe('preserve')
  })

  it.each(['../outside', '/outside', 'nested/../../outside', 'nested\\outside', 'nested/%2e%2e/outside'])('rejects escaping local/catalog paths: %s', async path => {
    localPlugin()
    await expect(downloadPluginFiles(profile, 'plugin', { path }, source(marketplace))).rejects.toThrow()
    expect(readdirSync(profile)).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...catalog, plugins: [{ name: 'plugin', source: path }] })))
    await expect(fetchCatalogFromSource({ ...source('https://fixture.invalid/catalog.json'), source_type: 'url' })).rejects.toThrow()
  })

  it('downloads a contained nested GitHub tree and refuses inconsistent entry paths', async () => {
    const http = vi.fn(async (url: string) => {
      if (url.includes('/contents/nested?')) return Response.json([{ name: 'skills', path: 'nested/skills', type: 'dir' }])
      if (url.includes('/contents/nested/skills?')) return Response.json([{ name: 'SKILL.md', path: 'nested/skills/SKILL.md', type: 'file', download_url: 'https://fixture.invalid/skill' }])
      return new Response('Contained skill')
    })
    vi.stubGlobal('fetch', http)
    const installed = await downloadPluginFiles(profile, 'plugin', { source: 'github', repo: 'owner/repo', path: 'nested' })
    expect(readFileSync(join(installed, 'skills', 'SKILL.md'), 'utf8')).toBe('Contained skill')
    expect(http).toHaveBeenCalledTimes(3)
    rmSync(installed, { recursive: true })
    const unsafe = vi.fn(async () => Response.json([{ name: 'safe', path: '../outside/safe', type: 'file', download_url: 'https://fixture.invalid/file' }]))
    vi.stubGlobal('fetch', unsafe)
    await expect(downloadPluginFiles(profile, 'plugin', { source: 'github', repo: 'owner/repo' })).rejects.toThrow('escaped')
    expect(unsafe).toHaveBeenCalledOnce()
  })

  it('uses raw known-file fallback only for rate limiting and refuses missing/empty sources', async () => {
    const http = vi.fn(async (url: string) => {
      if (url.includes('api.github.com')) return new Response(null, { status: 429 })
      return url.endsWith('/plugin.json') ? Response.json({ name: 'plugin' }) : new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', http)
    const installed = await downloadPluginFiles(profile, 'plugin', { source: 'github', repo: 'owner/repo' })
    expect(readFileSync(join(installed, 'plugin.json'), 'utf8')).toContain('plugin')
    rmSync(installed, { recursive: true })
    const missing = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', missing)
    await expect(downloadPluginFiles(profile, 'plugin', { source: 'github', repo: 'owner/repo' })).rejects.toThrow('request failed')
    expect(missing).toHaveBeenCalledOnce(); expect(readdirSync(profile)).toEqual([])
  })

  it.each(['../escape', 'nested/escape', 'C:escape', '%2e%2e'])('rejects unsafe GitHub names without using a fallback: %s', async name => {
    const http = vi.fn(async () => Response.json([{ name, path: name, type: 'file', download_url: 'https://fixture.invalid/file' }]))
    vi.stubGlobal('fetch', http)
    await expect(downloadPluginFiles(profile, 'plugin', { source: 'github', repo: 'owner/repo' })).rejects.toThrow()
    expect(http).toHaveBeenCalledOnce(); expect(readdirSync(profile)).toEqual([])
  })

  it.each(['symlink', 'submodule'])('refuses unsupported GitHub %s entries', async type => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ name: 'file', path: 'file', type }])))
    await expect(downloadPluginFiles(profile, 'plugin', { source: 'github', repo: 'owner/repo' })).rejects.toThrow('entry type')
    expect(readdirSync(profile)).toEqual([])
  })

  it('bounds catalog bodies and joins their cancellation before returning a size failure', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(PLUGIN_LIMITS.jsonBytes + 1)) }, cancel })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(fetchCatalogFromSource({ ...source('https://fixture.invalid/catalog.json'), source_type: 'url' })).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('bounds redirects and refuses archives before reading their body', async () => {
    const redirects = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/again' } }))
    vi.stubGlobal('fetch', redirects)
    await expect(downloadPluginFiles(profile, 'plugin', { url: 'https://fixture.invalid/plugin.json' })).rejects.toThrow('redirect limit')
    expect(redirects).toHaveBeenCalledTimes(PLUGIN_LIMITS.redirects + 1)
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/zip' } })))
    await expect(downloadPluginFiles(profile, 'plugin', { url: 'https://fixture.invalid/plugin.zip' })).rejects.toThrow('unsupported')
    expect(cancel).toHaveBeenCalledOnce(); expect(readdirSync(profile)).toEqual([])
  })

  it('bounds local file bytes, aggregate bytes, depth and entries before publication', async () => {
    const dir = localPlugin(), large = join(dir, 'large')
    writeFileSync(large, ''); truncateSync(large, PLUGIN_LIMITS.fileBytes + 1)
    await expect(downloadPluginFiles(profile, 'plugin', { path: 'nested/plugin' }, source(marketplace))).rejects.toThrow('byte limit')
    rmSync(large)
    for (let i = 0; i < 5; i++) { const path = join(dir, 'large' + i); writeFileSync(path, ''); truncateSync(path, PLUGIN_LIMITS.fileBytes) }
    await expect(downloadPluginFiles(profile, 'plugin', { path: 'nested/plugin' }, source(marketplace))).rejects.toThrow('byte limit')
    for (let i = 0; i < 5; i++) rmSync(join(dir, 'large' + i))
    mkdirSync(join(dir, ...Array.from({ length: PLUGIN_LIMITS.depth + 1 }, () => 'nested')), { recursive: true })
    await expect(downloadPluginFiles(profile, 'plugin', { path: 'nested/plugin' }, source(marketplace))).rejects.toThrow('depth')
    rmSync(join(dir, 'nested'), { recursive: true })
    for (let i = 0; i < PLUGIN_LIMITS.entries; i++) writeFileSync(join(dir, 'file' + i), '')
    await expect(downloadPluginFiles(profile, 'plugin', { path: 'nested/plugin' }, source(marketplace))).rejects.toThrow('entry count')
    expect(readdirSync(profile)).toEqual([])
  })

  it('refuses local directory links and manifest links without reading outside content', async () => {
    const dir = localPlugin(), outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.json'), '{"name":"outside"}')
    symlinkSync(outside, join(dir, 'linked'), 'junction')
    await expect(downloadPluginFiles(profile, 'plugin', { path: 'nested/plugin' }, source(marketplace))).rejects.toThrow('containment')
    rmSync(join(dir, 'linked'))
    symlinkSync(outside, join(dir, 'manifest'), 'junction')
    await expect(fetchCatalogFromSource(source(join(dir, 'manifest', 'secret.json')))).rejects.toThrow('containment')
    // A root symlink is also rejected at manifest reads.
    expect(() => readPluginManifest(join(dir, 'manifest'), { name: 'plugin', source: '' })).toThrow('containment')
    expect(readFileSync(join(outside, 'secret.json'), 'utf8')).toBe('{"name":"outside"}')
  })
})
