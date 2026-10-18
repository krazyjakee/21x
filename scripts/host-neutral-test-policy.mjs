/** Review the complete test inventory; new Electron edges require an explicit decision. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const portablePath = path => path.split(sep).join('/')
const isElectron = name => /^(?:electron(?:$|[-/])|@electron(?:$|[-/]))/.test(name)

export const HOST_NEUTRAL_PROOF_FILES = {
  'scripts/production-service-proof.test.ts': 'TAURI_PRODUCTION_SERVICE_PROOFS',
  'scripts/production-terminal-proof.test.ts': 'TAURI_TERMINAL_PROOFS',
  'scripts/production-payload-recovery-proof.test.ts': 'TAURI_TERMINAL_PROOFS',
  'scripts/database-service-proof.test.ts': 'TAURI_STANDALONE_SERVICE_PROOFS',
  'scripts/configuration-service-proof.test.ts': 'TAURI_STANDALONE_SERVICE_PROOFS',
  'scripts/transcript-page-proof.test.ts': 'TAURI_STANDALONE_SERVICE_PROOFS',
  'scripts/connector-worker-service-proof.test.ts': 'TAURI_STANDALONE_SERVICE_PROOFS'
}

export function scanTestInventory(root = repositoryRoot) {
  root = resolve(root)
  const sources = []
  function collect(directory) {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Test inventory requires physical source paths')
      if (entry.isDirectory()) collect(file)
      else if (/\.test\.(?:ts|tsx|mjs)$/.test(entry.name)) sources.push(file)
    }
  }
  for (const directory of ['src', 'scripts', 'test']) collect(resolve(root, directory))
  const cache = new Map()
  function local(importer, name) {
    const candidate = name.startsWith('.') ? resolve(dirname(importer), name)
      : name.startsWith('@shared/') ? resolve(root, 'src/shared', name.slice(8))
      : name.startsWith('@/') ? resolve(root, 'src/renderer/src', name.slice(2)) : null
    if (!candidate) return null
    const candidates = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs'].map(extension => candidate + extension)
    if (candidate.endsWith('.js')) candidates.push(candidate.slice(0, -3) + '.ts', candidate.slice(0, -3) + '.tsx')
    const path = candidates.find(file => existsSync(file) && statSync(file).isFile() && !file.endsWith('.d.ts'))
    if (path && (isAbsolute(relative(root, path)) || relative(root, path).startsWith('..'))) throw new Error('Test imports must stay inside the repository')
    return path
  }
  function dependencies(file) {
    if (cache.has(file)) return cache.get(file)
    if (lstatSync(file).isSymbolicLink()) throw new Error('Test dependencies require physical source paths')
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const output = []
    function add(name) {
      if (isElectron(name)) output.push({ electron: name })
      else { const path = local(file, name); if (path) output.push({ path }) }
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) && (!node.importClause || !node.importClause.isTypeOnly &&
        (node.importClause.name || !node.importClause.namedBindings || !ts.isNamedImports(node.importClause.namedBindings) || node.importClause.namedBindings.elements.length === 0 || node.importClause.namedBindings.elements.some(item => !item.isTypeOnly))) && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text)
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) &&
        (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.length === 0 || node.exportClause.elements.some(item => !item.isTypeOnly))) add(node.moduleSpecifier.text)
      if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) add(node.moduleReference.expression.text)
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require' ||
        ts.isPropertyAccessExpression(node.expression) && ['importActual', 'require'].includes(node.expression.name.text)) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(tree); cache.set(file, output); return output
  }
  return sources.sort().map(file => {
    const pending = [[file]], seen = new Set()
    let electronTrace
    while (pending.length && !electronTrace) {
      const chain = pending.shift(), next = chain.at(-1)
      if (seen.has(next)) continue
      seen.add(next)
      for (const dependency of dependencies(next)) {
        if (dependency.electron) { electronTrace = [...chain.map(path => portablePath(relative(root, path))), dependency.electron]; break }
        pending.push([...chain, dependency.path])
      }
    }
    return { file: portablePath(relative(root, file)), framework: file.endsWith('.mjs') ? 'node:test' : 'vitest',
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), ...(electronTrace ? { electronTrace } : {}) }
  })
}

export function reviewTestInventory(root = repositoryRoot) {
  const policy = JSON.parse(readFileSync(resolve(root, 'test/electron-transition-tests.json'), 'utf8'))
  if (policy.version !== 1 || !Array.isArray(policy.historical) || !Array.isArray(policy.importDenialControls)) throw new Error('Invalid test cohort policy')
  const historical = new Map(policy.historical.map(row => [row.file, row.reason]))
  const controls = new Map(policy.importDenialControls.map(row => [row.file, row.reason]))
  if (historical.size !== policy.historical.length || controls.size !== policy.importDenialControls.length ||
    [...historical].some(([file]) => controls.has(file)) ||
    [...historical, ...controls].some(([file, reason]) => typeof file !== 'string' || typeof reason !== 'string' || !reason.trim())) throw new Error('Duplicate or unexplained test cohort')
  const inventory = scanTestInventory(root), files = new Set(inventory.map(row => row.file))
  if ([...historical.keys(), ...controls.keys()].some(file => !files.has(file))) throw new Error('Stale test cohort policy')
  return inventory.map(row => {
    if (row.electronTrace && !historical.has(row.file) && !controls.has(row.file)) throw new Error(`Unreviewed Electron test dependency: ${row.file}`)
    if (!row.electronTrace && (historical.has(row.file) || controls.has(row.file))) throw new Error(`Remove obsolete Electron test quarantine: ${row.file}`)
    return { ...row, cohort: historical.has(row.file) ? 'historical-electron' : 'host-neutral',
      ...(historical.has(row.file) ? { reason: historical.get(row.file) } : controls.has(row.file) ? { reason: controls.get(row.file) } : {}) }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2).filter(arg => arg !== '--')
    if (args.some(arg => arg !== '--check' && !arg.startsWith('--report='))) throw new Error('Use --check or --report=path')
    const rows = reviewTestInventory(), report = { version: 1, tests: rows,
      summary: { hostNeutral: rows.filter(row => row.cohort === 'host-neutral').length, historicalElectron: rows.filter(row => row.cohort === 'historical-electron').length } }
    const output = args.find(arg => arg.startsWith('--report='))?.slice('--report='.length)
    if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report.summary))
  } catch (error) { console.error(error instanceof Error ? error.message : 'Test cohort review failed'); process.exitCode = 1 }
}
