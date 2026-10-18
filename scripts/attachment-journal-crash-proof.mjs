import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { isBuiltin } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resourceRoot = join(repository, 'src-tauri/resources'), pinnedNode = join(resourceRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
assert.equal(process.execPath, pinnedNode, 'Run the proof with the physically staged pinned Node')
assert.equal(process.version, 'v22.23.2'); assert.equal(process.versions.modules, '127')
const sqlite = join(resourceRoot, 'service/node_modules/better-sqlite3/lib/index.js')
assert.ok(existsSync(sqlite))
const root = mkdtempSync(join(tmpdir(), '21x-attachment-journal-kill-')), children = new Set()
function launch(profile, mode) {
  const child = fork(join(root, 'proof.mjs'), [profile, mode], { execPath: pinnedNode, cwd: root,
    env: { PATH: '', HOME: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-16384) })
  const closed = new Promise(resolveClose => child.once('close', (code, signal) => { children.delete(child); resolveClose({ code, signal }) }))
  const message = new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('Checkpoint deadline: ' + mode + ' ' + stderr)), 10000)
    child.once('message', value => { clearTimeout(timer); resolveMessage(value) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); reject(new Error('Unexpected child close: ' + code + ' ' + stderr)) })
  })
  return { child, closed, message }
}
try {
  await build({ configFile: false, root: repository, logLevel: 'silent', ssr: { noExternal: true },
    build: { ssr: join(repository, 'test/fixtures/attachment-journal-crash.ts'), target: 'node22', outDir: root, emptyOutDir: false,
      minify: false, rollupOptions: { external: id => isBuiltin(id) || id === 'better-sqlite3',
        output: { format: 'es', entryFileNames: 'proof.mjs', inlineDynamicImports: true, paths: id => id === 'better-sqlite3' ? pathToFileURL(sqlite).href : id } } } })
  const results = []
  for (const mode of ['partial', 'published', 'remove-before', 'remove-after']) {
    const profile = join(root, mode), running = launch(profile, mode)
    assert.deepEqual(await running.message, { kind: 'checkpoint', mode })
    assert.equal(running.child.kill('SIGKILL'), true)
    assert.deepEqual(await running.closed, { code: null, signal: 'SIGKILL' })
    const inspecting = launch(profile, 'inspect'), report = await inspecting.message
    assert.deepEqual(await inspecting.closed, { code: 0, signal: null })
    assert.equal(report.kind, 'inspection'); assert.equal(report.task.attachments, '[]')
    assert.equal(report.rows.length, mode.startsWith('remove-') ? 2 : 1)
    const publication = report.rows.find(row => row.entry.kind === 'publication')
    assert.equal(publication.entry.phase, mode === 'partial' ? 'staged' : 'published')
    assert.equal(publication.classification, mode === 'partial' ? 'publication_unconfirmed' : 'unreferenced')
    const directory = join(profile, 'attachments', report.task.id), names = readdirSync(directory)
    if (mode === 'remove-after') assert.deepEqual(names, [])
    else {
      assert.equal(names.length, 1)
      assert.equal(names[0].endsWith('.tmp'), mode === 'partial')
      const bytes = readFileSync(join(directory, names[0]))
      assert.equal(bytes.length, mode === 'partial' ? 65536 : 65537); assert.ok(bytes.every(byte => byte === 37))
    }
    if (mode.startsWith('remove-')) {
      const removal = report.rows.find(row => row.entry.kind === 'removal')
      assert.equal(removal.entry.phase, 'verified'); assert.equal(removal.classification, 'cleanup_unconfirmed')
    }
    results.push({ mode, signal: 'SIGKILL', reopened: true, automaticMutation: false, rows: report.rows.length, files: names.length })
  }
  console.log(JSON.stringify({ node: process.version, abi: process.versions.modules, results }))
} finally {
  for (const child of children) child.kill('SIGKILL')
  await Promise.all([...children].map(child => new Promise(resolveClose => child.once('close', resolveClose))))
  rmSync(root, { recursive: true, force: true })
}
