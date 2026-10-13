import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { CONNECTOR_PIECE_ALLOWLIST } from '../allowlist'
import { ConnectorResourcesUnavailableError, createPackagedConnectorTransport, validateConnectorResources } from './packaged-resources'

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

describe('connector packaged resource authority', () => {
  let root: string
  let service: string
  let manifest: { schemaVersion: number; nodeVersion: string; worker: string; workerSha256: string;
    packages: Record<string, { version: string; entry: string; entrySha256: string; metadataSha256: string }> }
  function save() { writeFileSync(join(service, 'CONNECTOR_WORKER_MANIFEST.json'), JSON.stringify(manifest)) }
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), '21x-connector-resources-')))
    service = join(root, 'service')
    mkdirSync(join(root, 'node'), { recursive: true })
    writeFileSync(join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node'), 'fixture-node-never-executed')
    mkdirSync(service, { recursive: true })
    const worker = 'module.exports = {};'
    writeFileSync(join(service, 'piece-host.cjs'), worker)
    manifest = { schemaVersion: 1, nodeVersion: '22.23.2', worker: 'piece-host.cjs', workerSha256: hash(worker), packages: {} }
    for (const [name, allowed] of Object.entries(CONNECTOR_PIECE_ALLOWLIST.pieces)) {
      const location = join(service, 'node_modules', name)
      mkdirSync(location, { recursive: true })
      const metadata = JSON.stringify({ name, version: allowed.version, main: 'index.cjs', dependencies: {} })
      writeFileSync(join(location, 'package.json'), metadata)
      writeFileSync(join(location, 'index.cjs'), 'module.exports = {};')
      manifest.packages[name] = { version: allowed.version, entry: relative(service, join(location, 'index.cjs')).split('\\').join('/'),
        metadataSha256: hash(metadata), entrySha256: hash('module.exports = {};') }
    }
    save()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('validates contained fixture resources without executing their binary or package code', () => {
    expect(validateConnectorResources(root)).toMatchObject({ root, worker: join(service, 'piece-host.cjs'), nodeVersion: '22.23.2' })
  })

  it('refuses to execute a worker through any Node binary other than the owning process', () => {
    expect(() => createPackagedConnectorTransport(root)).toThrow(ConnectorResourcesUnavailableError)
  })

  it('returns physical resource paths when the temporary directory has a system ancestor alias', () => {
    const aliases = mkdtempSync(join(tmpdir(), '21x-connector-parent-alias-'))
    const link = join(aliases, 'parent')
    try {
      symlinkSync(dirname(root), link, 'junction')
      const aliased = join(link, basename(root))
      expect(validateConnectorResources(aliased)).toMatchObject({ root, worker: join(service, 'piece-host.cjs') })
    } finally { rmSync(link, { recursive: true, force: true }); rmSync(aliases, { recursive: true, force: true }) }
  })

  it('rejects worker content that disagrees with its staged manifest', () => {
    writeFileSync(join(service, 'piece-host.cjs'), 'throw new Error("tampered fixture");')
    expect(() => validateConnectorResources(root)).toThrow(ConnectorResourcesUnavailableError)
  })

  it('rejects package content that disagrees with its staged manifest', () => {
    const entry = manifest.packages['@activepieces/piece-trello'].entry
    writeFileSync(join(service, entry), 'throw new Error("tampered fixture");')
    expect(() => validateConnectorResources(root)).toThrow(ConnectorResourcesUnavailableError)
  })

  it('rejects a changed pin even when its metadata checksum was updated', () => {
    const path = join(service, 'node_modules/@activepieces/piece-trello/package.json')
    const metadata = JSON.parse(readFileSync(path, 'utf8'))
    metadata.version = '0.6.1'
    writeFileSync(path, JSON.stringify(metadata))
    manifest.packages['@activepieces/piece-trello'].metadataSha256 = hash(readFileSync(path))
    manifest.packages['@activepieces/piece-trello'].version = '0.6.1'
    save()
    expect(() => validateConnectorResources(root)).toThrow(ConnectorResourcesUnavailableError)
  })

  it('rejects a package main entry escaping its staged package directory', () => {
    const path = join(service, 'node_modules/@activepieces/piece-trello/package.json')
    const metadata = JSON.parse(readFileSync(path, 'utf8'))
    metadata.main = '../../../outside.cjs'
    writeFileSync(join(service, 'outside.cjs'), 'module.exports = {};')
    writeFileSync(path, JSON.stringify(metadata))
    manifest.packages['@activepieces/piece-trello'].metadataSha256 = hash(readFileSync(path))
    save()
    expect(() => validateConnectorResources(root)).toThrow(ConnectorResourcesUnavailableError)
  })

  it('rejects a newly introduced dependency closure before package code can execute', () => {
    const path = join(service, 'node_modules/@activepieces/piece-trello/package.json')
    const metadata = JSON.parse(readFileSync(path, 'utf8'))
    metadata.dependencies = { 'unreviewed-package': '1.0.0' }
    writeFileSync(path, JSON.stringify(metadata))
    manifest.packages['@activepieces/piece-trello'].metadataSha256 = hash(readFileSync(path))
    save()
    expect(() => validateConnectorResources(root)).toThrow(ConnectorResourcesUnavailableError)
  })

  it('rejects extra packages in the worker manifest', () => {
    manifest.packages['unreviewed-package'] = manifest.packages['@activepieces/piece-trello']
    save()
    expect(() => validateConnectorResources(root)).toThrow(ConnectorResourcesUnavailableError)
  })

  it('rejects a linked package directory without reading or changing outside package code', () => {
    const outside = mkdtempSync(join(tmpdir(), '21x-connector-outside-'))
    const location = join(service, 'node_modules/@activepieces/piece-trello')
    const target = join(outside, 'package')
    try {
      renameSync(location, target)
      symlinkSync(target, location, 'junction')
      expect(() => validateConnectorResources(root)).toThrow(ConnectorResourcesUnavailableError)
      expect(readFileSync(join(target, 'index.cjs'), 'utf8')).toBe('module.exports = {};')
    } finally { rmSync(location, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
  })
})
