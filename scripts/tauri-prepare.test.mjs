import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareRuntime } from './tauri-prepare.mjs'

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
