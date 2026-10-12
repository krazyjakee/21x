/** Actual staged native probes before an expensive GUI build, with fixed diagnostics. */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'

const resourceRoot = resolve(process.argv[2] ?? 'src-tauri/resources')
const profileRoot = await mkdtemp(join(tmpdir(), '21x-native-preflight-'))
const executable = join(resourceRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]))
const child = spawn(executable, [join(resourceRoot, 'service/feasibility.mjs')], {
  env: { ...env, TWENTYONEX_RESOURCE_ROOT: resourceRoot, TWENTYONEX_PROFILE_ROOT: profileRoot },
  stdio: ['pipe', 'pipe', 'ignore']
})
child.stdin.on('error', () => {})
const exited = once(child, 'close').catch(() => [-1])
let buffered = ''
let epoch = ''
let counter = 0
const pending = new Map()
function rejectPending() {
  for (const entry of pending.values()) entry.reject(new Error('Staged service disconnected'))
  pending.clear()
}
child.once('error', rejectPending)
child.once('close', rejectPending)
child.stdout.on('data', bytes => {
  buffered += bytes.toString('utf8')
  if (Buffer.byteLength(buffered) > 1024 * 1024) { child.kill(); rejectPending(); return }
  for (;;) {
    const newline = buffered.indexOf('\n')
    if (newline < 0) break
    let frame
    try { frame = JSON.parse(buffered.slice(0, newline)) }
    catch { child.kill(); rejectPending(); return }
    buffered = buffered.slice(newline + 1)
    const entry = pending.get(frame.requestId)
    if (!entry) continue
    pending.delete(frame.requestId)
    if (frame.error) entry.reject(new Error('Staged service operation failed'))
    else entry.resolve(frame)
  }
})
function request(operation, payload = {}) {
  const requestId = `host:${++counter}`
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    child.stdin.write(JSON.stringify({ protocolVersion: 1, engineEpoch: epoch,
      kind: 'request', requestId, operation, payload }) + '\n')
  })
}
const deadline = setTimeout(() => { child.kill(); rejectPending() }, 40_000)
try {
  const ready = await request('engine.initialize', { protocolVersion: 1, profileRoot, resourceRoot })
  epoch = ready.result.engineEpoch
  const response = await request('engine.probe')
  process.stdout.write(JSON.stringify(response.result, null, 2) + '\n')
  await request('engine.shutdown')
  const [code] = await exited
  if (code !== 0 || !response.result.ok) process.exitCode = 1
} catch {
  process.stderr.write('Staged native preflight failed; review fixed diagnostic phases.\n')
  child.kill()
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  await rm(profileRoot, { recursive: true, force: true })
}
