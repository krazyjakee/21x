/** Bundle the isolated database slice using existing tooling; never copy repository node_modules. */
import { builtinModules } from 'node:module'
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencies = ['better-sqlite3', '@paralleldrive/cuid2']

async function writeChanged(path, bytes) {
  try {
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('Managed service files must be regular files')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  try { if ((await readFile(path)).equals(Buffer.from(bytes))) return false }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await rename(temporary, path)
  return true
}

/** Validate packages before importing code that could resolve an unstaged native dependency. */
function bootstrap(pins) {
  return `// Generated synthetic-only entry. Never opens the production profile.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const contained = (base, path) => { const value = relative(base, path); return !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep); };
let phase = 'runtime';
try {
  if (process.versions.electron || process.version !== ${JSON.stringify('v' + pins.nodeVersion)} || process.env.TWENTYONEX_DATABASE_MODE !== 'synthetic-only') throw new Error();
  phase = 'dependencies';
  const modules = join(here, 'node_modules');
  const details = lstatSync(modules);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error();
  const base = realpathSync(modules);
  for (const [name, version] of Object.entries(${JSON.stringify(Object.fromEntries(dependencies.map(name => [name, pins.nativeDependencies?.[name] ?? pins.serviceDependencies?.[name]])))})) {
    const location = join(modules, name);
    const packageDirectory = realpathSync(location);
    if (!contained(base, packageDirectory) || !contained(base, realpathSync(fileURLToPath(import.meta.resolve(name))))) throw new Error();
    if (JSON.parse(readFileSync(join(location, 'package.json'), 'utf8')).version !== version) throw new Error();
  }
  phase = 'engine';
  const engine = join(here, 'database-engine.mjs');
  const engineDetails = lstatSync(engine);
  if (!engineDetails.isFile() || engineDetails.isSymbolicLink() || !contained(realpathSync(here), realpathSync(engine))) throw new Error();
  await import('./database-engine.mjs');
} catch {
  process.stderr.write('[database-service] trusted bootstrap ' + phase + ' unavailable\\n');
  process.exitCode = 1;
}
`
}

export async function stageDatabaseService(root = repository) {
  root = await realpath(root)
  const pins = JSON.parse(await readFile(join(root, 'scripts/tauri-runtime.json'), 'utf8'))
  for (const name of dependencies) if (!(pins.nativeDependencies?.[name] ?? pins.serviceDependencies?.[name])) throw new Error('Missing database service dependency pin')
  const allowed = new Set([...dependencies, ...builtinModules, ...builtinModules.map(name => 'node:' + name)])
  const result = await build({
    configFile: false, root, logLevel: 'silent',
    build: {
      ssr: join(root, 'src/service/database-stdio.ts'), target: 'node22', minify: false,
      write: false, sourcemap: false,
      rollupOptions: {
        external: id => allowed.has(id),
        output: { format: 'es', entryFileNames: 'database-engine.mjs', inlineDynamicImports: true }
      }
    },
    // Bundle source modules; only reviewed/pinned packages remain external.
    ssr: { noExternal: true, external: dependencies }
  })
  const outputs = Array.isArray(result) ? result.flatMap(item => item.output) : result.output
  if (outputs.length !== 1 || outputs[0].type !== 'chunk' || outputs[0].fileName !== 'database-engine.mjs') throw new Error('Unexpected database service output')
  if (outputs[0].imports.some(name => !allowed.has(name))) throw new Error('Unreviewed database service runtime dependency')
  const service = join(root, 'src-tauri/resources/service')
  let directory = root
  for (const segment of ['src-tauri', 'resources', 'service']) {
    directory = join(directory, segment)
    try {
      const details = await lstat(directory)
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Managed service directories cannot be symlinks')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await mkdir(directory)
    }
  }
  const engineChanged = await writeChanged(join(service, 'database-engine.mjs'), outputs[0].code)
  const bootstrapChanged = await writeChanged(join(service, 'database-stdio.mjs'), bootstrap(pins))
  return { serviceEntry: 'service/database-stdio.mjs', syntheticOnly: true, externalDependencies: dependencies,
    bytes: Buffer.byteLength(outputs[0].code), changed: engineChanged || bootstrapChanged }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await stageDatabaseService(), null, 2)) }
  catch { console.error('Synthetic database service staging failed.'); process.exitCode = 1 }
}
