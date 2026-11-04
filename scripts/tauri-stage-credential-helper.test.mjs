import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, lstat, symlink, writeFile, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageCredentialHelper } from './tauri-stage-credential-helper.mjs'

async function fixture(t) {
  // The script realpaths projectRoot; tmpdir() can be a link (macOS) or an 8.3 name (Windows).
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), '21x-credential-helper-')))
  t.after(() => rm(projectRoot, { recursive: true, force: true }))
  await mkdir(join(projectRoot, 'src-tauri/credentials'), { recursive: true })
  return projectRoot
}

function fakeCargo(projectRoot, name, bytes) {
  return (command, args, options) => {
    assert.equal(command, 'cargo')
    assert.deepEqual(args, ['build', '--locked', '--release', '--bin', 'twentyonex-credential-key', '--target-dir', join(projectRoot, 'src-tauri/target')])
    assert.equal(options.cwd, join(projectRoot, 'src-tauri/credentials'))
    mkdirSync(join(projectRoot, 'src-tauri/target/release'), { recursive: true })
    writeFileSync(join(projectRoot, 'src-tauri/target/release', name), bytes)
    return { status: 0 }
  }
}

test('stages the physical build, keeps an identical second run, and refreshes changed bytes', async t => {
  const projectRoot = await fixture(t)
  const name = 'twentyonex-credential-key'
  const destination = join(projectRoot, 'src-tauri/resources/native', name)
  const first = await stageCredentialHelper({ projectRoot, run: fakeCargo(projectRoot, name, 'first') })
  assert.deepEqual(first, { path: destination, changed: true })
  assert.equal((await lstat(destination)).isFile(), true)
  const second = await stageCredentialHelper({ projectRoot, run: fakeCargo(projectRoot, name, 'first') })
  assert.equal(second.changed, false)
  const third = await stageCredentialHelper({ projectRoot, run: fakeCargo(projectRoot, name, 'second') })
  assert.equal(third.changed, true)
  assert.equal(await readFile(destination, 'utf8'), 'second')
})

test('uses the Windows executable name', async t => {
  const projectRoot = await fixture(t)
  const name = 'twentyonex-credential-key.exe'
  const staged = await stageCredentialHelper({ projectRoot, platform: 'win32', run: fakeCargo(projectRoot, name, 'windows') })
  assert.equal(staged.path, join(projectRoot, 'src-tauri/resources/native', name))
  assert.equal(await readFile(staged.path, 'utf8'), 'windows')
})

test('rejects a linked or missing build output and never stages it', async t => {
  const projectRoot = await fixture(t)
  const name = 'twentyonex-credential-key'
  const destination = join(projectRoot, 'src-tauri/resources/native', name)
  const noOutput = () => ({ status: 0 })
  await assert.rejects(stageCredentialHelper({ projectRoot, run: noOutput }), { code: 'ENOENT' })
  await mkdir(join(projectRoot, 'src-tauri/target/release'), { recursive: true })
  await writeFile(join(projectRoot, 'external'), 'outside')
  await symlink(join(projectRoot, 'external'), join(projectRoot, 'src-tauri/target/release', name))
  await assert.rejects(stageCredentialHelper({ projectRoot, run: noOutput }), /physical regular file/)
  await assert.rejects(lstat(destination), { code: 'ENOENT' })
})

test('rejects a linked staged helper or staging directory without replacing it', async t => {
  const projectRoot = await fixture(t)
  const name = 'twentyonex-credential-key'
  const native = join(projectRoot, 'src-tauri/resources/native')
  await mkdir(native, { recursive: true })
  await writeFile(join(projectRoot, 'external'), 'outside')
  const destination = join(native, name)
  await symlink(join(projectRoot, 'external'), destination)
  await assert.rejects(stageCredentialHelper({ projectRoot, run: fakeCargo(projectRoot, name, 'built') }), /physical regular file/)
  assert.equal((await lstat(destination)).isSymbolicLink(), true)
  await rm(destination)
  await rm(native, { recursive: true })
  await symlink(projectRoot, native, 'dir')
  await assert.rejects(stageCredentialHelper({ projectRoot, run: fakeCargo(projectRoot, name, 'built') }), /directory must be physical/)
})

test('production hooks prepare native dependencies and helper before sealing resources', async () => {
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.production.conf.json', import.meta.url)))
  const prepare = ['pnpm tauri:prepare:native', 'pnpm tauri:prepare:credential-helper', 'pnpm tauri:prepare:production']
  // Exact steps: a dropped step or any separator but && (which stops on failure) changes the split.
  assert.deepEqual(config.build.beforeDevCommand.split(' && '), [...prepare, 'pnpm tauri:production:frontend:dev'])
  assert.deepEqual(config.build.beforeBuildCommand.split(' && '), [...prepare, 'pnpm tauri:production:frontend:build'])
})
