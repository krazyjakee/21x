/** Bounded plugin acquisition. Only a complete private tree is published. */
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, lstatSync, rmdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, relative } from 'node:path'
import type { MarketplaceSourceRecord, ClaudePluginManifest, ClaudePluginSource } from '../database'
import { containedPath, inspectPluginTree, PLUGIN_LIMITS, PluginSourceError, readPluginFile, safeComponent, safeRelative, validateManifestPaths, readPluginTree } from './containment'

interface MarketplacePluginEntry {
  name: string
  source: string | ClaudePluginSource
  description?: string
  version?: string
  author?: { name: string; email?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  category?: string
  tags?: string[]
}

export interface MarketplaceCatalog {
  name: string
  owner: { name: string; email?: string }
  metadata?: {
    description?: string
    version?: string
    pluginRoot?: string
  }
  plugins: MarketplacePluginEntry[]
}


interface DownloadBudget { entries: number; bytes: number }
function pathExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new PluginSourceError('Plugin destination could not be inspected')
  }
}
function sameIdentity(path: string, expected?: { ino: number; dev: number }): boolean {
  if (!expected || !pathExists(path)) return false
  const actual = lstatSync(path)
  return actual.ino === expected.ino && actual.dev === expected.dev && !actual.isSymbolicLink()
}

const fail = (message: string): never => { throw new PluginSourceError(message) }

async function fetchSource(address: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<Response> {
  let url: URL
  try { url = new URL(address) } catch { return fail('Invalid plugin source URL') }
  for (let redirects = 0; ; redirects++) {
    signal?.throwIfAborted()
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Unsupported plugin source URL')
    const response = await fetch(url.href, { signal, headers, redirect: 'manual' })
    if (signal?.aborted) { await response.body?.cancel(); signal.throwIfAborted() }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    if (redirects >= PLUGIN_LIMITS.redirects) fail('Plugin source exceeds the redirect limit')
    const location = response.headers.get('location')
    if (!location) fail('Plugin source redirect has no destination')
    try { url = new URL(location!, url) } catch { return fail('Invalid plugin source redirect') }
  }
}

async function readBody(response: Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const advertised = Number(response.headers.get('content-length'))
  if (advertised > limit) { await response.body?.cancel(); return fail('Plugin response exceeds the byte limit') }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader(), chunks: Buffer[] = []
  let bytes = 0, complete = false
  try {
    for (;;) {
      signal?.throwIfAborted()
      const part = await reader.read()
      signal?.throwIfAborted()
      if (part.done) { complete = true; break }
      bytes += part.value.byteLength
      if (bytes > limit) fail('Plugin response exceeds the byte limit')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks, bytes)
  } finally {
    // Do not release ownership before the raw reader/cancellation settles.
    try { if (!complete) await reader.cancel() } finally { reader.releaseLock() }
  }
}

async function responseJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try { return JSON.parse((await readBody(response, PLUGIN_LIMITS.jsonBytes, signal)).toString('utf-8')) }
  catch (error) { signal?.throwIfAborted(); if (error instanceof PluginSourceError) throw error; return fail('Invalid plugin source JSON') }
}

function parseRepoSlug(slug: string): { repoPath: string; branch: string } {
  const [repoPath, ref, extra] = slug.split('#')
  if (extra !== undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoPath)) fail('Invalid plugin repository')
  repoPath.split('/').forEach(safeComponent)
  const branch = ref || 'main'
  safeRelative(branch)
  return { repoPath, branch }
}

function catalog(value: unknown): MarketplaceCatalog {
  if (!value || typeof value !== 'object' || !Array.isArray((value as MarketplaceCatalog).plugins)) fail('Invalid marketplace catalog')
  const result = value as MarketplaceCatalog
  if (result.plugins.length > PLUGIN_LIMITS.entries) fail('Marketplace exceeds the plugin count limit')
  if (result.metadata?.pluginRoot) safeRelative(result.metadata.pluginRoot)
  for (const entry of result.plugins) {
    safeComponent(entry.name)
    const source = typeof entry.source === 'string' ? { path: entry.source } : entry.source
    if (!source || typeof source !== 'object') fail('Invalid marketplace plugin source')
    if (source.path) safeRelative(source.path)
    if (source.repo) parseRepoSlug(source.repo)
    if (source.ref) safeRelative(source.ref)
  }
  return result
}

export async function fetchCatalogFromSource(source: MarketplaceSourceRecord, signal?: AbortSignal): Promise<MarketplaceCatalog | null> {
  signal?.throwIfAborted()
  if (source.source_type === 'local') {
    const root = source.source_url.endsWith('.json') ? dirname(source.source_url) : source.source_url
    const paths = source.source_url.endsWith('.json') ? [safeComponent(source.source_url.split(/[\\/]/).pop()!)] : ['.claude-plugin/marketplace.json', 'marketplace.json']
    for (const path of paths) {
      if (existsSync(join(root, path))) return catalog(JSON.parse(readPluginFile(root, path, PLUGIN_LIMITS.jsonBytes).toString('utf-8')))
    }
    return null
  }
  const repo = source.source_type === 'github' ? parseRepoSlug(source.source_url) : null
  const url = repo ? `https://raw.githubusercontent.com/${repo.repoPath}/${encodeURIComponent(repo.branch)}/.claude-plugin/marketplace.json` : source.source_url
  let response = await fetchSource(url, signal)
  if (!response.ok && repo?.branch === 'main') {
    await response.body?.cancel()
    response = await fetchSource(`https://raw.githubusercontent.com/${repo.repoPath}/HEAD/.claude-plugin/marketplace.json`, signal)
  }
  if (!response.ok) { await response.body?.cancel(); return fail('Marketplace request failed') }
  return catalog(await responseJson(response, signal))
}

/** An exclusive publication lock serializes cooperating installers across processes.
 * Existing final trees are refused; cleanup touches only this invocation's staging/lock. */
export async function downloadPluginFiles(pluginsDir: string, pluginName: string, source: ClaudePluginSource,
  marketplaceSource?: MarketplaceSourceRecord, pluginRoot?: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (!isAbsolute(pluginsDir) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginName)) fail('Invalid plugin directory name')
  safeComponent(pluginName)
  mkdirSync(pluginsDir, { recursive: true })
  containedPath(pluginsDir)
  const pluginDir = join(pluginsDir, pluginName), lock = join(pluginsDir, `.install-${pluginName}`)
  if (pathExists(pluginDir)) fail('Plugin destination already exists; existing files were preserved')
  mkdirSync(lock, { mode: 0o700 })
  const lockIdentity = lstatSync(lock)
  let staging: string | undefined
  let stagingIdentity: { ino: number; dev: number } | undefined
  try {
    staging = mkdtempSync(join(pluginsDir, '.plugin-stage-'))
    stagingIdentity = lstatSync(staging)
    const budget: DownloadBudget = { entries: 0, bytes: 0 }
    if (source.source === 'github' && source.repo) {
      const repo = parseRepoSlug(source.repo)
      await downloadFromGitHub(repo.repoPath, source.ref || repo.branch, safeRelative(source.path || ''), staging, budget, 0, signal)
    } else if (source.path && marketplaceSource?.source_type === 'github') {
      const repo = parseRepoSlug(marketplaceSource.source_url)
      const path = [safeRelative(pluginRoot || ''), safeRelative(source.path)].filter(Boolean).join('/')
      await downloadFromGitHub(repo.repoPath, repo.branch, path, staging, budget, 0, signal)
    } else if (source.url) {
      await downloadFromUrl(source.url, staging, budget, signal)
    } else if (source.path && marketplaceSource?.source_type === 'local') {
      copyFromLocal(marketplaceSource.source_url, source.path, pluginRoot, staging, signal)
    } else fail('Unsupported plugin source')
    signal?.throwIfAborted()
    if (!readPluginTree(staging).size) fail('Plugin source contained no files')
    readPluginManifest(staging, { name: pluginName, source })
    containedPath(pluginsDir)
    if (pathExists(pluginDir)) fail('Plugin destination appeared during installation; existing files were preserved')
    renameSync(staging, pluginDir)
    staging = undefined
    return pluginDir
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof PluginSourceError) throw error
    throw new PluginSourceError('Plugin acquisition failed; existing files were preserved')
  } finally {
    if (staging && sameIdentity(staging, stagingIdentity)) rmSync(staging, { recursive: true, force: true })
    if (sameIdentity(lock, lockIdentity)) rmdirSync(lock)
  }
}

async function downloadToFile(url: string, path: string, budget: DownloadBudget, signal?: AbortSignal, optional = false): Promise<void> {
  const response = await fetchSource(url, signal)
  if (!response.ok) {
    await response.body?.cancel()
    if (optional && response.status === 404) return
    return fail('Plugin file request failed')
  }
  const body = await readBody(response, Math.min(PLUGIN_LIMITS.fileBytes, PLUGIN_LIMITS.totalBytes - budget.bytes), signal)
  budget.bytes += body.byteLength
  if (++budget.entries > PLUGIN_LIMITS.entries) fail('Plugin source exceeds the entry limit')
  signal?.throwIfAborted()
  writeFileSync(path, body, { flag: 'wx', mode: 0o600 })
}

async function downloadFromGitHub(repoPath: string, branch: string, remotePath: string, localDir: string,
  budget: DownloadBudget, depth: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  safeRelative(branch)
  if (depth > PLUGIN_LIMITS.depth || ++budget.entries > PLUGIN_LIMITS.entries) fail('Plugin source exceeds the depth or entry limit')
  const response = await fetchSource(`https://api.github.com/repos/${repoPath}/contents/${remotePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, signal, { Accept: 'application/vnd.github.v3+json' })
  if (!response.ok) {
    await response.body?.cancel()
    // A fallback is allowed only for an API rate limit; malformed/unsafe data
    // and file/body failures must never be reinterpreted as another source.
    if (response.status === 403 || response.status === 429) return downloadKnownFilesRaw(repoPath, branch, remotePath, localDir, budget, signal)
    return fail('GitHub plugin source request failed')
  }
  const data = await responseJson(response, signal)
  if (!Array.isArray(data)) return fail('GitHub plugin source must be a directory')
  if (data.length > PLUGIN_LIMITS.entries - budget.entries) fail('GitHub plugin source exceeds the entry limit')
  for (const value of data) {
    if (!value || typeof value !== 'object') fail('Invalid GitHub plugin entry')
    const entry = value as { name: string; path: string; type: string; download_url?: string }
    const name = safeComponent(entry.name), expected = remotePath ? `${remotePath}/${name}` : name
    if (entry.path !== expected) fail('GitHub plugin entry escaped its directory')
    signal?.throwIfAborted()
    if (entry.type === 'file' && entry.download_url) await downloadToFile(entry.download_url, join(localDir, name), budget, signal)
    else if (entry.type === 'dir') {
      const subDir = join(localDir, name); mkdirSync(subDir, { mode: 0o700 })
      await downloadFromGitHub(repoPath, branch, expected, subDir, budget, depth + 1, signal)
    } else fail('Unsupported GitHub plugin entry type')
  }
}

async function downloadKnownFilesRaw(repoPath: string, branch: string, remotePath: string, localDir: string,
  budget: DownloadBudget, signal?: AbortSignal): Promise<void> {
  const base = `https://raw.githubusercontent.com/${repoPath}/${encodeURIComponent(branch)}/${remotePath.split('/').map(encodeURIComponent).join('/')}`
  for (const name of ['plugin.json', '.mcp.json', 'CLAUDE.md']) await downloadToFile(`${base}/${name}`, join(localDir, name), budget, signal, true)
}

async function downloadFromUrl(address: string, localDir: string, budget: DownloadBudget, signal?: AbortSignal): Promise<void> {
  const url = new URL(address), name = safeComponent(decodeURIComponent(url.pathname.split('/').pop() || 'plugin.json'))
  const response = await fetchSource(address, signal)
  const contentType = response.headers.get('content-type') || ''
  if (!response.ok) { await response.body?.cancel(); return fail('Plugin URL request failed') }
  if (!name.endsWith('.json') || !/^(application\/(?:[a-z0-9.+-]+\+)?json)(?:;|$)/i.test(contentType)) {
    await response.body?.cancel()
    return fail('Plugin archives and non-JSON URL sources are unsupported')
  }
  const body = await readBody(response, PLUGIN_LIMITS.jsonBytes, signal)
  try { JSON.parse(body.toString('utf-8')) } catch { return fail('Invalid plugin source JSON') }
  signal?.throwIfAborted()
  budget.bytes += body.byteLength; budget.entries++
  writeFileSync(join(localDir, name), body, { flag: 'wx', mode: 0o600 })
  if (name !== 'plugin.json') await downloadToFile(new URL('plugin.json', url).href, join(localDir, 'plugin.json'), budget, signal, true)
}

function copyFromLocal(marketplacePath: string, pluginPath: string, pluginRoot: string | undefined, localDir: string, signal?: AbortSignal): void {
  const base = marketplacePath.endsWith('.json') ? dirname(marketplacePath) : marketplacePath
  const path = [safeRelative(pluginRoot || ''), safeRelative(pluginPath)].filter(Boolean).join('/')
  const source = containedPath(base, path)
  const location = relative(resolve(source), resolve(localDir))
  if (!location || (!location.startsWith('..') && !isAbsolute(location))) fail('Plugin source contains its installation directory')
  const files = readPluginTree(source)
  for (const [file, content] of files) {
    signal?.throwIfAborted()
    const target = join(localDir, file)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
  }
}

/**
 * Reads plugin.json from the downloaded plugin directory, filling gaps from the
 * catalog entry; falls back to a manifest built purely from the catalog entry.
 */
export function readPluginManifest(pluginDir: string, entry: MarketplacePluginEntry): ClaudePluginManifest {
  inspectPluginTree(pluginDir)
  const fromEntry: ClaudePluginManifest = {
    name: entry.name,
    version: entry.version,
    description: entry.description,
    author: entry.author,
    homepage: entry.homepage,
    repository: entry.repository,
    license: entry.license,
    keywords: entry.keywords
  }

  const manifestPath = join(pluginDir, 'plugin.json')
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readPluginFile(pluginDir, 'plugin.json', PLUGIN_LIMITS.jsonBytes).toString('utf-8')) as ClaudePluginManifest
      validateManifestPaths(parsed as unknown as Record<string, unknown>)
      return {
        ...parsed,
        name: parsed.name || entry.name,
        version: parsed.version || entry.version,
        description: parsed.description || entry.description,
        author: parsed.author || entry.author,
        homepage: parsed.homepage || entry.homepage,
        repository: parsed.repository || entry.repository,
        license: parsed.license || entry.license,
        keywords: parsed.keywords || entry.keywords
      }
    } catch (err) {
      if (err instanceof PluginSourceError) throw err
      console.warn('[ClaudePluginManager] Failed to parse plugin.json')
    }
  }
  return fromEntry
}
