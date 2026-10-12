#!/usr/bin/env node
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const SOURCE_ROOTS = ['src/main', 'src/preload', 'src/renderer/src', 'src/shared', 'src/mobile']
const OUTPUT = 'docs/tauri-migration/inventory.json'
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', 'generated', '__generated__', '__tests__', 'fixtures', '__fixtures__', '.git'])
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const normalize = (file) => file.replaceAll('\\', '/')
const uniqueSorted = (items) => [...new Map(items.map((item) => [JSON.stringify(item), item])).values()]
  .sort((a, b) => compare(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0) || compare(JSON.stringify(a), JSON.stringify(b)))

// Exact source/receiver forms reviewed in ownership-audit.md. Names alone do
// not turn arbitrary application methods into IPC or authorization evidence.
export const EVENT_WRAPPERS = {
  'src/main/agent-manager.ts': ['this.sendToRenderer', 'this.broadcast'],
  'src/main/auto-updater.ts': ['send'],
  'src/main/heartbeat-scheduler.ts': ['this.sendToRenderer'],
  'src/main/workspace-cleanup-scheduler.ts': ['this.sendToRenderer'],
  'src/main/task-api/state.ts': ['notifyRenderer'],
  'src/main/task-api/ui-routes.ts': ['notifyRenderer'],
  'src/main/task-api/task-routes.ts': ['notifyRenderer'],
  'src/main/task-api/session-routes.ts': ['notifyRenderer'],
  'src/main/task-api/artifact-routes.ts': ['notifyRenderer'],
  'src/main/mobile-api-server.ts': ['notifyDesktop'],
  'src/main/voice/voice-session-manager.ts': ['this.options.notify'],
  'src/main/voice/voice-action-service.ts': ['this.deps.notify'],
  'src/main/voice/voice-speech-service.ts': ['this.options.notifyRenderer', 'options.notifyRenderer'],
  'src/main/index.ts': ['voiceEvents.notify', 'voiceEvents.notifyRenderer']
}

function constantValue(node, lookup) {
  node = unwrap(node)
  const direct = literal(node)
  if (direct !== null) return direct
  if (!node) return undefined
  if (ts.isIdentifier(node)) return lookup(node.text)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantValue(node.left, lookup), right = constantValue(node.right, lookup)
    if (typeof left === 'string' && typeof right === 'string') return left + right
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value = Object.create(null)
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined
      const key = ts.isIdentifier(property.name) ? property.name.text : literal(property.name)
      const item = constantValue(property.initializer, lookup)
      if (key === null || item === undefined) return undefined
      value[key] = item
    }
    return value
  }
  const property = member(node)
  if (property) {
    const object = constantValue(property.object, lookup)
    if (object && typeof object === 'object' && Object.hasOwn(object, property.name)) return object[property.name]
  }
  return undefined
}

/** Resolve only repository-local exported const data; no code/module execution. */
export function sourceConstantMaps(sources) {
  const maps = new Map()
  for (const { file, source } of sources) {
    const values = new Map()
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    for (const statement of sf.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) {
        const value = constantValue(declaration.initializer, name => values.get(name))
        if (value !== undefined) values.set(declaration.name.text, value)
      }
    }
    const exported = new Map()
    for (const statement of sf.statements) if (ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && values.has(declaration.name.text)) exported.set(declaration.name.text, values.get(declaration.name.text))
    }
    maps.set(normalize(file), exported)
  }
  return maps
}

function importedConstants(file, source, maps) {
  const constants = new Map()
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue
    const specifier = literal(statement.moduleSpecifier)
    if (!specifier || !specifier.startsWith('.') && !specifier.startsWith('@shared/')) continue
    const base = specifier.startsWith('@shared/') ? 'src/shared/' + specifier.slice(8)
      : posix.normalize(posix.join(posix.dirname(normalize(file)), specifier))
    const values = [base, base + '.ts', base + '.tsx', base + '/index.ts'].map(key => maps.get(key)).find(Boolean)
    if (!values) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (!binding.isTypeOnly && values.has((binding.propertyName ?? binding.name).text)) constants.set(binding.name.text, values.get((binding.propertyName ?? binding.name).text))
    }
    if (bindings && ts.isNamespaceImport(bindings)) constants.set(bindings.name.text, Object.fromEntries(values))
  }
  return constants
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression
  return node
}

function literal(node) {
  node = unwrap(node)
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
}

function member(node) {
  node = unwrap(node)
  if (node && ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text }
  if (node && ts.isElementAccessExpression(node)) return { object: node.expression, name: literal(node.argumentExpression) }
  return null
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((item) => ts.isBindingElement(item) ? bindingNames(item.name) : [])
}

/** Parse one source without compiling, resolving modules, or loading addons. */
export function scanSource(file, source, { constants = new Map(), wrappers = EVENT_WRAPPERS } = {}) {
  file = normalize(file)
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const result = { electronImports: [], operations: [], electronAPIConsumers: [], webviews: [] }
  const webContentsTypes = new Set()
  const electronNamespaces = new Set()
  const location = (node) => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    return { file, line: pos.line + 1, column: pos.character + 1 }
  }
  const lookup = (env, name) => {
    for (let scope = env; scope; scope = scope.parent) if (scope.bindings.has(name)) return scope.bindings.get(name)
    return undefined
  }
  const constant = (node, env) => constantValue(node, name => {
    const value = lookup(env, name)
    return value?.kind === 'constant' ? value.value : undefined
  })
  const identify = (node, env) => {
    node = unwrap(node)
    if (!node) return null
    if (ts.isIdentifier(node)) return lookup(env, node.text) ?? null
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && literal(node.arguments[0]) === 'electron') return { kind: 'electron' }
    const property = member(node)
    if (!property) return null
    if (property.name === null && ts.isElementAccessExpression(node)) {
      const key = constant(node.argumentExpression, env)
      if (typeof key === 'string') property.name = key
    }
    const object = identify(property.object, env)
    if (object?.kind === 'electron' && ['ipcMain', 'ipcRenderer'].includes(property.name)) return { kind: property.name }
    if (['ipcMain', 'ipcRenderer', 'webContents'].includes(object?.kind)) return { kind: `${object.kind}.method`, method: property.name }
    // Structural candidates: this records receiver syntax, not its runtime type.
    if (property.name === 'webContents' || property.name === 'sender') return { kind: 'webContents', basis: property.name }
    return null
  }
  const isWebContentsType = (node) => {
    if (!node) return false
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return node.types.some(isWebContentsType)
    if (ts.isParenthesizedTypeNode(node)) return isWebContentsType(node.type)
    if (!ts.isTypeReferenceNode(node)) return false
    if (ts.isIdentifier(node.typeName)) {
      if (webContentsTypes.has(node.typeName.text)) return true
      if (['Pick', 'Omit'].includes(node.typeName.text)) return isWebContentsType(node.typeArguments?.[0])
    }
    return ts.isQualifiedName(node.typeName) && ts.isIdentifier(node.typeName.left) && electronNamespaces.has(node.typeName.left.text) && node.typeName.right.text === 'WebContents'
  }
  const bind = (name, value, env) => {
    if (ts.isIdentifier(name)) env.bindings.set(name.text, value)
    else if (ts.isObjectBindingPattern(name)) {
      for (const item of name.elements) {
        const key = item.propertyName ? (ts.isIdentifier(item.propertyName) ? item.propertyName.text : literal(item.propertyName)) : ts.isIdentifier(item.name) ? item.name.text : null
        let itemValue = null
        if (value?.kind === 'electron' && ['ipcMain', 'ipcRenderer'].includes(key)) itemValue = { kind: key }
        if (['ipcMain', 'ipcRenderer', 'webContents'].includes(value?.kind)) itemValue = { kind: `${value.kind}.method`, method: key }
        bind(item.name, itemValue, env)
      }
    } else for (const id of bindingNames(name)) env.bindings.set(id, null)
  }
  const prepare = (statements, parent) => {
    const env = { parent, bindings: new Map() }
    for (const stmt of statements) {
      if (ts.isVariableStatement(stmt)) for (const decl of stmt.declarationList.declarations) bind(decl.name, null, env)
      if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) env.bindings.set(stmt.name.text, null)
      if (ts.isImportDeclaration(stmt) && stmt.importClause) {
        const clause = stmt.importClause
        if (clause.name) env.bindings.set(clause.name.text, literal(stmt.moduleSpecifier) === 'electron' && !clause.isTypeOnly ? { kind: 'electron' } : null)
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          env.bindings.set(bindings.name.text, literal(stmt.moduleSpecifier) === 'electron' && !clause.isTypeOnly ? { kind: 'electron' }
            : !clause.isTypeOnly && constants.has(bindings.name.text) ? { kind: 'constant', value: constants.get(bindings.name.text) } : null)
          if (literal(stmt.moduleSpecifier) === 'electron') electronNamespaces.add(bindings.name.text)
        }
        if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
          const original = (item.propertyName ?? item.name).text
          if (literal(stmt.moduleSpecifier) === 'electron' && original === 'WebContents') webContentsTypes.add(item.name.text)
          const runtime = !clause.isTypeOnly && !item.isTypeOnly
          const kind = runtime && literal(stmt.moduleSpecifier) === 'electron' && ['ipcMain', 'ipcRenderer'].includes(original) ? original
            : runtime && original === 'guardedIpcSend' ? 'guardedIpcSend' : null
          env.bindings.set(item.name.text, kind ? { kind } : runtime && constants.has(item.name.text) ? { kind: 'constant', value: constants.get(item.name.text) } : null)
        }
      }
    }
    return env
  }
  const apiPath = (node) => {
    node = unwrap(node)
    const property = member(node)
    if (!property) return null
    if (property.name === 'electronAPI' && ts.isIdentifier(unwrap(property.object)) && unwrap(property.object).text === 'window') return []
    const path = apiPath(property.object)
    return path ? [...path, property.name] : null
  }
  const recordOperation = (node, target, method, channelIndex, env) => {
    const arg = node.arguments[channelIndex]
    const resolved = constant(arg, env)
    const channel = typeof resolved === 'string' ? resolved : null
    result.operations.push({ ...location(node), target, method: method ?? null,
      methodExpression: method === null ? node.expression.getText(sf) : null,
      channel, channelExpression: literal(arg) === null && arg ? arg.getText(sf) : null,
      resolution: channel !== null && method !== null ? literal(arg) === null ? 'constant' : 'literal' : 'unresolved' })
  }
  const enclosingExpression = (node) => {
    while (node.parent && unwrap(node.parent) === node) node = node.parent
    return node
  }
  function visit(node, env) {
    // Type queries and declarations do not consume the runtime bridge.
    if (ts.isTypeNode(node)) return
    if (ts.isBlock(node)) {
      const scope = prepare(node.statements, env)
      for (const stmt of node.statements) visit(stmt, scope)
      return
    }
    if (ts.isFunctionLike(node)) {
      const scope = { parent: env, bindings: new Map() }
      for (const parameter of node.parameters) bind(parameter.name, isWebContentsType(parameter.type) ? { kind: 'webContents' } : null, scope)
      if (node.name && ts.isIdentifier(node.name)) scope.bindings.set(node.name.text, null)
      for (const parameter of node.parameters) if (parameter.initializer) visit(parameter.initializer, scope)
      if (node.body) visit(node.body, scope)
      return
    }
    if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier) === 'electron') {
      const clause = node.importClause
      const bindings = []
      if (clause?.name) bindings.push({ imported: 'default', local: clause.name.text, typeOnly: clause.isTypeOnly })
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.push({ imported: '*', local: clause.namedBindings.name.text, typeOnly: clause.isTypeOnly })
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) bindings.push({ imported: (item.propertyName ?? item.name).text, local: item.name.text, typeOnly: clause.isTypeOnly || item.isTypeOnly })
      const typeCount = bindings.filter((item) => item.typeOnly).length
      result.electronImports.push({ ...location(node), syntax: 'import', mode: clause?.isTypeOnly || bindings.length > 0 && typeCount === bindings.length ? 'type-only' : typeCount ? 'mixed' : 'runtime', bindings })
    }
    if (ts.isExportDeclaration(node) && literal(node.moduleSpecifier) === 'electron') {
      const bindings = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.map((item) => ({ imported: (item.propertyName ?? item.name).text, local: item.name.text, typeOnly: node.isTypeOnly || item.isTypeOnly })) : []
      const typeCount = bindings.filter((item) => item.typeOnly).length
      result.electronImports.push({ ...location(node), syntax: 'export', mode: node.isTypeOnly || bindings.length > 0 && typeCount === bindings.length ? 'type-only' : typeCount ? 'mixed' : 'runtime', bindings })
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && literal(node.moduleReference.expression) === 'electron') {
      result.electronImports.push({ ...location(node), syntax: 'import-equals', mode: node.isTypeOnly ? 'type-only' : 'runtime', bindings: [{ imported: '*', local: node.name.text, typeOnly: node.isTypeOnly }] })
      env.bindings.set(node.name.text, node.isTypeOnly ? null : { kind: 'electron' })
    }
    if (ts.isVariableDeclaration(node)) {
      const resolved = constant(node.initializer, env)
      bind(node.name, identify(node.initializer, env) ?? (resolved !== undefined ? { kind: 'constant', value: resolved } : isWebContentsType(node.type) ? { kind: 'webContents' } : null), env)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      // A reassigned alias is no longer reliable; do not follow arbitrary data flow.
      for (let scope = env; scope; scope = scope.parent) if (scope.bindings.has(node.left.text)) { scope.bindings.set(node.left.text, null); break }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && member(node.left)) {
      const object = unwrap(member(node.left).object)
      if (object && ts.isIdentifier(object)) for (let scope = env; scope; scope = scope.parent) {
        if (scope.bindings.has(object.text)) { scope.bindings.set(object.text, null); break }
      }
    }
    if (ts.isCallExpression(node)) {
      if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && literal(node.arguments[0]) === 'electron') result.electronImports.push({ ...location(node), syntax: node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require', mode: 'runtime', bindings: [] })
      const callee = identify(node.expression, env)
      if (callee?.kind === 'guardedIpcSend') recordOperation(node, 'guardedIpcSend', 'send', 1, env)
      const methods = { 'ipcMain.method': ['handle', 'on'], 'ipcRenderer.method': ['invoke', 'send', 'on'], 'webContents.method': ['send'] }
      if (methods[callee?.kind] && (callee.method === null || methods[callee.kind].includes(callee.method))) recordOperation(node, callee.kind.replace('.method', ''), callee.method, 0, env)
      if (wrappers[file]?.includes(node.expression.getText(sf).replaceAll('?.', '.'))) recordOperation(node, 'reviewed-event-wrapper', 'send', 0, env)
    }
    const path = apiPath(node)
    const enclosing = enclosingExpression(node)
    if (path && !(member(enclosing.parent)?.object === enclosing) && unwrap(node) === node) {
      result.electronAPIConsumers.push({ ...location(node), path, expression: node.getText(sf), kind: ts.isCallExpression(enclosing.parent) && enclosing.parent.expression === enclosing ? 'call' : 'access', resolution: path.includes(null) ? 'unresolved' : 'literal' })
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(sf) === 'webview') result.webviews.push(location(node))
    ts.forEachChild(node, (child) => visit(child, env))
  }
  const env = prepare(sf.statements, null)
  for (const stmt of sf.statements) visit(stmt, env)
  for (const key of Object.keys(result)) result[key] = uniqueSorted(result[key])
  return result
}

function schemaVersion(source) {
  const sf = ts.createSourceFile('schema.ts', source, ts.ScriptTarget.Latest, true)
  let value = null
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'SCHEMA_VERSION' && node.initializer && ts.isNumericLiteral(node.initializer)) value = Number(node.initializer.text)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return value
}

/** Injectable source list keeps scanner tests small and independent of the repo. */
export function createInventory({ sources, packageJson = {} }) {
  const sorted = [...sources].sort((a, b) => compare(normalize(a.file), normalize(b.file)))
  const constantMaps = sourceConstantMaps(sorted)
  const collections = { electronImports: [], operations: [], electronAPIConsumers: [], webviews: [] }
  for (const { file, source } of sorted) {
    const scanned = scanSource(file, source, { constants: importedConstants(file, source, constantMaps) })
    for (const key of Object.keys(collections)) collections[key].push(...scanned[key])
  }
  for (const key of Object.keys(collections)) collections[key] = uniqueSorted(collections[key])
  const dependencies = Object.fromEntries(Object.entries(packageJson.dependencies ?? {}).sort(([a], [b]) => compare(a, b)))
  const devDependencies = Object.fromEntries(Object.entries(packageJson.devDependencies ?? {}).sort(([a], [b]) => compare(a, b)))
  const build = packageJson.build ?? {}
  const schema = sorted.find(({ file }) => normalize(file) === 'src/main/database/schema.ts')
  const platforms = ['mac', 'win', 'linux']
  const resourceKeys = ['icon', 'entitlements', 'entitlementsInherit', 'include', 'installerIcon', 'uninstallerIcon', 'installerHeaderIcon']
  return {
    formatVersion: 2,
    methodology: 'Parse-only syntactic inventory; unresolved expressions require review. This is not a runtime coverage or permission proof.',
    sourceRoots: SOURCE_ROOTS,
    files: [...new Set(sorted.map(({ file }) => normalize(file)))],
    package: { name: packageJson.name ?? null, productName: packageJson.productName ?? null, version: packageJson.version ?? null, packageManager: packageJson.packageManager ?? null, electron: devDependencies.electron ?? dependencies.electron ?? null, dependencies, devDependencies },
    database: { file: 'src/main/database/schema.ts', schemaVersion: schema ? schemaVersion(schema.source) : null },
    nativeDependencies: ['better-sqlite3', 'node-pty'].filter((name) => dependencies[name]).map((name) => ({ name, version: dependencies[name], evidence: 'Known addons rebuilt by scripts/rebuild-native.mjs; declared version, not installed ABI verification' })),
    packaging: { appId: build.appId ?? null, directories: build.directories ?? null, files: build.files ?? [], extraResources: build.extraResources ?? [], asarUnpack: build.asarUnpack ?? [], nativeRebuilder: build.nativeRebuilder ?? null, hooks: { afterPack: build.afterPack ?? null, afterSign: build.afterSign ?? null }, platformResources: Object.fromEntries(platforms.map((platform) => [platform, Object.fromEntries(resourceKeys.filter((key) => build[platform]?.[key] !== undefined).map((key) => [key, build[platform][key]]))])), targets: Object.fromEntries(platforms.map((platform) => [platform, build[platform]?.target ?? []])) },
    summary: { files: new Set(sorted.map(({ file }) => normalize(file))).size, runtimeElectronImports: collections.electronImports.filter(({ mode }) => mode !== 'type-only').length, typeOnlyElectronImports: collections.electronImports.filter(({ mode }) => mode === 'type-only').length, operations: collections.operations.length, unresolvedOperations: collections.operations.filter(({ resolution }) => resolution === 'unresolved').length, directAPIConsumers: collections.electronAPIConsumers.length, webviews: collections.webviews.length },
    ...collections
  }
}

export function serializeInventory(inventory) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])])) : value
  return JSON.stringify(canonical(inventory), null, 2) + '\n'
}

export function scanRepository(root) {
  const sources = []
  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) walk(path)
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && !/\.(?:test|spec)\.[^.]+$|\.d\.[cm]?ts$/.test(entry.name)) sources.push({ file: normalize(relative(root, path)), source: readFileSync(path, 'utf8') })
    }
  }
  for (const sourceRoot of SOURCE_ROOTS) walk(join(root, sourceRoot))
  return createInventory({ sources, packageJson: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) })
}

export function runCli(args, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  if (args.some((arg) => !['--check', '--stdout'].includes(arg))) throw new Error('Usage: node scripts/tauri-inventory.mjs [--check] [--stdout]')
  const inventory = scanRepository(root)
  const output = serializeInventory(inventory)
  const path = join(root, OUTPUT)
  if (args.includes('--check')) {
    let previous
    try { previous = readFileSync(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (previous !== output) { console.error(`${OUTPUT} is missing or stale; run node scripts/tauri-inventory.mjs`); return 1 }
  } else if (!args.includes('--stdout')) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, output)
  }
  if (args.includes('--stdout')) console.log(JSON.stringify(inventory.summary, null, 2))
  else console.log(`${args.includes('--check') ? 'Verified' : 'Wrote'} ${OUTPUT}: ${inventory.summary.files} files, ${inventory.summary.operations} IPC operations (${inventory.summary.unresolvedOperations} unresolved)`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runCli(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
