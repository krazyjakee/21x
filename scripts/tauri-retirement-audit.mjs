/** Read-only source audit. Declared fixture bindings never establish production readiness. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { scanRepository } from './tauri-inventory.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function literalList(file, variable) {
  const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  let result
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variable) {
      let value = node.initializer
      while (value && (ts.isAsExpression(value) || ts.isParenthesizedExpression(value) || ts.isSatisfiesExpression(value))) value = value.expression
      if (!value || !ts.isArrayLiteralExpression(value) || !value.elements.every(ts.isStringLiteral)) throw new Error(`Review nonliteral binding list: ${file}:${variable}`)
      result = value.elements.map(item => item.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!result) throw new Error(`Missing binding list: ${file}:${variable}`)
  return result
}
const manifest = JSON.parse(readFileSync(resolve(root, 'docs/tauri-migration/operations.json'), 'utf8'))
const retained = manifest.operations.filter(operation => operation.disposition === 'retained')
const database = literalList('src/shared/database-desktop-codecs.ts', 'DATABASE_DESKTOP_OPERATIONS')
const agent = literalList('src/shared/agent-desktop-codecs.ts', 'AGENT_DESKTOP_OPERATIONS')
const configuration = literalList('src/shared/configuration-desktop-codecs.ts', 'CONFIGURATION_DESKTOP_OPERATIONS').filter(name => !name.startsWith('agent:'))
const debugSlice = [...new Set([...database, ...configuration, ...agent])].sort()
const scoped = debugSlice
const commands = retained.filter(operation => operation.kind === 'command').map(operation => operation.name).sort()
if (scoped.some(name => !commands.includes(name))) throw new Error('Binding inventory disagrees with retained commands')
const inventory = scanRepository(root)
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const runtimeImports = inventory.electronImports.filter(entry => entry.mode !== 'type-only')
const report = {
  reportVersion: 1,
  sourceFilesSha256: Object.fromEntries([
    'package.json', 'vite.tauri.config.ts', 'src-tauri/tauri.conf.json',
    'src/service/database-service.ts', 'src/service/configuration-backend.ts', 'src/service/agent-backend.ts',
    'src/main/node-worker-runtime.ts',
    'src/main/connectors/piece-host/node-transport.ts', 'src/main/connectors/piece-host/host-entry.ts',
    'src/main/connectors/piece-host/worker-environment.ts', 'src/main/connectors/piece-host/client.ts',
    'src/main/connectors/bridge/runtime.ts', 'src/main/connectors/bridge/scheduler.ts', 'src/main/connectors/oauth.ts',
    'src/main/connectors/bridge/engine.ts', 'src/main/plugins/connector-bridge-plugin.ts',
    'src/main/sync-manager.ts', 'src/main/index.ts',
    'src/main/oauth/connector-oauth-flow.ts', 'src/main/oauth/local-oauth-server.ts',
    'src-tauri/src/main.rs', 'src-tauri/src/artifact_proof.rs', 'src-tauri/src/artifact-denial-matcher.js',
    'src-tauri/src/artifact-proof.js', 'src-tauri/src/artifact-frame-proof.js',
    'scripts/tauri-packaged-smoke.py', 'scripts/tauri-retirement-audit.mjs',
    'src/shared/database-desktop-codecs.ts', 'src/shared/configuration-desktop-codecs.ts', 'src/shared/agent-desktop-codecs.ts',
    'src-tauri/engine/src/desktop.rs', 'src-tauri/engine/src/configuration_desktop.rs', 'src-tauri/engine/src/agent_desktop.rs',
    'src/renderer/src/lib/ipc-client.ts', 'docs/tauri-migration/operations.json'
  ].map(file => [file, createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')])),
  sourceInventorySha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
  productionReady: false,
  electronRetirementReady: false,
  methodology: 'Source inventory and explicit scoped codec lists, reviewed against current synthetic service/native bootstrap. Counts are declarations, not production authority, complete semantics, installed evidence or a gate pass. The 18 content-only configuration bindings share the packaged synthetic database and exact native policy; Agent CRUD and lifecycle settings remain unbound.',
  retainedCommands: commands.length,
  retainedEvents: retained.filter(operation => operation.kind === 'event').length,
  scopedBindingDeclarations: scoped.length,
  packagedSyntheticAgentCommandDeclarations: debugSlice.length,
  configurationProofOnlyCommands: [],
  packagedSyntheticContentConfigurationCommands: configuration,
  missingPackagedCommands: commands.filter(name => !debugSlice.includes(name)),
  commandsWithoutScopedBindingDeclaration: commands.filter(name => !scoped.includes(name)),
  retirement: {
    electronPackages: Object.fromEntries(Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name]) => /^(electron(?:-|$)|@electron(?:\/|-))/.test(name))),
    electronPackageScripts: Object.fromEntries(Object.entries(pkg.scripts).filter(([, command]) => /electron|rebuild-native|scripts\/release\.sh/.test(command))),
    runtimeElectronImportCount: runtimeImports.length,
    runtimeElectronImportFiles: [...new Set(runtimeImports.map(entry => entry.file))].sort(),
    directElectronApiConsumerCount: inventory.electronAPIConsumers.length,
    directElectronApiConsumerFiles: [...new Set(inventory.electronAPIConsumers.map(entry => entry.file))].sort(),
    shippingMain: pkg.main,
    shippingAppId: pkg.build?.appId,
    tauriAppId: JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8')).identifier,
    retainedLegacyArtifacts: ['scripts/credential-proof/electron.cjs', 'src/main/platform/electron-secret-storage.ts', 'src/main/platform/credential-migration.ts', 'src/main/app-identity-migration.ts'],
    removalOrder: ['accept G0/G1 decisions and contracts', 'accept G2/G3 installed feature/security/lifecycle parity', 'accept G4 profile/install/update/recovery rehearsal', 'switch production entrypoints and distribution', 'remove Electron shipping dependencies, preload and runtime imports', 'replace test/native rebuild/release tooling', 'retain supported legacy importer and evidence separately', 'complete final G5 audit and architecture documentation']
  }
}
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/tauri-retirement-audit.mjs [--output PATH]')
if (args.length) writeFileSync(resolve(args[1]), JSON.stringify(report, null, 2) + '\n')
else process.stdout.write(JSON.stringify(report, null, 2) + '\n')
