/** Build only the reviewed connector worker; packages must already be staged and pinned. */
import { builtinModules, createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { checkPins, parseAllowlistSource } from './check-connector-pieces.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const contained = (root, path) => {
  const value = relative(root, path)
  return !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep)
}
async function regular(path) {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Connector resource must be a regular file')
}
async function writeChanged(path, bytes) {
  try { await regular(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  try { if ((await readFile(path)).equals(Buffer.from(bytes))) return }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await rename(temporary, path)
}

export async function stageConnectorWorker(root = repository) {
  root = await realpath(root)
  const pins = JSON.parse(await readFile(join(root, 'scripts/tauri-runtime.json'), 'utf8'))
  const allowlist = parseAllowlistSource(await readFile(join(root, 'src/main/connectors/allowlist.ts'), 'utf8'))
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (checkPins(packageJson, allowlist).length) throw new Error('Connector source pins disagree with the allowlist')
  const expected = Object.fromEntries(Object.entries(allowlist.pieces).map(([name, piece]) => [name, piece.version]))
  if (Object.keys(expected).length !== Object.keys(pins.connectorDependencies ?? {}).length ||
      Object.entries(expected).some(([name, version]) => pins.connectorDependencies?.[name] !== version)) {
    throw new Error('Connector resource pins disagree with the allowlist')
  }
  const resources = join(root, 'src-tauri/resources')
  for (const path of [resources, join(resources, 'service'), join(resources, 'service/node_modules')]) {
    const details = await lstat(path)
    if (!details.isDirectory() || details.isSymbolicLink() || !contained(root, await realpath(path))) {
      throw new Error('Connector staging directories cannot be linked or escape the repository')
    }
  }
  const service = await realpath(join(resources, 'service'))
  const modules = await realpath(join(service, 'node_modules'))
  const worker = join(service, 'piece-host.cjs')
  const require = createRequire(worker)
  const sourceRequire = createRequire(join(root, 'package.json'))
  const packages = {}
  for (const [name, version] of Object.entries(expected)) {
    const directory = join(modules, name)
    const details = await lstat(directory)
    if (!details.isDirectory() || details.isSymbolicLink() || !contained(modules, await realpath(directory))) {
      throw new Error('Connector packages must be physically staged')
    }
    const metadata = join(directory, 'package.json')
    await regular(metadata)
    const manifest = JSON.parse(await readFile(metadata, 'utf8'))
    const entry = require.resolve(name)
    await regular(entry)
    if (manifest.name !== name || manifest.version !== version || !contained(await realpath(directory), await realpath(entry)) ||
        Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.optionalDependencies ?? {}).length) {
      throw new Error('Connector bundled package closure or pin changed; review before staging')
    }
    if (hash(await readFile(entry)) !== hash(await readFile(sourceRequire.resolve(name)))) {
      throw new Error('Staged connector bytes disagree with the frozen repository package')
    }
    packages[name] = { version, entry: relative(service, entry).split('\\').join('/'),
      entrySha256: hash(await readFile(entry)), metadataSha256: hash(await readFile(metadata)),
      reviewedLicenseException: allowlist.reviewedLicenseExceptions.find(item => item.package === name && item.version === version) ?? null }
  }
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)])
  const result = await build({ configFile: false, root, logLevel: 'silent',
    build: { ssr: join(root, 'src/main/connectors/piece-host/host-entry.ts'), target: 'node22', minify: false,
      write: false, sourcemap: false,
      rollupOptions: { external: id => builtins.has(id),
        output: { format: 'cjs', entryFileNames: 'piece-host.cjs', inlineDynamicImports: true } } },
    ssr: { noExternal: true } })
  const outputs = Array.isArray(result) ? result.flatMap(item => item.output) : result.output
  if (outputs.length !== 1 || outputs[0].type !== 'chunk' || outputs[0].imports.some(name => !builtins.has(name))) {
    throw new Error('Unreviewed connector worker bundle output')
  }
  await writeChanged(worker, outputs[0].code)
  const manifest = { schemaVersion: 1, nodeVersion: pins.nodeVersion, worker: 'piece-host.cjs',
    workerSha256: hash(outputs[0].code), packages, redistributionReviewComplete: false }
  await writeChanged(join(service, 'CONNECTOR_WORKER_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { staged: true, worker: 'service/piece-host.cjs', workerSha256: manifest.workerSha256,
    bytes: Buffer.byteLength(outputs[0].code), packages, redistributionReviewComplete: false }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await stageConnectorWorker(), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
