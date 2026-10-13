import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const PLUGIN_LIMITS = { jsonBytes: 1024 * 1024, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, entries: 2000, depth: 16, redirects: 5 } as const

export class PluginSourceError extends Error {}
const reject = (): never => { throw new PluginSourceError('Plugin path or resource is outside the supported containment policy') }

export function safeComponent(name: string): string {
  if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..' || /[\\/:%\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) reject()
  return name
}

export function safeRelative(path: string): string {
  if (typeof path !== 'string') reject()
  const stripped = path.replace(/^\.\//, '')
  if (!stripped || stripped === '.') return ''
  if (isAbsolute(stripped)) reject()
  return stripped.split('/').map(safeComponent).join('/')
}

/** Reject links/reparse-point aliases at every existing component below the explicit root. */
export function containedPath(root: string, path = ''): string {
  const base = resolve(root), destination = resolve(base, safeRelative(path))
  if (relative(base, destination).startsWith('..') || isAbsolute(relative(base, destination))) reject()
  let current = base
  for (const part of ['', ...relative(base, destination).split(/[\\/]/).filter(Boolean)]) {
    if (part) current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== destination)) reject()
  }
  return destination
}

/** Bounded, non-following leaf read; re-check containment before using the handle. */
export function readPluginFile(root: string, path: string, limit: number = PLUGIN_LIMITS.fileBytes): Buffer {
  const file = containedPath(root, path)
  const expected = lstatSync(file)
  if (!expected.isFile() || expected.size > limit) throw new PluginSourceError('Plugin file exceeds the supported size or file type')
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = fstatSync(fd)
    containedPath(root, path)
    if (!actual.isFile() || actual.ino !== expected.ino || actual.dev !== expected.dev) reject()
    const chunks: Buffer[] = []
    let bytes = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - bytes))
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (!count) break
      bytes += count
      if (bytes > limit) throw new PluginSourceError('Plugin file exceeds the supported size')
      chunks.push(chunk.subarray(0, count))
    }
    return Buffer.concat(chunks, bytes)
  } finally { closeSync(fd) }
}

/** Inspect the entire tree before publication/copy/resource writes. Links and devices are refused. */
export function inspectPluginTree(root: string): string[] {
  const files: string[] = []
  let entries = 0, bytes = 0
  const visit = (path: string, depth: number): void => {
    if (depth > PLUGIN_LIMITS.depth || ++entries > PLUGIN_LIMITS.entries) throw new PluginSourceError('Plugin tree exceeds the supported depth or entry count')
    const file = containedPath(root, path), stat = lstatSync(file)
    if (stat.isDirectory()) {
      for (const name of readdirSync(file)) visit(path ? `${path}/${safeComponent(name)}` : safeComponent(name), depth + 1)
    } else if (stat.isFile()) {
      bytes += stat.size
      if (stat.size > PLUGIN_LIMITS.fileBytes || bytes > PLUGIN_LIMITS.totalBytes) throw new PluginSourceError('Plugin tree exceeds the supported byte limit')
      files.push(path)
    } else reject()
  }
  visit('', 0)
  return files
}

/** Manifest string fields describe paths within the plugin, never external files. */
export function validateManifestPaths(manifest: Record<string, unknown>): void {
  let entries = 0
  for (const key of ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers']) {
    const value = manifest[key]
    entries += Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : value ? 1 : 0
    if (entries > PLUGIN_LIMITS.entries) throw new PluginSourceError('Plugin manifest exceeds the resource count limit')
    for (const path of Array.isArray(value) ? value : typeof value === 'string' ? [value] : []) {
      if (typeof path !== 'string') throw new PluginSourceError('Unsupported plugin manifest resource path')
      safeRelative(path)
    }
  }
}

/** Cache a fully read snapshot and enforce the aggregate against actual bytes,
 * since files can grow after the metadata traversal. */
export function readPluginTree(root: string): Map<string, Buffer> {
  const contents = new Map<string, Buffer>()
  let bytes = 0
  for (const path of inspectPluginTree(root)) {
    const content = readPluginFile(root, path, path.endsWith('.json') ? PLUGIN_LIMITS.jsonBytes : PLUGIN_LIMITS.fileBytes)
    bytes += content.byteLength
    if (bytes > PLUGIN_LIMITS.totalBytes) throw new PluginSourceError('Plugin tree exceeds the supported byte limit')
    contents.set(path, content)
  }
  return contents
}
