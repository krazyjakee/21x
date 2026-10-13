import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { nativeCredentialEnvironment } from '../src/main/platform/native-application-key-store'
import { observeOwnedProcess } from './credential-proof/process.mjs'
import { ServicePeer } from '../src/service/transport/peer'
import { PRODUCTION_HOST_SCHEMAS, type ProductionLaunchDescriptor } from '../src/shared/production-bootstrap'
import { isBootstrapResult, isRecord } from '../src/shared/service-protocol'

const owned: Array<{ child: ChildProcess; receipt: ReturnType<typeof observeOwnedProcess>; root: string }> = []
afterEach(async () => {
  for (const item of owned.splice(0)) {
    expect(await item.receipt.stop()).toBe(true)
    rmSync(item.root, { recursive: true, force: true })
  }
})
function fixture(changedManifest = false) {
  const resourceRoot = resolve('src-tauri/resources'), manifestBytes = readFileSync(join(resourceRoot, 'service/PRODUCTION_RESOURCE_MANIFEST.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { buildIdentity: string }
  const root = mkdtempSync(join(tmpdir(), '21x-staged-production-proof-'))
  const descriptor: ProductionLaunchDescriptor = { version: 1, kind: 'production-private-launch', launchId: 'launch_node_proof_001', profileId: 'staged-private-proof', profileIntent: 'create-new',
    buildIdentity: manifest.buildIdentity, resourceManifestSha256: changedManifest ? '0'.repeat(64) : createHash('sha256').update(manifestBytes).digest('hex'),
    paths: { resourceRoot, profileRoot: join(root, 'profile'), workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), tempRoot: join(root, 'temp') },
    capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported', configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
  const executable = process.env.TAURI_NODE_RUNTIME!
  const child = spawn(executable, [process.env.TAURI_PRODUCTION_SERVICE_ENTRY!], { cwd: resolve('.'), env: nativeCredentialEnvironment(process.env),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  const receipt = observeOwnedProcess(child, process.platform !== 'win32'); owned.push({ child, receipt, root })
  child.stdin!.on('error', () => {}); child.stdout!.on('error', () => {}); child.stderr!.on('data', () => {})
  const descriptorPipe = child.stdio[3] as Writable
  descriptorPipe.on('error', () => {}); descriptorPipe.end(JSON.stringify(descriptor))
  return { child, receipt, descriptor }
}

describe('actual staged production Node private pipes', () => {
  it.skipIf(!process.env.TAURI_PRODUCTION_SERVICE_ENTRY)('verifies the staged closure, loads the real service graph and negotiates before granting domain access', async () => {
    const f = fixture()
    const peer = new ServicePeer({ role: 'host', engineEpoch: null, operations: {
      'engine.ping': { validatePayload: isRecord, validateResult: isBootstrapResult },
      'engine.shutdown': { validatePayload: isRecord, validateResult: value => isRecord(value) && value.stopped === true },
      'project:getAll': { validatePayload: isRecord, validateResult: () => false },
      'engine.initialize': { validatePayload: isRecord, validateResult: isBootstrapResult },
      ...PRODUCTION_HOST_SCHEMAS
    }, write: bytes => new Promise<void>((resolveWrite, reject) => f.child.stdin!.write(bytes, error => error ? reject(error) : resolveWrite())) })
    f.child.stdout!.on('data', (bytes: Buffer) => peer.receive(bytes))
    f.child.once('close', () => peer.disconnect())
    const ping = await peer.request('engine.ping', {}, { timeoutMs: 30_000 })
    expect(ping).toMatchObject({ protocolVersion: 1, nodeVersion: 'v22.23.2' })
    await expect(peer.request('project:getAll', {})).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(peer.request('engine.initialize', { protocolVersion: 1, launchId: f.descriptor.launchId, paths: f.descriptor.paths })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(await peer.request('engine.shutdown', {})).toEqual({ stopped: true })
    await f.receipt.receipt
    expect(f.child.exitCode).toBe(0)
    expect(existsSync(f.descriptor.paths.profileRoot)).toBe(false)
  }, 45_000)

  it.skipIf(!process.env.TAURI_PRODUCTION_SERVICE_ENTRY)('rejects a changed private manifest digest before any engine frame, profile or credential access', async () => {
    const f = fixture(true), chunks: Buffer[] = []
    f.child.stdout!.on('data', (bytes: Buffer) => chunks.push(Buffer.from(bytes)))
    await f.receipt.receipt
    expect(f.child.exitCode).toBe(1)
    expect(Buffer.concat(chunks)).toHaveLength(0)
    expect(existsSync(f.descriptor.paths.profileRoot)).toBe(false)
  }, 45_000)
})
