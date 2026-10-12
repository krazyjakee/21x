import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencies = new Set(['better-sqlite3', '@paralleldrive/cuid2'])

/** Transpile only this small graph; reuse installed dependencies and forbid Electron. */
export async function stageDatabaseProof(directory, { sqliteModule }) {
  const seen = new Set()
  if (typeof sqliteModule !== 'string' || !isAbsolute(sqliteModule)) throw new Error('Explicit absolute standalone SQLite package path is required')
  const sqlite = await realpath(sqliteModule)
  const metadata = JSON.parse(await readFile(join(sqlite, 'package.json'), 'utf8'))
  if (metadata.name !== 'better-sqlite3') throw new Error('Selected package is not better-sqlite3')
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await mkdir(join(directory, 'node_modules', '@paralleldrive'), { recursive: true })
  // Pure JavaScript dependencies may be reused from Verify's tree. Its SQLite
  // addon is built for Electron and must never become an implicit Node fallback.
  await symlink(join(root, 'node_modules', '@paralleldrive', 'cuid2'), join(directory, 'node_modules', '@paralleldrive', 'cuid2'), linkType)
  await symlink(sqlite, join(directory, 'node_modules', 'better-sqlite3'), linkType)
  async function stage(file) {
    const within = relative(root, file)
    if (within.startsWith('..') || isAbsolute(within) || !file.endsWith('.ts')) throw new Error('Unexpected proof module')
    if (seen.has(file)) return
    seen.add(file)
    const source = await readFile(file, 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
      fileName: file
    })
    if (output.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error('Proof transpilation failed')
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
        } else if (!specifier.startsWith('node:') && !['path', 'fs'].includes(specifier) && !dependencies.has(specifier)) {
          throw new Error('Unexpected runtime dependency in portable database graph: ' + specifier)
        }
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) throw new Error('Dynamic runtime dependency in proof graph')
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
  await stage(join(root, 'scripts/database-proof/fixture.ts'))
  return { moduleCount: seen.size, fixture: pathToFileURL(join(directory, 'scripts/database-proof/fixture.js')).href }
}

export async function runDatabaseProof({ sqliteModule = process.env.TAURI_SQLITE_MODULE } = {}) {
  if (process.versions.electron) throw new Error('Standalone Node is required')
  const directory = await mkdtemp(join(tmpdir(), '21x-database-proof-'))
  try {
    const staged = await stageDatabaseProof(directory, { sqliteModule })
    const { runDatabaseFixture } = await import(staged.fixture)
    const report = runDatabaseFixture(directory)
    return { ...report, portableModuleCount: staged.moduleCount }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--sqlite-module')
  const sqliteModule = index >= 0 ? process.argv[index + 1] : process.env.TAURI_SQLITE_MODULE
  try { console.log(JSON.stringify(await runDatabaseProof({ sqliteModule }), null, 2)) }
  catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
