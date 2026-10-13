import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageConnectorWorker } from './tauri-stage-connectors.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), '21x-stage-connector-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pieces = { '@activepieces/piece-trello': { version: '0.6.0', actions: {}, triggers: {} },
    '@activepieces/piece-todoist': { version: '0.5.0', actions: {}, triggers: {} } }
  const pins = Object.fromEntries(Object.entries(pieces).map(([name, piece]) => [name, piece.version]))
  const allowlist = { pieces, packages: {}, reviewedLicenseExceptions: [] }
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'src/main/connectors/piece-host'), { recursive: true })
  await writeFile(join(root, 'scripts/tauri-runtime.json'), JSON.stringify({ nodeVersion: '22.23.2', connectorDependencies: pins }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: pins }))
  await writeFile(join(root, 'src/main/connectors/allowlist.ts'), '// BEGIN ALLOWLIST DATA\nexport const allowlist = ' + JSON.stringify(allowlist) + '\n// END ALLOWLIST DATA')
  await writeFile(join(root, 'src/main/connectors/piece-host/host-entry.ts'), 'process.once("disconnect", () => process.exit(0))\n')
  for (const base of [join(root, 'node_modules'), join(root, 'src-tauri/resources/service/node_modules')]) {
    for (const [name, version] of Object.entries(pins)) {
      const directory = join(base, name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.cjs', dependencies: {} }))
      await writeFile(join(directory, 'index.cjs'), 'module.exports = {};\n')
    }
  }
  return { root, service: join(root, 'src-tauri/resources/service') }
}

test('connector staging is deterministic and does not rewrite unchanged worker assets', async t => {
  const f = await fixture(t)
  const first = await stageConnectorWorker(f.root)
  const before = await stat(join(f.service, 'piece-host.cjs'))
  const second = await stageConnectorWorker(f.root)
  assert.deepEqual(second, first)
  assert.equal((await stat(join(f.service, 'piece-host.cjs'))).mtimeMs, before.mtimeMs)
  assert.equal(first.redistributionReviewComplete, false)
})

test('connector staging rejects changed resource pins before writing an executable', async t => {
  const f = await fixture(t)
  const path = join(f.root, 'scripts/tauri-runtime.json')
  const pins = JSON.parse(await readFile(path, 'utf8'))
  pins.connectorDependencies['@activepieces/piece-trello'] = '0.6.1'
  await writeFile(path, JSON.stringify(pins))
  await assert.rejects(stageConnectorWorker(f.root), /resource pins disagree/)
  await assert.rejects(access(join(f.service, 'piece-host.cjs')))
})

test('connector staging rejects package bytes that differ from the frozen source installation', async t => {
  const f = await fixture(t)
  await writeFile(join(f.service, 'node_modules/@activepieces/piece-trello/index.cjs'), 'module.exports = { changed: true };')
  await assert.rejects(stageConnectorWorker(f.root), /bytes disagree/)
  await assert.rejects(access(join(f.service, 'piece-host.cjs')))
})

test('connector staging refuses a package that adds an unreviewed runtime dependency', async t => {
  const f = await fixture(t)
  const path = join(f.service, 'node_modules/@activepieces/piece-trello/package.json')
  const metadata = JSON.parse(await readFile(path, 'utf8'))
  metadata.dependencies = { 'unreviewed-package': '1.0.0' }
  await writeFile(path, JSON.stringify(metadata))
  await assert.rejects(stageConnectorWorker(f.root), /closure or pin changed/)
  await assert.rejects(access(join(f.service, 'piece-host.cjs')))
})
