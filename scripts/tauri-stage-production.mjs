/** Explicit opt-in staging only. No shipping/default diagnostic entry changes. */
import { isBuiltin } from 'node:module'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile, rm } from 'node:fs/promises'
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

/** Only prior generated receipts or exact outputs permit worker replacement. */
export async function stageProductionVoiceWorkers(resources, outputs) {
  let prior = {}
  try { prior = JSON.parse(await readFile(join(resources, 'service/PRODUCTION_RESOURCE_MANIFEST.json'), 'utf8')).files ?? {} }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const files = { voiceWorker: 'service/voice-worker.cjs', voiceTtsWorker: 'service/voice-tts-worker.cjs' }
  for (const [kind, name] of Object.entries(files)) {
    const bytes = Buffer.from(outputs[kind])
    if (!bytes.length || bytes.length > 512 * 1024) throw new Error('Voice worker exceeds resource bounds')
    try {
      const actual = await signature(join(resources, name)), receipt = prior[name]
      if (!(actual.sha256 === digest(bytes) && actual.bytes === bytes.length) &&
        (!receipt || actual.sha256 !== receipt.sha256 || actual.bytes !== receipt.bytes)) throw new Error('Unowned voice worker staging files were preserved')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const [kind, name] of Object.entries(files)) await writeChanged(join(resources, name), outputs[kind])
}

/** Materialize only a bounded browser build snapshot, preserving unowned files. */
export async function stageProductionMobile(resources, outputs) {
  const files = new Map()
  let total = 0
  for (const output of outputs) {
    const name = output.fileName
    if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || files.has(name)) throw new Error('Mobile build contains an invalid or duplicate resource path')
    const body = output.type === 'chunk' ? output.code : output.type === 'asset' ? output.source : undefined
    if (typeof body !== 'string' && !(body instanceof Uint8Array)) throw new Error('Mobile build contains an invalid resource')
    const bytes = Buffer.from(body)
    total += bytes.length
    if (bytes.length > 8 * 1024 * 1024 || total > 32 * 1024 * 1024 || files.size >= 512) throw new Error('Mobile build exceeds resource bounds')
    files.set(name, bytes)
  }
  if (!files.has('index.html')) throw new Error('Mobile build has no entry document')
  const destination = join(resources, 'mobile')
  let prior = {}
  try { prior = JSON.parse(await readFile(join(resources, 'service/PRODUCTION_RESOURCE_MANIFEST.json'), 'utf8')).files ?? {} }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  let existing = []
  try { existing = await collectProductionClosure(resources, 'mobile') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const name of existing) {
    const receipt = prior[name]
    const actual = await signature(join(resources, name))
    const generated = files.get(name.slice('mobile/'.length))
    const exactOutput = generated && digest(generated) === actual.sha256 && generated.length === actual.bytes
    if (!exactOutput && (!receipt || receipt.sha256 !== actual.sha256 || receipt.bytes !== actual.bytes)) throw new Error('Unowned mobile staging files were preserved')
  }
  await mkdir(destination, { recursive: true })
  for (const [name, bytes] of files) {
    const directory = join(destination, dirname(name))
    await mkdir(directory, { recursive: true })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Mobile staging directories cannot be linked')
    await writeChanged(join(destination, name), bytes)
  }
  for (const name of existing) if (!files.has(name.slice('mobile/'.length))) await rm(join(resources, name))
  return [...files.keys()].sort().map(name => `mobile/${name}`)
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
  const entries = { node, credentialHelper, mobile: 'mobile/index.html', stdio: 'service/production-stdio.mjs', engine: 'service/production-engine.mjs', taskMcp: 'service/production-task-mcp.mjs', voiceWorker: 'service/voice-worker.cjs', voiceTtsWorker: 'service/voice-tts-worker.cjs' }
  const sources = { stdio: 'src/service/production-stdio.ts', engine: 'src/service/production-service.ts', taskMcp: 'src/main/mcp-servers/task-management-mcp.ts' }
  const outputs = {}
  // These existing isolated workers are CommonJS resources. Their exact bytes
  // participate in the same trusted closure as the service and bundled Node.
  for (const [kind, source] of Object.entries({ voiceWorker: 'src/main/voice/voice-worker.js', voiceTtsWorker: 'src/main/voice/voice-tts-worker.js' })) {
    const file = join(root, source)
    if ((await regular(file)).size > 512 * 1024) throw new Error('Voice worker exceeds resource bounds')
    outputs[kind] = await readFile(file, 'utf8')
  }
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
  const browser = await build({ configFile: join(root, 'vite.mobile.config.ts'), root: join(root, 'src/mobile'), logLevel: 'silent', build: { write: false } })
  const mobileOutputs = Array.isArray(browser) ? browser.flatMap(item => item.output) : browser.output
  const mobileFiles = await stageProductionMobile(resources, mobileOutputs)
  const mobileIdentity = digest(Buffer.from((await Promise.all(mobileFiles.map(async name => name + ':' + (await signature(join(resources, name))).sha256))).join('\n')))
  const buildIdentity = 'production-' + digest(Buffer.from(Object.values(outputs).join('\n') + '\n' + mobileIdentity)).slice(0, 32)
  await stageProductionVoiceWorkers(resources, outputs)
  for (const [kind, bytes] of Object.entries(outputs)) if (!['voiceWorker', 'voiceTtsWorker'].includes(kind)) await writeChanged(join(resources, entries[kind]), bytes)
  const names = [...closure, ...mobileFiles, ...Object.values(entries), 'service/.native-prepared.json']
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
