/** Explicit opt-in staging only. No shipping/default diagnostic entry changes. */
import { isBuiltin } from 'node:module'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const requiredPins = { 'better-sqlite3': '13.0.3', 'node-pty': '1.1.0', '@paralleldrive/cuid2': '2.3.1',
  '@anthropic-ai/claude-agent-sdk': '0.3.260', '@anthropic-ai/sdk': '0.123.0', '@opencode-ai/sdk': '1.18.28' }
export function validateProductionPins(pins) {
  const actual = { ...pins.nativeDependencies, ...pins.serviceDependencies, ...pins.sdkDependencies }
  if (pins.nodeVersion !== '22.23.2' || Object.keys(actual).length !== Object.keys(requiredPins).length ||
    Object.entries(requiredPins).some(([name, version]) => actual[name] !== version)) throw new Error('Production resource pins require explicit review')
  return actual
}
async function regular(file) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Production resource must be a physical regular file')
  return stat
}
export async function collectProductionClosure(resources, directory = 'service/node_modules') {
  const stat = await lstat(join(resources, directory))
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Production packages must be physical staged directories')
  const files = []
  for (const entry of await readdir(join(resources, directory), { withFileTypes: true })) {
    if (directory === 'service/node_modules' && entry.name === '.bin') continue
    const name = `${directory}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error('Production closure cannot contain package links')
    if (entry.isDirectory()) files.push(...await collectProductionClosure(resources, name))
    else if (entry.isFile()) files.push(name)
    else throw new Error('Production closure cannot contain special files')
    if (files.length > 100_000) throw new Error('Production closure exceeds manifest bound')
  }
  return files.sort()
}
async function signature(file) {
  const stat = await regular(file), hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return { sha256: hash.digest('hex'), bytes: stat.size }
}
async function writeChanged(file, bytes) {
  try { await regular(file); if ((await readFile(file)).equals(Buffer.from(bytes))) return }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, file)
}

/** No provider/SQLite execution here; preparation and platform proof are separate. */
export async function stageProductionService(root = repository) {
  root = await realpath(root)
  const pins = JSON.parse(await readFile(join(root, 'scripts/tauri-runtime.json'), 'utf8'))
  const packages = validateProductionPins(pins)
  const resources = join(root, 'src-tauri/resources')
  for (const directory of [resources, join(resources, 'node'), join(resources, 'service')]) {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Production staging directories cannot be linked')
  }
  const node = process.platform === 'win32' ? 'node/node.exe' : 'node/node'
  const credentialHelper = `native/twentyonex-credential-key${process.platform === 'win32' ? '.exe' : ''}`
  // Never search PATH, synthesize native callbacks, or build/install a helper.
  // A reviewed host must explicitly stage its real protected-key-store helper.
  await regular(join(resources, node)); await regular(join(resources, credentialHelper))
  const closure = await collectProductionClosure(resources)
  if (!closure.some(name => name.startsWith('service/node_modules/better-sqlite3/') && name.endsWith('.node'))) throw new Error('Physical staged SQLite native binary is missing')
  const prepared = JSON.parse(await readFile(join(resources, 'service/.native-prepared.json'), 'utf8'))
  if (prepared.nodeVersion !== pins.nodeVersion || prepared.platform !== process.platform || prepared.arch !== process.arch ||
    Object.entries(packages).some(([name, version]) => prepared.dependencies?.[name] !== version)) throw new Error('Standalone native preparation identity changed')
  for (const [name, version] of Object.entries(packages)) {
    const metadata = JSON.parse(await readFile(join(resources, 'service/node_modules', name, 'package.json'), 'utf8'))
    if (metadata.name !== name || metadata.version !== version) throw new Error('Physically staged production package pin changed')
  }
  const external = id => isBuiltin(id) || Object.keys(packages).some(name => id === name || id.startsWith(name + '/'))
  const entries = { node, credentialHelper, stdio: 'service/production-stdio.mjs', engine: 'service/production-engine.mjs', taskMcp: 'service/production-task-mcp.mjs' }
  const sources = { stdio: 'src/service/production-stdio.ts', engine: 'src/service/production-service.ts', taskMcp: 'src/main/mcp-servers/task-management-mcp.ts' }
  const outputs = {}
  for (const [kind, source] of Object.entries(sources)) {
    const result = await build({ configFile: false, root, logLevel: 'silent',
      plugins: [{ name: 'production-no-electron', enforce: 'pre', resolveId(id) {
        if (id === 'electron' || id.startsWith('electron/')) throw new Error('Production graph still requires an Electron host seam')
        return null
      } }],
      build: { ssr: join(root, source), target: 'node22', minify: false, write: false, sourcemap: false,
        rollupOptions: { external: kind === 'stdio' ? isBuiltin : external,
          output: { format: 'es', entryFileNames: 'entry.mjs', inlineDynamicImports: true } } }, ssr: { noExternal: true } })
    const chunks = Array.isArray(result) ? result.flatMap(item => item.output) : result.output
    if (chunks.length !== 1 || chunks[0].type !== 'chunk' || chunks[0].imports.some(id => !(kind === 'stdio' ? isBuiltin(id) : external(id)))) throw new Error('Unreviewed production bundle import: ' + kind + ' ' + JSON.stringify(chunks.map(chunk => ({ type: chunk.type, imports: chunk.imports }))))
    outputs[kind] = chunks[0].code
  }
  const buildIdentity = 'production-' + digest(Buffer.from(Object.values(outputs).join('\n'))).slice(0, 32)
  for (const [kind, bytes] of Object.entries(outputs)) await writeChanged(join(resources, entries[kind]), bytes)
  const names = [...closure, ...Object.values(entries), 'service/.native-prepared.json']
  for (const name of ['service/piece-host.cjs', 'service/CONNECTOR_WORKER_MANIFEST.json']) {
    try { await regular(join(resources, name)); names.push(name) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await signature(join(resources, name))])))
  const manifest = { version: 1, kind: 'production-resource-closure', buildIdentity, nodeVersion: pins.nodeVersion,
    platform: process.platform, arch: process.arch, entries, packages, files, redistributionReviewComplete: false }
  await mkdir(join(resources, 'service'), { recursive: true })
  const bytes = JSON.stringify(manifest, null, 2) + '\n'
  await writeChanged(join(resources, 'service/PRODUCTION_RESOURCE_MANIFEST.json'), bytes)
  return { staged: true, entry: entries.stdio, buildIdentity, resourceManifestSha256: digest(bytes), redistributionReviewComplete: false }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await stageProductionService(), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
