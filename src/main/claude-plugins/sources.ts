/**
 * Marketplace catalog fetching and plugin file downloads from GitHub, URL, or local sources.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, cpSync } from 'fs'
import { join, resolve } from 'path'

import type { MarketplaceSourceRecord, ClaudePluginManifest, ClaudePluginSource } from '../database'

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

interface GitHubContentEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink'
  download_url: string | null
}

async function fetchSource(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<Response> {
  signal?.throwIfAborted()
  const response = await fetch(url, { signal, headers })
  if (signal?.aborted) {
    await response.body?.cancel()
    signal.throwIfAborted()
  }
  return response
}

const stripDotSlash = (p: string): string => p.replace(/^\.\//, '')

/** Splits "owner/repo#ref" into repo path and branch (default "main"). */
function parseRepoSlug(slug: string): { repoPath: string; branch: string } {
  const [repoPath, ref] = slug.split('#')
  return { repoPath, branch: ref || 'main' }
}

export async function fetchCatalogFromSource(source: MarketplaceSourceRecord, signal?: AbortSignal): Promise<MarketplaceCatalog | null> {
  signal?.throwIfAborted()
  const { source_type, source_url } = source
  if (source_type === 'github') return fetchGitHubCatalog(source_url, signal)
  if (source_type === 'url') return fetchJson(source_url, signal)
  if (source_type === 'local') return readLocalCatalog(source_url)
  return null
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<MarketplaceCatalog> {
  const response = await fetchSource(url, signal)
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Failed to fetch: ${response.status}`) }
  return (await response.json()) as MarketplaceCatalog
}

async function fetchGitHubCatalog(repoSlug: string, signal?: AbortSignal): Promise<MarketplaceCatalog | null> {
  const { repoPath, branch } = parseRepoSlug(repoSlug)
  const url = `https://raw.githubusercontent.com/${repoPath}/${branch}/.claude-plugin/marketplace.json`

  const response = await fetchSource(url, signal)
  if (!response.ok) {
    await response.body?.cancel()
    // Repos whose default branch isn't "main" (e.g. "master") still resolve via HEAD
    if (branch === 'main') {
      const fallback = await fetchSource(`https://raw.githubusercontent.com/${repoPath}/HEAD/.claude-plugin/marketplace.json`, signal)
      if (fallback.ok) return (await fallback.json()) as MarketplaceCatalog
      await fallback.body?.cancel()
    }
    throw new Error(`Failed to fetch marketplace.json: ${response.status}`)
  }
  return (await response.json()) as MarketplaceCatalog
}

function readLocalCatalog(dirPath: string): MarketplaceCatalog | null {
  let catalogPath = join(dirPath, '.claude-plugin', 'marketplace.json')
  if (!existsSync(catalogPath)) {
    // The user may have pointed at marketplace.json itself
    catalogPath = dirPath.endsWith('.json') ? dirPath : join(dirPath, 'marketplace.json')
  }
  if (!existsSync(catalogPath)) return null
  return JSON.parse(readFileSync(catalogPath, 'utf-8')) as MarketplaceCatalog
}

/** Downloads plugin files into <pluginsDir>/<pluginName>/ and returns that directory. */
export async function downloadPluginFiles(
  pluginsDir: string,
  pluginName: string,
  source: ClaudePluginSource,
  marketplaceSource?: MarketplaceSourceRecord,
  pluginRoot?: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  const pluginDir = join(pluginsDir, pluginName)
  mkdirSync(pluginDir, { recursive: true })

  if (source.source === 'github' && source.repo) {
    await downloadFromGitHub(source.repo, source.ref || 'main', source.path || '', pluginDir, signal)
  } else if (source.path && marketplaceSource?.source_type === 'github') {
    // Relative path within the marketplace's own repo
    const { repoPath, branch } = parseRepoSlug(marketplaceSource.source_url)
    let remotePath = stripDotSlash(source.path)
    if (pluginRoot) remotePath = `${stripDotSlash(pluginRoot)}/${remotePath}`
    await downloadFromGitHub(repoPath, branch, remotePath, pluginDir, signal)
  } else if (source.url) {
    await downloadFromUrl(source.url, pluginDir, signal)
  } else if (source.path && marketplaceSource?.source_type === 'local') {
    copyFromLocal(marketplaceSource.source_url, source.path, pluginRoot, pluginDir)
  }

  return pluginDir
}

async function downloadToFile(url: string, localPath: string, signal?: AbortSignal): Promise<void> {
  const response = await fetchSource(url, signal)
  if (response.ok) {
    const body = await response.text()
    signal?.throwIfAborted()
    writeFileSync(localPath, body, 'utf-8')
  } else { await response.body?.cancel() }
}

/** Recursively downloads a repo directory via the GitHub Contents API. */
async function downloadFromGitHub(
  repoPath: string,
  branch: string,
  remotePath: string,
  localDir: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const apiUrl = `https://api.github.com/repos/${repoPath}/contents/${remotePath}?ref=${branch}`

  try {
    const response = await fetchSource(apiUrl, signal, { Accept: 'application/vnd.github.v3+json' })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 404) {
        console.warn(`[ClaudePluginManager] Path not found on GitHub: ${remotePath}`)
        return
      }
      throw new Error(`GitHub API error: ${response.status}`)
    }

    const data = await response.json()
    signal?.throwIfAborted()
    if (Array.isArray(data)) {
      for (const entry of data as GitHubContentEntry[]) {
        signal?.throwIfAborted()
        if (entry.type === 'file' && entry.download_url) {
          await downloadToFile(entry.download_url, join(localDir, entry.name), signal)
        } else if (entry.type === 'dir') {
          const subDir = join(localDir, entry.name)
          mkdirSync(subDir, { recursive: true })
          await downloadFromGitHub(repoPath, branch, `${remotePath}/${entry.name}`, subDir, signal)
        }
      }
    } else if (data.type === 'file' && data.download_url) {
      await downloadToFile(data.download_url, join(localDir, remotePath.split('/').pop() || 'file'), signal)
    }
  } catch {
    signal?.throwIfAborted()
    console.error('[ClaudePluginManager] Failed to download from GitHub')
    await downloadKnownFilesRaw(repoPath, branch, remotePath, localDir, signal)
  }
}

/**
 * Fallback when the GitHub API is unavailable (rate-limited, etc.): fetch well-known
 * plugin files via raw.githubusercontent.com, which cannot list directories.
 */
async function downloadKnownFilesRaw(
  repoPath: string,
  branch: string,
  remotePath: string,
  localDir: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const baseUrl = `https://raw.githubusercontent.com/${repoPath}/${branch}/${remotePath}`

  for (const file of ['plugin.json', '.mcp.json', 'CLAUDE.md']) {
    try {
      await downloadToFile(`${baseUrl}/${file}`, join(localDir, file), signal)
    } catch {
      signal?.throwIfAborted()
      // Missing files are expected
    }
  }

  for (const dir of ['skills', 'commands']) {
    try {
      const response = await fetchSource(`${baseUrl}/${dir}/`, signal)
      await response.body?.cancel()
      signal?.throwIfAborted()
      if (response.ok) mkdirSync(join(localDir, dir), { recursive: true })
    } catch {
      signal?.throwIfAborted()
      // Missing dirs are expected
    }
  }
}

async function downloadFromUrl(url: string, localDir: string, signal?: AbortSignal): Promise<void> {
  try {
    const response = await fetchSource(url, signal)
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Failed to fetch: ${response.status}`) }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json') || url.endsWith('.json')) {
      const body = await response.text()
      signal?.throwIfAborted()
      writeFileSync(join(localDir, url.split('/').pop() || 'plugin.json'), body, 'utf-8')
    } else {
      // Archives (tarball/zip) are saved as-is; extraction is not supported
      const buffer = Buffer.from(await response.arrayBuffer())
      signal?.throwIfAborted()
      writeFileSync(join(localDir, url.split('/').pop() || 'plugin-archive'), buffer)
    }
  } catch {
    signal?.throwIfAborted()
    console.warn('[ClaudePluginManager] Failed to download from URL')
  }

  if (!url.endsWith('plugin.json')) {
    try {
      await downloadToFile(`${url.replace(/\/[^/]*$/, '')}/plugin.json`, join(localDir, 'plugin.json'), signal)
    } catch {
      signal?.throwIfAborted()
      // plugin.json alongside the URL is optional
    }
  }
}

function copyFromLocal(
  marketplacePath: string,
  pluginPath: string,
  pluginRoot: string | undefined,
  localDir: string
): void {
  let sourcePath = stripDotSlash(pluginPath)
  if (pluginRoot) sourcePath = `${stripDotSlash(pluginRoot)}/${sourcePath}`

  const baseDir = marketplacePath.endsWith('.json') ? resolve(marketplacePath, '..') : marketplacePath
  const fullSourcePath = join(baseDir, sourcePath)

  if (existsSync(fullSourcePath) && resolve(fullSourcePath) !== resolve(localDir)) {
    cpSync(fullSourcePath, localDir, { recursive: true })
  }
}

/**
 * Reads plugin.json from the downloaded plugin directory, filling gaps from the
 * catalog entry; falls back to a manifest built purely from the catalog entry.
 */
export function readPluginManifest(pluginDir: string, entry: MarketplacePluginEntry): ClaudePluginManifest {
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
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ClaudePluginManifest
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
      console.warn(`[ClaudePluginManager] Failed to parse plugin.json:`, err)
    }
  }
  return fromEntry
}
