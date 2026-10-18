/** Test resources only: physical pinned Node and native packages, never root addons. */
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function hostNeutralEnvironment(inherited = process.env) {
  return Object.fromEntries(Object.entries(inherited).filter(([key]) => ![
    'electron_run_as_node', 'node_options', 'node_path', 'tauri_database_service_entry',
    'tauri_production_service_entry', 'tauri_production_task_mcp_entry', 'tauri_node_pty_module', 'tauri_sqlite_module',
    'tauri_node_runtime', 'tauri_host_neutral_runner', 'tauri_standalone_service_proofs', 'tauri_production_service_proofs', 'tauri_terminal_proofs'
  ].includes(key.toLowerCase())))
}

export function readHostNeutralResources(root) {
  root = realpathSync(root)
  const pins = JSON.parse(readFileSync(join(root, 'scripts/tauri-runtime.json'), 'utf8'))
  function physical(path, kind) {
    const absolute = resolve(root, path), stat = lstatSync(absolute)
    if (stat.isSymbolicLink() || realpathSync(absolute) !== absolute || !(kind === 'file' ? stat.isFile() : stat.isDirectory())) throw new Error('Standalone test resources must be physical and canonical')
    return absolute
  }
  const node = physical(join('src-tauri/resources/node', process.platform === 'win32' ? 'node.exe' : 'node'), 'file')
  const packages = {}
  for (const name of ['better-sqlite3', 'node-pty']) {
    const directory = physical(join('src-tauri/resources/service/node_modules', name), 'directory')
    const metadata = JSON.parse(readFileSync(physical(join(directory, 'package.json'), 'file'), 'utf8'))
    if (metadata.name !== name || metadata.version !== pins.nativeDependencies[name]) throw new Error('Standalone test native package pin mismatch')
    packages[name] = directory
  }
  return { root, pins, node, sqlite: packages['better-sqlite3'], pty: packages['node-pty'] }
}

export function assertHostNeutralRuntime(root) {
  const resources = readHostNeutralResources(root)
  if (process.versions.electron || process.version !== `v${resources.pins.nodeVersion}` ||
    realpathSync(process.execPath) !== resources.node || process.env.TAURI_HOST_NEUTRAL_RUNNER !== '1' ||
    process.env.TAURI_NODE_RUNTIME !== resources.node || process.env.TAURI_SQLITE_MODULE !== resources.sqlite ||
    process.env.TAURI_NODE_PTY_MODULE !== resources.pty) throw new Error('Use the pinned host-neutral test launcher')
  return resources
}

/** Actually load both addons in their owning runtime before starting Vitest. */
export function inspectHostNeutralAbi(resources) {
  const source = `
    const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
    if(process.versions.electron)throw Error('Electron');
    const req=createRequire(path.join(process.argv[1],'package.json'));
    const Database=req('better-sqlite3'),db=new Database(':memory:');
    db.exec('CREATE TABLE abi_receipt(value INTEGER);INSERT INTO abi_receipt VALUES(127)');
    if(db.prepare('SELECT value FROM abi_receipt').get().value!==127)throw Error('SQLite');db.close();
    const pty=req('node-pty');if(typeof pty.spawn!=='function')throw Error('PTY');
    const native=Object.keys(require.cache).filter(file=>file.endsWith('.node')).map(file=>fs.realpathSync(file));
    if(native.length<2||native.some(file=>!file.startsWith(fs.realpathSync(path.join(process.argv[1],'node_modules'))+path.sep)))throw Error('Native path');
    process.stdout.write(JSON.stringify({node:process.version,modules:process.versions.modules,arch:process.arch,platform:process.platform,native}));`
  const result = spawnSync(resources.node, ['--input-type=commonjs', '-e', source, join(resources.root, 'src-tauri/resources/service')],
    { cwd: resources.root, env: hostNeutralEnvironment(), encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('Pinned standalone native ABI probe failed')
  const info = JSON.parse(result.stdout)
  if (info.node !== `v${resources.pins.nodeVersion}` || info.modules !== '127' || info.arch !== process.arch || info.platform !== process.platform) throw new Error('Pinned standalone runtime identity mismatch')
  return info
}
