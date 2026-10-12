import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencies = new Set(['better-sqlite3', '@paralleldrive/cuid2'])

/** Actual manager graph; no Electron shim, SDK factory, network or tool server. */
export async function stageAgentLifecycleProof(directory, { sqliteModule, fixture = 'lifecycle' }) {
  const entries = {
    lifecycle: 'scripts/agent-lifecycle-proof/fixture.ts',
    desktop: 'scripts/agent-desktop-proof/fixture.ts'
  }
  if (!Object.hasOwn(entries, fixture)) throw new Error('Unknown fixed proof fixture')
  const entry = entries[fixture]
  if (typeof sqliteModule !== 'string' || !isAbsolute(sqliteModule)) throw new Error('Explicit standalone SQLite package path required')
  const sqlite = await realpath(sqliteModule)
  const metadata = JSON.parse(await readFile(join(sqlite, 'package.json'), 'utf8'))
  if (metadata.name !== 'better-sqlite3') throw new Error('Selected package is not better-sqlite3')
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await mkdir(join(directory, 'node_modules', '@paralleldrive'), { recursive: true })
  await symlink(join(root, 'node_modules', '@paralleldrive', 'cuid2'), join(directory, 'node_modules', '@paralleldrive', 'cuid2'), linkType)
  // Verify's SQLite is Electron-ABI rebuilt; it is never a Node fallback.
  await symlink(sqlite, join(directory, 'node_modules', 'better-sqlite3'), linkType)
  const seen = new Set()
  async function stage(file) {
    const within = relative(root, file)
    if (within.startsWith('..') || isAbsolute(within) || !file.endsWith('.ts')) throw new Error('Unexpected proof module')
    if (within.split('\\').join('/') === 'src/main/agent-manager/adapter-factory.ts') throw new Error('Real SDK adapter factory is forbidden in the fixture')
    if (seen.has(file)) return
    if (seen.size >= 128) throw new Error('Proof module bound exceeded')
    seen.add(file)
    const source = await readFile(file, 'utf8')
    if (Buffer.byteLength(source) > 1_048_576) throw new Error('Proof source bound exceeded')
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true, fileName: file
    })
    if (output.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error('Proof transpilation failed')
    const parsed = ts.createSourceFile(file + '.js', output.outputText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
    const edits = []
    const follow = []
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier.endsWith('.ts') ? specifier : specifier + '.ts')
          follow.push(target)
          edits.push({ start: node.moduleSpecifier.getStart(parsed), end: node.moduleSpecifier.end, replacement: JSON.stringify(specifier.replace(/\.ts$/, '') + '.js') })
        } else if (!isBuiltin(specifier) && !dependencies.has(specifier)) {
          throw new Error('Unexpected runtime dependency in portable agent graph')
        }
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && ['require', 'eval'].includes(node.expression.text))) throw new Error('Dynamic runtime dependency in proof graph')
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    let text = output.outputText
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
    const destination = join(directory, within.replace(/\.ts$/, '.js'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, text)
    for (const dependency of follow) await stage(dependency)
  }
  await stage(join(root, entry))
  return { moduleCount: seen.size, sqliteVersion: metadata.version,
    fixture: pathToFileURL(join(directory, entry.replace(/\.ts$/, '.js'))).href }
}

export async function runAgentLifecycleProof({ sqliteModule = process.env.TAURI_SQLITE_MODULE } = {}) {
  if (process.versions.electron) throw new Error('Standalone Node required')
  const directory = await mkdtemp(join(tmpdir(), '21x-agent-lifecycle-proof-'))
  const methods = ['log', 'info', 'debug', 'warn', 'error']
  const original = new Map(methods.map(method => [method, console[method]]))
  const diagnosticCounts = Object.fromEntries(methods.map(method => [method, 0]))
  for (const method of methods) console[method] = () => { diagnosticCounts[method]++ }
  try {
    const staged = await stageAgentLifecycleProof(directory, { sqliteModule })
    const { runAgentLifecycleFixture } = await import(staged.fixture)
    const report = await runAgentLifecycleFixture(directory)
    return { ...report, portableModuleCount: staged.moduleCount, sqliteVersion: staged.sqliteVersion, nodeVersion: process.version, diagnosticCounts }
  } finally {
    for (const [method, callback] of original) console[method] = callback
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--sqlite-module')
  const sqliteModule = index >= 0 ? process.argv[index + 1] : process.env.TAURI_SQLITE_MODULE
  try { console.log(JSON.stringify(await runAgentLifecycleProof({ sqliteModule }), null, 2)) }
  catch (error) {
    console.log(JSON.stringify({ ok: false, code: 'FIXTURE_FAILED',
      phase: typeof error?.phase === 'string' && /^[a-z-]{1,64}$/.test(error.phase) ? error.phase : 'staging' }))
    process.exitCode = 1
  }
}
