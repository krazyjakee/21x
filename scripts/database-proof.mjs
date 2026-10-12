import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencies = new Set(['better-sqlite3', '@paralleldrive/cuid2'])

/** Transpile only this small graph; reuse installed dependencies and forbid Electron. */
export async function stageDatabaseProof(directory) {
  const seen = new Set()
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
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

export async function runDatabaseProof() {
  if (process.versions.electron) throw new Error('Standalone Node is required')
  const directory = await mkdtemp(join(tmpdir(), '21x-database-proof-'))
  try {
    const staged = await stageDatabaseProof(directory)
    const { runDatabaseFixture } = await import(staged.fixture)
    const report = runDatabaseFixture(directory)
    return { ...report, portableModuleCount: staged.moduleCount }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runDatabaseProof(), null, 2)) }
  catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
