/** Real inherited-stdin prefix proof under the staged Node. This deliberately
 * imports only the thin bootstrap export; no owner, DB, SDK or OS store starts.
 * A Linux run is Linux channel evidence, never Windows Job/runtime acceptance. */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const node = join(root, 'src-tauri/resources/node', process.platform === 'win32' ? 'node.exe' : 'node')
const entry = join(root, 'src-tauri/resources/service/production-stdio.mjs')
const paths = Object.fromEntries(['profileRoot', 'workspaceRoot', 'attachmentRoot', 'reposRoot', 'resourceRoot', 'tempRoot'].map(name => [name, join(root, 'synthetic-prefix-only', name)]))
const descriptor = { version: 1, kind: 'production-private-launch', launchId: 'private_prefix_fixture_001', profileId: 'synthetic-prefix',
  profileIntent: 'create-new', buildIdentity: 'prefix-fixture', resourceManifestSha256: 'a'.repeat(64), paths,
  capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported', configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
const rpc = Buffer.from('{"kind":"request","requestId":"host:1","payload":{"unicode":"🚀"}}\nsecond frame\n')
const probe = `import { readProductionStdinDescriptor } from ${JSON.stringify(pathToFileURL(entry).href)};
const descriptor=await readProductionStdinDescriptor();
const parts=[]; process.stdin.on('data', b=>parts.push(b));
process.stdin.on('end',()=>process.stdout.write(JSON.stringify({node:process.version,launchId:descriptor.launchId,rpc:Buffer.concat(parts).toString('base64')})));
process.stdin.resume();`
const child = spawn(node, ['--input-type=module', '-e', probe], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)
let stdinFailed = false
const closed = new Promise((resolveClose, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveClose({ code, signal })) })
child.stdout.on('data', bytes => { stdout = Buffer.concat([stdout, bytes]); if (stdout.length > 16384) child.kill() })
child.stderr.on('data', bytes => { stderr = Buffer.concat([stderr, bytes]); if (stderr.length > 16384) child.kill() })
child.stdin.on('error', () => { stdinFailed = true })
const timer = setTimeout(() => child.kill(), 15000)
try {
  // One write places the descriptor and RPC on the same actual private pipe.
  child.stdin.end(Buffer.concat([Buffer.from(JSON.stringify(descriptor) + '\n'), rpc]))
  const exit = await closed
  if (exit.code !== 0 || exit.signal || stderr.length || stdinFailed) throw new Error('Prefix child failed or emitted diagnostics')
  const result = JSON.parse(stdout.toString('utf8'))
  if (result.node !== 'v22.23.2' || result.launchId !== descriptor.launchId || result.rpc !== rpc.toString('base64')) throw new Error('Prefix/pipelined RPC observation mismatch')
  console.log(JSON.stringify({ proof: 'production-inherited-stdin-prefix', platform: process.platform, arch: process.arch,
    node: result.node, descriptorBytes: Buffer.byteLength(JSON.stringify(descriptor)), preservedRpcBytes: rpc.length,
    bootstrapSha256: createHash('sha256').update(await readFile(entry)).digest('hex'), childClosed: true,
    databaseOrCredentialsStarted: false, windowsJobRuntimeProof: false }))
} finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed } }
