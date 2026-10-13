/** Thin entry: only Node builtins and pure descriptor validators may load here.
 * The separately bundled engine (SQLite/vendor SDKs) loads after verification. */
import { createHash } from 'node:crypto'
import { createReadStream, fstatSync } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Socket } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isProductionLaunchDescriptor, PRODUCTION_DESCRIPTOR_MAX_BYTES, type ProductionLaunchDescriptor } from '../shared/production-bootstrap'
import { hasExactKeys, isRecord } from '../shared/service-protocol'

export const PRODUCTION_RESOURCE_PINS = Object.freeze({
  'better-sqlite3': '13.0.3', 'node-pty': '1.1.0', '@paralleldrive/cuid2': '2.3.1',
  '@anthropic-ai/claude-agent-sdk': '0.3.260', '@anthropic-ai/sdk': '0.123.0', '@opencode-ai/sdk': '1.18.28'
})
export class ProductionBootstrapError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProductionBootstrapError' }
}
function fail(code: string): never { throw new ProductionBootstrapError(code) }
const within = (root: string, path: string): boolean => {
  const value = relative(root, path)
  return !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep)
}
const resourceName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && name.length < 4096 &&
  !name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && name.split('/').every(part => part !== '' && part !== '.' && part !== '..')
async function canonicalFuture(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return join(await canonicalFuture(dirname(path)), basename(path))
  }
}
async function resourceFile(root: string, name: string): Promise<string> {
  if (!resourceName(name)) return fail('RESOURCE_PATH_INVALID')
  const file = join(root, name)
  let current = root
  for (const part of name.split('/')) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) fail('RESOURCE_LINK_REJECTED')
  }
  const stat = await lstat(file)
  if (!stat.isFile() || !within(root, await realpath(file))) fail('RESOURCE_PATH_INVALID')
  return file
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}
async function moduleFiles(root: string, name = 'service/node_modules'): Promise<string[]> {
  const entries = await readdir(join(root, name), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    // npm executable links are not added to PATH or executed by this entry.
    if (name === 'service/node_modules' && entry.name === '.bin') continue
    const child = `${name}/${entry.name}`
    if (entry.isSymbolicLink()) fail('RESOURCE_LINK_REJECTED')
    if (entry.isDirectory()) files.push(...await moduleFiles(root, child))
    else if (entry.isFile()) files.push(child)
    else fail('RESOURCE_PATH_INVALID')
    if (files.length > 100_000) fail('RESOURCE_CLOSURE_TOO_LARGE')
  }
  return files
}
export interface VerifiedProductionResources { node: string; engine: string; credentialHelper: string; taskMcp: string }
/** The host pins manifest bytes privately. This verifies every runtime byte,
 * physical package pin and write/resource separation before any native load. */
export async function verifyProductionResources(descriptor: ProductionLaunchDescriptor, runtime = {
  nodeVersion: process.version, platform: process.platform, arch: process.arch, executable: process.execPath,
  environment: process.env, electron: !!process.versions.electron
}): Promise<VerifiedProductionResources> {
  if (!isProductionLaunchDescriptor(descriptor)) fail('DESCRIPTOR_INVALID')
  if (runtime.electron || runtime.nodeVersion !== 'v22.23.2' || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].some(name => runtime.environment[name] !== undefined)) fail('RUNTIME_IDENTITY_INVALID')
  const root = await realpath(descriptor.paths.resourceRoot)
  if ((await lstat(descriptor.paths.resourceRoot)).isSymbolicLink()) fail('RESOURCE_LINK_REJECTED')
  for (const [name, path] of Object.entries(descriptor.paths)) {
    if (name === 'resourceRoot') continue
    const canonical = await canonicalFuture(path)
    if (within(root, canonical) || within(canonical, root)) fail('PROFILE_RESOURCE_OVERLAP')
  }
  const manifestFile = await resourceFile(root, 'service/PRODUCTION_RESOURCE_MANIFEST.json')
  if ((await lstat(manifestFile)).size > 32 * 1024 * 1024 || await hashFile(manifestFile) !== descriptor.resourceManifestSha256) fail('RESOURCE_MANIFEST_CHANGED')
  const manifest: unknown = JSON.parse(await readFile(manifestFile, 'utf8'))
  if (!isRecord(manifest) || !hasExactKeys(manifest, ['version', 'kind', 'buildIdentity', 'nodeVersion', 'platform', 'arch', 'entries', 'packages', 'files', 'redistributionReviewComplete']) ||
    manifest.version !== 1 || manifest.kind !== 'production-resource-closure' || manifest.buildIdentity !== descriptor.buildIdentity || manifest.nodeVersion !== '22.23.2' ||
    manifest.platform !== runtime.platform || manifest.arch !== runtime.arch || manifest.redistributionReviewComplete !== false || !isRecord(manifest.entries) ||
    !hasExactKeys(manifest.entries, ['node', 'engine', 'stdio', 'credentialHelper', 'taskMcp']) || !isRecord(manifest.packages) || !isRecord(manifest.files) || Object.keys(manifest.files).length > 100_000) fail('RESOURCE_MANIFEST_INVALID')
  const entries = manifest.entries
  const nodeName = runtime.platform === 'win32' ? 'node/node.exe' : 'node/node'
  const helperName = `native/twentyonex-credential-key${runtime.platform === 'win32' ? '.exe' : ''}`
  if (entries.node !== nodeName || entries.engine !== 'service/production-engine.mjs' || entries.stdio !== 'service/production-stdio.mjs' || entries.credentialHelper !== helperName || entries.taskMcp !== 'service/production-task-mcp.mjs') fail('RESOURCE_MANIFEST_INVALID')
  if (!hasExactKeys(manifest.packages, Object.keys(PRODUCTION_RESOURCE_PINS))) fail('RESOURCE_PIN_CHANGED')
  for (const [name, version] of Object.entries(PRODUCTION_RESOURCE_PINS)) {
    if (manifest.packages[name] !== version) fail('RESOURCE_PIN_CHANGED')
    const metadata = JSON.parse(await readFile(await resourceFile(root, `service/node_modules/${name}/package.json`), 'utf8')) as { name?: unknown; version?: unknown }
    if (metadata.name !== name || metadata.version !== version) fail('RESOURCE_PIN_CHANGED')
  }
  for (const [name, signature] of Object.entries(manifest.files)) {
    if (!isRecord(signature) || !hasExactKeys(signature, ['sha256', 'bytes']) || typeof signature.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(signature.sha256) ||
      !Number.isSafeInteger(signature.bytes) || (signature.bytes as number) < 0) fail('RESOURCE_MANIFEST_INVALID')
    const file = await resourceFile(root, name)
    if ((await lstat(file)).size !== signature.bytes || await hashFile(file) !== signature.sha256) fail('RESOURCE_BYTES_CHANGED')
  }
  const closure = await moduleFiles(root)
  if (closure.some(name => !Object.hasOwn(manifest.files as object, name)) || Object.keys(manifest.files).filter(name => name.startsWith('service/node_modules/')).length !== closure.length ||
    !closure.some(name => name.startsWith('service/node_modules/better-sqlite3/') && name.endsWith('.node'))) fail('RESOURCE_CLOSURE_INCOMPLETE')
  for (const name of Object.values(entries)) if (typeof name !== 'string' || !Object.hasOwn(manifest.files, name)) fail('RESOURCE_CLOSURE_INCOMPLETE')
  if (descriptor.capabilities.connectors === 'enabled' && ['service/piece-host.cjs', 'service/CONNECTOR_WORKER_MANIFEST.json'].some(name => !Object.hasOwn(manifest.files as object, name))) fail('CONNECTOR_RESOURCE_UNPINNED')
  if (!Object.hasOwn(manifest.files, 'service/.native-prepared.json')) fail('RESOURCE_CLOSURE_INCOMPLETE')
  const prepared: unknown = JSON.parse(await readFile(await resourceFile(root, 'service/.native-prepared.json'), 'utf8'))
  if (!isRecord(prepared) || prepared.nodeVersion !== '22.23.2' || prepared.platform !== runtime.platform || prepared.arch !== runtime.arch || !isRecord(prepared.dependencies) ||
    Object.entries(PRODUCTION_RESOURCE_PINS).some(([name, version]) => (prepared.dependencies as Record<string, unknown>)[name] !== version)) fail('RESOURCE_PIN_CHANGED')
  const node = await resourceFile(root, nodeName)
  if (await realpath(runtime.executable) !== node) fail('RUNTIME_IDENTITY_INVALID')
  return { node, engine: await resourceFile(root, entries.engine as string), credentialHelper: await resourceFile(root, helperName), taskMcp: await resourceFile(root, entries.taskMcp as string) }
}

/** Descriptor is a private anonymous pipe, not argv/environment/a disk file. */
export async function readProductionDescriptor(fd = 3): Promise<ProductionLaunchDescriptor> {
  if (process.platform !== 'win32') {
    const stat = fstatSync(fd)
    if (!stat.isFIFO() && !stat.isSocket()) fail('PRIVATE_DESCRIPTOR_REQUIRED')
  }
  // Node's handle type check rejects regular files even on Windows.
  const pipe = new Socket({ fd, readable: true, writable: false })
  const chunks: Buffer[] = []
  let size = 0
  const timer = setTimeout(() => pipe.destroy(new ProductionBootstrapError('DESCRIPTOR_TIMEOUT')), 30_000)
  try {
    for await (const bytes of pipe) {
      const chunk = Buffer.from(bytes as Uint8Array); size += chunk.length
      if (size > PRODUCTION_DESCRIPTOR_MAX_BYTES) fail('DESCRIPTOR_TOO_LARGE')
      chunks.push(chunk)
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    if (!isProductionLaunchDescriptor(value)) fail('DESCRIPTOR_INVALID')
    return value
  } finally { clearTimeout(timer); pipe.destroy(); for (const chunk of chunks) chunk.fill(0) }
}

export async function startProductionStdio(): Promise<void> {
  for (const fd of [0, 1]) {
    const stat = fstatSync(fd)
    if (process.platform !== 'win32' && !stat.isFIFO() && !stat.isSocket()) fail('PRIVATE_STDIO_REQUIRED')
  }
  if (process.stdin.isTTY || process.stdout.isTTY) fail('PRIVATE_STDIO_REQUIRED')
  const descriptor = await readProductionDescriptor()
  const resources = await verifyProductionResources(descriptor)
  // Credentials are loaded by the protected store. A private launch cannot use
  // inherited model/API tokens as a second unreviewed credential transport.
  if (Object.keys(process.env).some(name => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|PRIVATE_KEY|PASSWORD|GITHUB_TOKEN|TASK_API_TOKEN)$/i.test(name))) fail('CREDENTIAL_ENVIRONMENT_REJECTED')
  const nativeNames = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'])
  for (const name of Object.keys(process.env)) if (!nativeNames.has(name)) delete process.env[name]
  // No stdout logging or raw provider errors can corrupt/private-leak the wire.
  for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) console[method] = () => { process.stderr.write('PRODUCTION_DIAGNOSTIC\n') }
  const engineUrl = pathToFileURL(resources.engine).href
  const engine = await import(/* @vite-ignore */ engineUrl) as typeof import('./production-service')
  const close = (): void => { void service.close().catch(() => { process.stderr.write('PRODUCTION_DRAIN_BLOCKED\n'); process.exitCode = 1 }) }
  const service = engine.createStagedProductionService(descriptor, resources, {
    write: bytes => new Promise<void>((done, reject) => { process.stdout.write(bytes, error => error ? reject(error) : done()) }),
    onDisconnect: close, onShutdownRequested: () => { process.stdin.pause(); process.stdout.end(); process.exitCode = 0 }
  })
  process.stdin.on('data', (bytes: Buffer) => service.peer.receive(bytes))
  process.stdin.on('end', () => { service.peer.disconnect(); close() })
  process.stdin.on('error', () => { service.peer.disconnect(); close() })
  process.stdout.on('error', () => { service.peer.disconnect(); close() })
  process.on('SIGTERM', close); process.on('SIGINT', close)
  process.stdin.resume()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startProductionStdio().catch(() => { process.stderr.write('PRODUCTION_BOOTSTRAP_FAILED\n'); process.exitCode = 1 })
}
