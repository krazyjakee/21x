import { afterEach, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PortableAgentDetectionOwner } from './portable-detection'
const runtime = resolve('src-tauri/resources/node/node'), available = process.platform !== 'win32' && existsSync(runtime)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), '21x-detection-authority-')), preferred = join(home, 'managed', 'bin'), legacy = join(home, '.local', 'bin')
  mkdirSync(preferred, { recursive: true }); mkdirSync(legacy, { recursive: true })
  const script = (version: string) => `#!${runtime}\nconsole.log('${version}')\n`
  for (const [path, version] of [[join(preferred, 'node'), '99.0.0'], [join(legacy, 'node'), '1.0.0']] as const) { writeFileSync(path, script(version)); chmodSync(path, 0o700) }
  const owner = new PortableAgentDetectionOwner({ home, cwd: home, environment: { PATH: '' }, preferredPaths: [preferred], maxConcurrency: 1 })
  cleanups.push(async () => { writeFileSync(join(home, 'release'), 'release'); await owner.close(); rmSync(home, { recursive: true, force: true }) })
  return { owner, home, preferred }
}
it.skipIf(!available)('gives managed CLI roots the same priority as actual runtime and rejects foreign owner roots', async () => {
  const f = fixture(); expect((await f.owner.detect()).nodejs.version).toBe('99.0.0')
  expect(() => f.owner.assertOwners({ home: f.home, cwd: '/foreign' })).toThrow('AGENT_DETECTION_INVALID_OPTIONS')
  let calls = 0; expect(() => f.owner.detect(undefined, { beforeEffect: () => { calls++; throw new Error('withdrawn') } })).toThrow('withdrawn')
  expect(calls).toBe(1); expect(f.owner.childCount).toBe(0)
})
it.skipIf(!available)('rechecks withdrawn authority after actual child completion and refuses queued probe effects', async () => {
  const f = fixture(), entered = join(f.home, 'entered'), release = join(f.home, 'release')
  writeFileSync(join(f.preferred, 'node'), `#!${runtime}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(entered)},'entered');const wait=()=>{if(fs.existsSync(${JSON.stringify(release)}))console.log('99.0.0');else setTimeout(wait,5)};wait();\n`); chmodSync(join(f.preferred, 'node'), 0o700)
  let allowed = true
  const result = f.owner.detect(undefined, { beforeEffect: () => { if (!allowed) throw new Error('withdrawn') } }), rejection = expect(result).rejects.toThrow('withdrawn')
  await vi.waitFor(() => expect(existsSync(entered)).toBe(true)); expect(f.owner.childCount).toBe(1)
  allowed = false; writeFileSync(release, 'release'); await rejection
  await f.owner.close(); expect(f.owner.childCount).toBe(0); expect(f.owner.inflightCount).toBe(0)
})
