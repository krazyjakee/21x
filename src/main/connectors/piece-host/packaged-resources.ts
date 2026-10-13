import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { CONNECTOR_PIECE_ALLOWLIST } from '../allowlist'
import { createNodeProcessTransport } from './node-transport'
import type { PieceHostTransport } from './client'

export class ConnectorResourcesUnavailableError extends Error {
  readonly code = 'CONNECTOR_RESOURCES_UNAVAILABLE'
  constructor() { super('Packaged connector resources are unavailable'); this.name = 'ConnectorResourcesUnavailableError' }
}

function contained(root: string, path: string): boolean {
  const value = relative(root, path)
  return !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep)
}
function directory(root: string, path: string): string {
  const details = lstatSync(path)
  const actual = realpathSync(path)
  if (!details.isDirectory() || details.isSymbolicLink() || !contained(root, actual)) throw new ConnectorResourcesUnavailableError()
  return actual
}
function file(root: string, path: string, limit: number): Buffer {
  const details = lstatSync(path)
  if (!details.isFile() || details.isSymbolicLink() || details.size > limit || !contained(root, realpathSync(path))) {
    throw new ConnectorResourcesUnavailableError()
  }
  return readFileSync(path)
}
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')

/** Trusted service-owned root only. No PATH, NODE_PATH or repository fallback is accepted. */
export function validateConnectorResources(resourceRoot: string): { root: string; worker: string; node: string; nodeVersion: string } {
  try {
    if (!isAbsolute(resourceRoot)) throw new ConnectorResourcesUnavailableError()
    const root = directory(realpathSync(resourceRoot), resourceRoot)
    const service = directory(root, join(root, 'service'))
    const modules = directory(service, join(service, 'node_modules'))
    const nodeRoot = directory(root, join(root, 'node'))
    const node = join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
    const nodeDetails = lstatSync(node)
    if (!nodeDetails.isFile() || nodeDetails.isSymbolicLink() || !contained(nodeRoot, realpathSync(node))) {
      throw new ConnectorResourcesUnavailableError()
    }
    const manifest = JSON.parse(file(service, join(service, 'CONNECTOR_WORKER_MANIFEST.json'), 64 * 1024).toString('utf8'))
    if (manifest.schemaVersion !== 1 || manifest.worker !== 'piece-host.cjs' || typeof manifest.nodeVersion !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(manifest.nodeVersion) ||
        !manifest.packages || Object.keys(manifest.packages).length !== Object.keys(CONNECTOR_PIECE_ALLOWLIST.pieces).length) {
      throw new ConnectorResourcesUnavailableError()
    }
    const worker = join(service, 'piece-host.cjs')
    if (hash(file(service, worker, 1024 * 1024)) !== manifest.workerSha256) throw new ConnectorResourcesUnavailableError()
    const require = createRequire(worker)
    for (const [name, allowed] of Object.entries(CONNECTOR_PIECE_ALLOWLIST.pieces)) {
      const location = directory(modules, join(modules, name))
      const packageBytes = file(location, join(location, 'package.json'), 128 * 1024)
      const metadata = JSON.parse(packageBytes.toString('utf8'))
      const expected = manifest.packages[name]
      const entry = require.resolve(name)
      if (metadata.name !== name || metadata.version !== allowed.version || expected?.version !== allowed.version ||
          Object.keys(metadata.dependencies ?? {}).length || Object.keys(metadata.optionalDependencies ?? {}).length ||
          !contained(location, realpathSync(entry)) || relative(service, entry).split('\\').join('/') !== expected.entry ||
          hash(packageBytes) !== expected.metadataSha256 || hash(file(location, entry, 16 * 1024 * 1024)) !== expected.entrySha256) {
        throw new ConnectorResourcesUnavailableError()
      }
    }
    return { root, worker, node, nodeVersion: manifest.nodeVersion }
  } catch { throw new ConnectorResourcesUnavailableError() }
}

export function createPackagedConnectorTransport(resourceRoot: string): PieceHostTransport {
  const resources = validateConnectorResources(resourceRoot)
  if (process.versions.electron || `v${resources.nodeVersion}` !== process.version ||
      realpathSync(process.execPath) !== realpathSync(resources.node)) throw new ConnectorResourcesUnavailableError()
  return createNodeProcessTransport(resources.worker)
}
