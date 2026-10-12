import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareRuntime, repairPtyHelperModes, nativeNpmEnvironment, pruneForeignSqlitePrebuilds } from './tauri-prepare.mjs'

async function fixture(t, nodeVersion = process.versions.node) {
  const root = await mkdtemp(join(tmpdir(), '21x-tauri-preparation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'src/service'), { recursive: true })
  await writeFile(join(root, 'scripts/tauri-runtime.json'), JSON.stringify({ nodeVersion,
    nativeDependencies: { 'better-sqlite3': '13.0.3', 'node-pty': '1.1.0' } }))
  await writeFile(join(root, 'src/service/feasibility.mjs'), 'process.exit(0)\n')
  return root
}

test('Darwin staged PTY helpers gain executable bits without rewriting their contents', async t => {
  if (process.platform === 'win32') return
  const root = await fixture(t)
  const service = join(root, 'service')
  const directory = join(service, 'node_modules/node-pty/prebuilds/darwin-x64')
  await mkdir(directory, { recursive: true })
  const helper = join(directory, 'spawn-helper')
  await writeFile(helper, 'fixture-helper', { mode: 0o644 })
  const before = await stat(helper)
  assert.deepEqual(await repairPtyHelperModes(service, 'darwin'), ['prebuilds/darwin-x64'])
  assert.equal((await stat(helper)).mode & 0o111, 0o111)
  assert.equal((await stat(helper)).mtimeMs, before.mtimeMs)
  assert.equal(await readFile(helper, 'utf8'), 'fixture-helper')
  assert.deepEqual(await repairPtyHelperModes(service, 'darwin'), ['prebuilds/darwin-x64'])
})

test('repeated preparation leaves the large runtime and service untouched', async t => {
  const root = await fixture(t)
  await prepareRuntime({ projectRoot: root })
  const resources = join(root, 'src-tauri/resources')
  const node = join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const service = join(resources, 'service/feasibility.mjs')
  const first = { node: (await stat(node)).mtimeMs, service: (await stat(service)).mtimeMs }
  await prepareRuntime({ projectRoot: root })
  assert.equal((await stat(node)).mtimeMs, first.node)
  assert.equal((await stat(service)).mtimeMs, first.service)
  const manifest = JSON.parse(await readFile(join(resources, 'service/package.json'), 'utf8'))
  assert.equal(manifest.dependencies['better-sqlite3'], '13.0.3')
  assert.equal(manifest.dependencies['node-pty'], '1.1.0')
  assert.deepEqual(manifest.allowScripts, { 'better-sqlite3@13.0.3': true, 'node-pty@1.1.0': true })
  assert.equal((await stat(join(resources, 'service/node_modules')).catch(() => null)), null)
  await writeFile(join(root, 'src/service/feasibility.mjs'), 'process.exit(1)\n')
  await prepareRuntime({ projectRoot: root })
  assert.equal((await stat(node)).mtimeMs, first.node)
  assert.equal(await readFile(service, 'utf8'), 'process.exit(1)\n')
})

test('wrong runtime pin fails before resources are staged', async t => {
  const root = await fixture(t, '0.0.0')
  await assert.rejects(prepareRuntime({ projectRoot: root }), /requires standalone Node/)
  assert.equal(await stat(join(root, 'src-tauri/resources')).catch(() => null), null)
})

test('stale same-size service content is replaced without rewriting Node', async t => {
  const root = await fixture(t)
  await prepareRuntime({ projectRoot: root })
  const resourceRoot = join(root, 'src-tauri/resources')
  const node = join(resourceRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const nodeStamp = (await stat(node)).mtimeMs
  await writeFile(join(resourceRoot, 'service/feasibility.mjs'), 'process.exit(9)\n')
  await prepareRuntime({ projectRoot: root })
  assert.equal(await readFile(join(resourceRoot, 'service/feasibility.mjs'), 'utf8'), 'process.exit(0)\n')
  assert.equal((await stat(node)).mtimeMs, nodeStamp)
})

test('a linked resource directory is rejected before outside files are written', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), '21x-tauri-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(root, 'src-tauri'))
  await symlink(outside, join(root, 'src-tauri/resources'))
  await assert.rejects(prepareRuntime({ projectRoot: root }), /cannot be symlinks/)
  assert.equal(await stat(join(outside, 'service')).catch(() => null), null)
})

test('native preparation refuses a module tree linked to another host', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), '21x-tauri-other-host-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(root, 'src-tauri/resources/service'), { recursive: true })
  await symlink(outside, join(root, 'src-tauri/resources/service/node_modules'))
  await assert.rejects(prepareRuntime({ projectRoot: root, native: true }), /cannot be symlinks/)
  assert.equal(await stat(join(outside, 'package.json')).catch(() => null), null)
})


test('private npm staging overrides repository lifecycle and linked install context', () => {
  const env = nativeNpmEnvironment('/owned/service', '/owned/node', {
    PATH: '/tools', SystemRoot: 'fixture-windows-root', npm_package_json: '/repository/package.json',
    npm_lifecycle_event: 'tauri:prepare:native', npm_execpath: '/tools/pnpm.cjs',
    npm_config_local_prefix: '/repository', NPM_CONFIG_PREFIX: '/repository',
    npm_config_workspace: '/repository', npm_config_install_strategy: 'linked',
    INIT_CWD: '/repository', npm_config_cache: '/preserved-cache', HTTPS_PROXY: 'fixture-proxy'
  })
  assert.equal(env.npm_package_json, undefined)
  assert.equal(env.npm_lifecycle_event, undefined)
  assert.equal(env.npm_execpath, undefined)
  assert.equal(env.NPM_CONFIG_PREFIX, undefined)
  assert.equal(env.npm_config_workspace, undefined)
  assert.equal(env.INIT_CWD, undefined)
  assert.equal(env.npm_config_local_prefix, '/owned/service')
  assert.equal(env.npm_config_prefix, '/owned/service')
  assert.equal(env.npm_config_workspaces, 'false')
  assert.equal(env.npm_config_install_strategy, 'hoisted')
  assert.equal(env.npm_config_cache, '/preserved-cache')
  assert.equal(env.HTTPS_PROXY, 'fixture-proxy')
  assert.equal(env.SystemRoot, 'fixture-windows-root')
  assert.ok(env.PATH.startsWith('/owned/node'))
})


test('Linux staging retains only its SQLite architecture/libc prebuild without rewriting it', async t => {
  const root = await fixture(t)
  const service = join(root, 'service')
  const directory = join(service, 'node_modules/better-sqlite3/prebuilds')
  await mkdir(directory, { recursive: true })
  for (const name of ['linux-x64.node', 'linux-arm64.node', 'linuxmusl-x64.node', 'darwin-arm64.node', 'win32-x64.node']) {
    await writeFile(join(directory, name), name)
  }
  const selected = join(directory, 'linux-x64.node')
  const before = await stat(selected)
  assert.deepEqual(await pruneForeignSqlitePrebuilds(service, { platform: 'linux', arch: 'x64', glibc: true }),
    ['darwin-arm64.node', 'linux-arm64.node', 'linuxmusl-x64.node', 'win32-x64.node'])
  assert.equal(await readFile(selected, 'utf8'), 'linux-x64.node')
  assert.equal((await stat(selected)).mtimeMs, before.mtimeMs)
  assert.deepEqual(await pruneForeignSqlitePrebuilds(service, { platform: 'linux', arch: 'x64', glibc: true }), [])
  await assert.rejects(pruneForeignSqlitePrebuilds(service, { platform: 'linux', arch: 'arm64', glibc: false }), /prebuild is missing/)
  assert.equal(await readFile(selected, 'utf8'), 'linux-x64.node')
})
