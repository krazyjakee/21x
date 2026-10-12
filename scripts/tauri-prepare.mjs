/** Stage an isolated runtime once; native compilation is an explicit batch action. */
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

async function writeChanged(path, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n'
  try { if (await readFile(path, 'utf8') === bytes) return }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await rename(temporary, path)
}

async function signature(path) {
  const details = await stat(path)
  if (!details.isFile()) throw new Error('Runtime source must be a regular file')
  return { path: await realpath(path), size: details.size, mtimeMs: details.mtimeMs, mode: details.mode }
}

async function copyChanged(source, destination, previous) {
  const current = await signature(source)
  let existing
  try {
    const details = await lstat(destination)
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('Managed resources must be regular files')
    existing = await signature(destination)
  }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (JSON.stringify(current) !== JSON.stringify(previous?.source) ||
    JSON.stringify(existing) !== JSON.stringify(previous?.destination)) {
    const temporary = `${destination}.${process.pid}.tmp`
    try {
      await copyFile(source, temporary, constants.COPYFILE_FICLONE)
      await rename(temporary, destination)
    } finally { await rm(temporary, { force: true }) }
  }
  return { source: current, destination: await signature(destination) }
}

async function ensureDirectories(projectRoot, segments) {
  let current = projectRoot
  for (const segment of segments) {
    current = join(current, segment)
    try {
      const details = await lstat(current)
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Managed resource directories cannot be symlinks')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
}

async function npmCli(nodeExecutable, supplied) {
  const candidates = supplied ? [resolve(supplied)] : [
    join(dirname(nodeExecutable), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(nodeExecutable), '../lib/node_modules/npm/bin/npm-cli.js')
  ]
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) return candidate }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw new Error('Native preparation needs npm-cli.js; pass --npm-cli with its absolute path')
}

/** A parent pnpm lifecycle must never choose npm's project or linked strategy. */
export function nativeNpmEnvironment(service, nodeRoot, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => {
    const name = key.toLowerCase();
    return !name.startsWith('npm_package_') && !name.startsWith('npm_lifecycle_') &&
      !['npm_execpath', 'npm_node_execpath', 'npm_config_local_prefix', 'npm_config_prefix',
        'npm_config_workspace', 'npm_config_workspaces', 'npm_config_include_workspace_root',
        'npm_config_install_strategy', 'pnpm_config_workspace_dir', 'pnpm_script_src_dir',
        'init_cwd', 'path'].includes(name)
  }))
  return { ...env, npm_config_prefix: service, npm_config_local_prefix: service,
    npm_config_workspaces: 'false', npm_config_install_strategy: 'hoisted',
    npm_package_config_node_gyp_jobs: '1', MAKEFLAGS: '-j1',
    PATH: nodeRoot + (process.platform === 'win32' ? ';' : ':') + (inherited.PATH ?? '') }
}

async function stagedPackageVersion(service, name) {
  const base = await realpath(join(service, 'node_modules'))
  const directory = join(service, 'node_modules', name)
  let details
  try { details = await lstat(directory) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!details.isDirectory() || details.isSymbolicLink()) return
  const location = relative(base, await realpath(directory))
  if (isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) return
  return (await readJson(join(directory, 'package.json')))?.version
}

export async function repairPtyHelperModes(service, platform = process.platform) {
  if (platform !== 'darwin') return []
  const base = await realpath(service)
  const helpers = []
  // node-pty1.1.0 publishes Darwin prebuild helpers as0644. Repair only
  // isolated staging copies; no application or dependency code is changed.
  for (const directory of ['build/Release', 'build/Debug', 'prebuilds/darwin-x64', 'prebuilds/darwin-arm64']) {
    const path = join(service, 'node_modules/node-pty', directory, 'spawn-helper')
    let details
    try { details = await lstat(path) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('PTY helper must be a regular staged file')
    const location = relative(base, await realpath(path))
    if (isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) {
      throw new Error('PTY helper cannot escape the isolated staging tree')
    }
    if ((details.mode & 0o111) !== 0o111) await chmod(path, (details.mode & 0o777) | 0o111)
    helpers.push(directory)
  }
  if (helpers.length === 0) throw new Error('Staged Darwin PTY spawn helper is missing')
  return helpers
}

export async function prepareRuntime({
  projectRoot = repositoryRoot,
  nodeExecutable = process.execPath,
  native = false,
  npmCliPath
} = {}) {
  projectRoot = await realpath(projectRoot)
  const config = await readJson(join(projectRoot, 'scripts/tauri-runtime.json'))
  if (!config?.nodeVersion || !config.nativeDependencies) throw new Error('Missing runtime pins')
  nodeExecutable = await realpath(nodeExecutable)
  const version = spawnSync(nodeExecutable, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (version.error || version.status !== 0 || version.stdout.trim() !== `v${config.nodeVersion}`) {
    throw new Error(`Preparation requires standalone Node ${config.nodeVersion}; pass --node with that executable`)
  }
  if (process.versions.electron && nodeExecutable === process.execPath) {
    throw new Error('Electron is not the bundled standalone Node runtime')
  }
  const root = join(projectRoot, 'src-tauri/resources')
  const service = join(root, 'service')
  const nodeRoot = join(root, 'node')
  await ensureDirectories(projectRoot, ['src-tauri', 'resources', 'service'])
  await ensureDirectories(projectRoot, ['src-tauri', 'resources', 'node'])
  if (native) await ensureDirectories(projectRoot, ['src-tauri', 'resources', 'service', 'node_modules'])
  const manifestPath = join(root, '.prepared.json')
  const previous = await readJson(manifestPath)
  const executable = join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  const nodeSignature = await copyChanged(nodeExecutable, executable, previous?.node)
  const sourceSignature = await copyChanged(join(projectRoot, 'src/service/feasibility.mjs'),
    join(service, 'feasibility.mjs'), previous?.service)
  const manifest = {
    name: '21x-tauri-feasibility-service', version: '0.1.0', private: true, type: 'module',
    dependencies: { ...config.nativeDependencies, ...config.sdkDependencies, ...config.serviceDependencies },
    // npm 12 requires explicit lifecycle policy. Scope it to these pinned addons.
    allowScripts: Object.fromEntries(Object.entries(config.nativeDependencies)
      .map(([name, version]) => [`${name}@${version}`, true]))
  }
  await writeChanged(join(service, 'package.json'), manifest)
  if (native) {
    const cli = await npmCli(nodeExecutable, npmCliPath)
    const nativeSignature = { nodeVersion: config.nodeVersion, platform: process.platform,
      arch: process.arch, dependencies: manifest.dependencies }
    const installed = await readJson(join(service, '.native-prepared.json'))
    const packagesPresent = (await Promise.all(Object.entries(manifest.dependencies).map(async ([name, version]) => {
      return await stagedPackageVersion(service, name) === version
    }))).every(Boolean)
    const smoke = () => {
      const checked = spawnSync(executable, ['--input-type=commonjs', '-e',
        "console.log=()=>{};const fs=require('node:fs'),path=require('node:path');const base=fs.realpathSync(path.join(process.cwd(),'node_modules'));const result={};for(const name of ['better-sqlite3','node-pty']){try{const entry=fs.realpathSync(require.resolve(name));const within=path.relative(base,entry);if(path.isAbsolute(within)||within==='..'||within.startsWith('..'+path.sep))throw new Error();const module=require(entry);if(name==='better-sqlite3'){const db=new module(':memory:');db.prepare('SELECT 1').get();db.close()}result[name]=true}catch{result[name]=false}}process.stdout.write(JSON.stringify(result))"],
      { cwd: service, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 15_000, maxBuffer: 8192 })
      try {
        if (checked.error || checked.status !== 0) return { 'better-sqlite3': false, 'node-pty': false }
        return JSON.parse(checked.stdout)
      } catch { return { 'better-sqlite3': false, 'node-pty': false } }
    }
    const healthy = result => Object.keys(config.nativeDependencies).every(name => result?.[name] === true)
    const priorSmoke = packagesPresent ? smoke() : undefined
    if (!packagesPresent || JSON.stringify(installed) !== JSON.stringify(nativeSignature) || !healthy(priorSmoke)) {
      const result = spawnSync(nodeExecutable, [cli, 'install', '--prefix', service, '--omit=dev', '--workspaces=false', '--install-strategy=hoisted', '--install-links=true', '--no-audit', '--no-fund', '--foreground-scripts'], {
        cwd: service, stdio: 'inherit', env: nativeNpmEnvironment(service, nodeRoot)
      })
      if (result.error || result.status !== 0) throw new Error('Native module preparation failed; no success marker was written')
      let checked = smoke()
      if (!healthy(checked)) {
        // An earlier npm install may have skipped these scripts. Rebuild only
        // the explicitly pinned addons, in their standalone staging directory.
        const failed = Object.keys(config.nativeDependencies).filter(name => checked[name] !== true)
        const rebuilt = spawnSync(nodeExecutable, [cli, 'rebuild', ...failed,
          '--prefix', service, '--workspaces=false', '--install-strategy=hoisted', '--foreground-scripts'], {
          cwd: service, stdio: 'inherit', env: nativeNpmEnvironment(service, nodeRoot)
        })
        if (rebuilt.error || rebuilt.status !== 0) throw new Error('Standalone addon rebuild failed; no success marker was written')
        checked = smoke()
      }
      if (!healthy(checked) || !(await Promise.all(Object.entries(manifest.dependencies).map(async ([name, version]) =>
        await stagedPackageVersion(service, name) === version))).every(Boolean)) {
        throw new Error('Standalone native module verification failed; no success marker was written')
      }
      await writeChanged(join(service, '.native-prepared.json'), nativeSignature)
    }
    await repairPtyHelperModes(service)
  }
  await writeChanged(manifestPath, { node: nodeSignature, service: sourceSignature })
  return { nodeVersion: config.nodeVersion, nativePrepared: native, resources: root }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    const options = {}
    while (args.length) {
      const flag = args.shift()
      if (flag === '--native') options.native = true
      else if ((flag === '--node' || flag === '--npm-cli') && args.length) {
        options[flag === '--node' ? 'nodeExecutable' : 'npmCliPath'] = args.shift()
      } else throw new Error('Usage: tauri-prepare.mjs [--node PATH] [--native] [--npm-cli PATH]')
    }
    console.log(JSON.stringify(await prepareRuntime(options), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
