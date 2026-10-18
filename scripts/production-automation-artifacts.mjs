/** Artifact check, paired with real production peer rejection tests. A string
 * scan alone is not proof of installed native dispatch or OS authorization. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const forbidden = ['__TWENTYONEX_DATABASE_SMOKE__', 'TWENTYONEX_NATIVE_SMOKE_REPORT', 'syntheticDesktopProof',
  'engine.fixture.start', 'engine.fixture.cooperative', 'engine.fixture.crash', 'engine.fixture.hang', 'engine.probe', 'engine_invoke']
export function assertNoProductionAutomation(bytes) {
  const body = Buffer.from(bytes).toString('utf8')
  if (forbidden.some(name => body.includes(name))) throw new Error('Diagnostic automation found in a production artifact')
}
function receipt(root, file) {
  const full = join(root, file), stat = lstatSync(full)
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(full) !== full || stat.size > 32 * 1024 * 1024) throw new Error('Artifact must be a bounded physical file')
  const bytes = readFileSync(full)
  return { bytes, signature: { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
}
function frontend(root, path) {
  const files = []
  function collect(directory) {
    const full = join(root, directory), stat = lstatSync(full)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(full) !== full) throw new Error('Artifact directories must be physical')
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Linked artifact refused')
      if (entry.isDirectory()) collect(join(directory, entry.name))
      else if (/\.(?:js|html)$/.test(entry.name)) files.push(receipt(root, join(directory, entry.name)))
      if (files.length > 512) throw new Error('Frontend artifact closure exceeds bounds')
    }
  }
  collect(path)
  if (!files.some(file => file.signature.path === join(path, 'index.html')) || !files.some(file => file.signature.path.endsWith('.js'))) throw new Error('Build both complete frontend entries first')
  if (files.reduce((total, file) => total + file.bytes.length, 0) > 32 * 1024 * 1024) throw new Error('Frontend artifact closure exceeds bounds')
  return files
}
export function inspectProductionAutomationArtifacts(root = repository) {
  root = realpathSync(root)
  const production = frontend(root, 'out/tauri-production-renderer')
  const diagnostic = frontend(root, 'out/tauri-renderer')
  if (!diagnostic.some(file => file.bytes.includes(Buffer.from('__TWENTYONEX_DATABASE_SMOKE__')))) throw new Error('Diagnostic frontend positive control missing')
  for (const file of production) assertNoProductionAutomation(file.bytes)
  const manifestFile = receipt(root, 'src-tauri/resources/service/PRODUCTION_RESOURCE_MANIFEST.json')
  const manifest = JSON.parse(manifestFile.bytes.toString('utf8'))
  const service = ['production-stdio.mjs', 'production-engine.mjs'].map(name => receipt(root, `src-tauri/resources/service/${name}`))
  for (const file of service) {
    assertNoProductionAutomation(file.bytes)
    const signature = manifest.files?.[file.signature.path.slice('src-tauri/resources/'.length)]
    if (signature?.sha256 !== file.signature.sha256 || signature?.bytes !== file.signature.bytes) throw new Error('Production artifact differs from staged manifest')
  }
  return { version: 1, production: production.map(file => file.signature), diagnosticPositiveControl: diagnostic.map(file => file.signature),
    service: service.map(file => file.signature), manifest: manifestFile.signature, buildIdentity: manifest.buildIdentity,
    nativeSourcePolicy: ['src-tauri/src/main.rs', 'src-tauri/src/production_host.rs', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.production.conf.json'].map(file => receipt(root, file).signature),
    limitation: 'Built frontend/Source artifact and real-peer checks; installed native/platform authorization remains separate evidence.' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.some(arg => !arg.startsWith('--report=')) || args.length > 1) throw new Error('Use --report=path')
    const report = inspectProductionAutomationArtifacts()
    if (args.length) writeFileSync(resolve(args[0].slice('--report='.length)), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ productionFrontendFiles: report.production.length, serviceFiles: report.service.length, diagnosticPositiveControl: true, buildIdentity: report.buildIdentity }))
  } catch { console.error('Production automation artifact check failed; build/stage both reviewed entries and inspect the artifact boundary.'); process.exitCode = 1 }
}
