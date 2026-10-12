/** Preserve redistribution notices; declarations alone are not license clearance. */
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resourceRoot = join(project, 'src-tauri/resources')
const pins = JSON.parse(await readFile(join(project, 'scripts/tauri-runtime.json'), 'utf8'))
const nodeLicense = {
  version: '22.23.2',
  source: 'https://raw.githubusercontent.com/nodejs/node/v22.23.2/LICENSE',
  sha256: 'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4'
}
if (pins.nodeVersion !== nodeLicense.version || process.version !== `v${nodeLicense.version}`) {
  throw new Error('Notice staging requires the pinned standalone Node runtime')
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function writeChanged(path, bytes) {
  try { if ((await readFile(path)).equals(Buffer.from(bytes))) return }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(path, bytes)
}
let nodeNotice
for (const directory of [dirname(process.execPath), dirname(dirname(process.execPath))]) {
  try {
    const value = await readFile(join(directory, 'LICENSE'))
    if (hash(value) === nodeLicense.sha256) { nodeNotice = value; break }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
if (!nodeNotice) {
  const response = await fetch(nodeLicense.source, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('Pinned Node notice download failed')
  nodeNotice = Buffer.from(await response.arrayBuffer())
  if (nodeNotice.length > 200_000 || hash(nodeNotice) !== nodeLicense.sha256) {
    throw new Error('Pinned Node redistribution notice integrity mismatch')
  }
}
await writeChanged(join(resourceRoot, 'node/LICENSE'), nodeNotice)

const packages = []
async function inspectPackage(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const notices = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(license|copying|notice|copyright)([._-].*)?$/i.test(entry.name)) {
      const path = join(directory, entry.name)
      notices.push({ path: relative(resourceRoot, path).split('\\').join('/'),
        sha256: hash(await readFile(path)) })
    }
  }
  packages.push({ name: manifest.name, version: manifest.version,
    declaredLicense: manifest.license ?? null,
    location: relative(resourceRoot, directory).split('\\').join('/'), notices })
  await inspectModules(join(directory, 'node_modules'))
}
async function inspectModules(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) throw new Error('Staged dependency tree cannot contain linked packages: ' +
      JSON.stringify(relative(resourceRoot, join(directory, entry.name)).split('\\').join('/')))
    if (!entry.isDirectory()) continue
    const path = join(directory, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(path, { withFileTypes: true })) {
        if (scoped.isSymbolicLink()) throw new Error('Staged scoped package cannot be linked: ' +
          JSON.stringify(relative(resourceRoot, join(path, scoped.name)).split('\\').join('/')))
        if (scoped.isDirectory()) await inspectPackage(join(path, scoped.name))
      }
    } else await inspectPackage(path)
  }
}
await inspectModules(join(resourceRoot, 'service/node_modules'))
packages.sort((left, right) => left.location.localeCompare(right.location))
const missingNoticeFiles = packages.filter(item => item.notices.length === 0)
const sdk = packages.find(item => item.name === '@anthropic-ai/claude-agent-sdk')
const report = {
  schemaVersion: 1, node: { ...nodeLicense, bundledNotice: 'node/LICENSE' }, packages,
  redistributionReview: {
    complete: false,
    reason: 'Preserved notices and package declarations are an inventory; distribution terms and missing notice files still require review.',
    missingNoticeFiles: missingNoticeFiles.map(item => ({ name: item.name, version: item.version })),
    proprietaryAgentSdk: sdk ? { name: sdk.name, version: sdk.version, declaredLicense: sdk.declaredLicense,
      terms: 'https://code.claude.com/docs/en/legal-and-compliance' } : null
  }
}
const bytes = JSON.stringify(report, null, 2) + '\n'
await writeChanged(join(resourceRoot, 'service/THIRD_PARTY_NOTICES.json'), bytes)
process.stdout.write(bytes)
