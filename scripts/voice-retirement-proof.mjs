/** Linux-only synthetic descendant proof; never invokes an installed voice. */
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pins = JSON.parse(readFileSync(join(repository, 'scripts/tauri-runtime.json'), 'utf8'))
if (process.platform !== 'linux' || process.versions.electron || process.version !== `v${pins.nodeVersion}`) {
  throw new Error('Use the pinned bundled Linux Node for this synthetic proof.')
}
const script = resolve(process.argv[2] ?? join(repository, 'src/main/voice/voice-tts-worker.js'))
const root = mkdtempSync(join(tmpdir(), '21x-218-retirement-proof-'))
const executable = join(root, 'espeak-ng'),
  receipt = join(root, 'held.json')
writeFileSync(
  executable,
  `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid}));
setInterval(() => {}, 1000);
`
)
chmodSync(executable, 0o700)
const child = fork(script, [], {
  execPath: process.execPath,
  execArgv: [],
  env: { PATH: root, TMPDIR: root },
  stdio: ['ignore', 'ignore', 'ignore', 'ipc']
})
const closed = new Promise((resolve) => child.once('close', resolve))
let pid
const alive = () => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function bounded(raw) {
  let timer
  try {
    return await Promise.race([
      raw,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Synthetic raw process deadline')), 5000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
try {
  const ready = bounded(
    new Promise((resolve) =>
      child.on('message', (value) => {
        if (value.t === 'status' && value.state === 'ready') resolve()
      })
    )
  )
  child.send({ t: 'load', engine: 'system' })
  await ready
  child.send({ t: 'speak', speechId: 'controlled-close', requestEpoch: 1, sentences: ['hold'], speakerId: 0, speed: 1 })
  const deadline = Date.now() + 5000
  while (!existsSync(receipt)) {
    if (Date.now() > deadline) throw new Error('Synthetic admission deadline')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  pid = JSON.parse(readFileSync(receipt, 'utf8')).pid
  child.kill('SIGTERM')
  await bounded(closed)
  const actual = alive()
  console.log(
    JSON.stringify({
      node: process.version,
      workerSha256: createHash('sha256').update(readFileSync(script)).digest('hex'),
      workerClosed: true,
      expectedDescendantAlive: false,
      actualDescendantAlive: actual
    })
  )
  assert.equal(actual, false, 'Worker close must follow owned synthesis descendant close')
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await bounded(closed)
  }
  // Old-code negative controls can orphan their synthetic command. Cleanup is
  // restricted to this private executable, never a user/provider process.
  if (pid && alive() && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(executable)) process.kill(pid, 'SIGKILL')
  rmSync(root, { recursive: true, force: true })
}
