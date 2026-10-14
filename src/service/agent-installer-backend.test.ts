vi.mock('node:child_process', { spy: true })
vi.mock('node:fs/promises', { spy: true })
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PortableAgentDetectionOwner } from '../main/agent-installer/portable-detection'
import { AGENT_INSTALLER_CODECS } from '../shared/agent-installer-codecs'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'
import { AgentInstallerBackend, type AgentInstallerBackendOptions } from './agent-installer-backend'

let root: string, bin: string, fixtureNode: string, owner: PortableAgentDetectionOwner, backend: AgentInstallerBackend, options: AgentInstallerBackendOptions
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'detection-epoch', webviewId: 'main', origin: 'app://agent-settings' }
const names = ['node', 'npm', 'pnpm', 'git', 'gh', 'glab', 'tea', 'rtk', 'claude', 'opencode', 'codex', 'cursor-agent', 'pi']
const receipt = `const fs=require('node:fs'),path=require('node:path');const name=path.basename(process.argv[1]);fs.writeFileSync(path.join(process.env.HOME,'receipt-'+process.pid+'.json'),JSON.stringify({pid:process.pid,name,args:process.argv.slice(2),cwd:process.cwd(),keys:Object.keys(process.env),home:process.env.HOME}));`
/** Real owned Node children emulate finite CLI version commands only. These
 * fixtures establish process/transport ownership, not real backend SDK parity. */
function standaloneNode(): string {
  const current = realpathSync(process.execPath)
  const candidates = [process.env.TAURI_NODE_RUNTIME, ...(!process.versions.electron ? [current] : [process.env.npm_node_execpath, '/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node'])]
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue
    const resolved = realpathSync(candidate)
    if (!lstatSync(resolved).isFile() || !/^node(?:\.exe)?$/i.test(basename(resolved)) || /[\s\u0000-\u001f]/.test(resolved) || process.versions.electron && resolved === current) continue
    return resolved
  }
  throw new Error('Standalone Node fixture runtime unavailable; provide TAURI_NODE_RUNTIME')
}
function program(name: string, body: string) { writeFileSync(join(bin, name), '#!' + fixtureNode + '\n' + receipt + body, { mode: 0o700 }) }
function fixtures() {
  for (const name of names) program(name, `if(process.argv[2]==='prefix'){console.log(require('node:path').join(process.env.HOME,'npm-root'))}else{setTimeout(()=>console.log(name==='pi'?'0.80.5':'1.2.3'),40)}`)
}
function receipts(): Array<{ pid: number; name: string; args: string[]; cwd: string; keys: string[]; home: string }> {
  return readdirSync(root).filter(name => name.startsWith('receipt-')).map(name => JSON.parse(readFileSync(join(root, name), 'utf8')))
}
async function call(signal = new AbortController().signal, identity = caller) {
  const codec = AGENT_INSTALLER_CODECS['agent-installer:detect'], wire = await backend.registry.invoke('agent-installer:detect', {}, identity, signal)
  expect(codec.validateWireResult(wire)).toBe(true)
  return codec.decodeResult((wire as { value: JsonValue }).value)
}
beforeEach(() => {
  fixtureNode = standaloneNode()
  root = mkdtempSync(join(tmpdir(), '21x-cli-detection-')); bin = join(root, 'bin'); mkdirSync(bin)
  owner = new PortableAgentDetectionOwner({ home: root, cwd: root, environment: { PATH: bin, HOME: '/ignored-home' }, maxConcurrency: 3 })
  options = { detection: owner, engineEpoch: caller.engineEpoch, assertAvailable() { if (!existsSync(root)) throw new Error('Fixture owner root unavailable') }, assertOwners(actual) { if (actual.detection !== owner) throw new Error('Wrong actual detector owner') },
    isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin === caller.origin,
    canManageConfiguration: (_caller, access) => access === 'read' }
  backend = new AgentInstallerBackend(options)
})
afterEach(async () => { await backend.close(); await owner.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

describe.skipIf(process.platform === 'win32')('real portable CLI detection owner', () => {
  it('runs the exact finite probes with a private environment/PATH and bounded real child concurrency', async () => {
    fixtures()
    const before = process.env.PATH; let maximum = 0
    const sampling = setInterval(() => { maximum = Math.max(maximum, owner.childCount) }, 5)
    let value
    try { value = await call() } finally { clearInterval(sampling) }
    expect(value.pi).toMatchObject({ installed: true, version: '0.80.5', supported: true, reason: null })
    expect(value.claudeCode).toEqual({ installed: true, version: '1.2.3' }); expect(value.rtk).toMatchObject({ installed: true, configured: false })
    expect(maximum).toBeGreaterThan(0); expect(maximum).toBeLessThanOrEqual(3); expect(owner.childCount).toBe(0)
    expect(process.env.PATH).toBe(before)
    const observed = receipts()
    expect(new Set(observed.map(row => row.name))).toEqual(new Set(names))
    expect(observed.every(row => row.cwd === root && row.home === root && row.pid > 0)).toBe(true)
    expect(observed.every(row => row.keys.every(key => ['PATH', 'HOME', 'PWD'].includes(key)))).toBe(true)
    expect(observed.every(row => row.args.join(' ') === '--version' || row.name === 'npm' && row.args.join(' ') === 'prefix -g')).toBe(true)
  }, 20000)

  it('returns fresh missing/installed snapshots and preserves Pi minimum support without raw diagnostic leakage', async () => {
    expect((await call()).pi).toMatchObject({ installed: false, version: null, supported: false, reason: 'Pi CLI is not installed.' })
    program('pi', "console.log('Pi 0.80.4')")
    expect((await call()).pi).toMatchObject({ installed: true, version: '0.80.4', supported: false, reason: 'Pi 0.80.4 is unsupported. Update to 0.80.5 or newer.' })
    program('pi', "console.log('Pi 0.80.5')")
    expect((await call()).pi).toMatchObject({ supported: true, reason: null })
    program('claude', "console.log('PRIVATE_API_TOKEN /private/config');console.error('private secret')")
    const result = await call()
    expect(result.claudeCode).toEqual({ installed: true, version: null }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_API_TOKEN|private secret|\/private\/config/)
  }, 20000)

  it('reads genuine RTK markers asynchronously with size/symlink bounds and writes no integration config', async () => {
    fixtures()
    const paths = ['.claude/settings.json', '.config/opencode/plugins/rtk.ts', '.codex/hooks.json', '.cursor/hooks.json', '.pi/agent/extensions/rtk.ts']
    const content = ['rtk hook claude', 'rtk', 'rtk hook codex', 'rtk hook cursor', 'rtk']
    for (let index = 0; index < paths.length; index++) {
      const file = join(root, paths[index]); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, content[index])
    }
    expect((await call()).rtk).toMatchObject({ configured: true, integrations: { claudeCode: true, opencode: true, codex: true, cursor: true, pi: true } })
    writeFileSync(join(root, '.codex/hooks.json'), 'rtk hook codex' + 'x'.repeat(262144))
    const cursor = join(root, '.cursor/hooks.json'); rmSync(cursor); symlinkSync(join(root, '.claude/settings.json'), cursor)
    expect((await call()).rtk).toMatchObject({ configured: false, integrations: { codex: false, cursor: false } })
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toBe(content[0])
  }, 20000)

  it('refuses a parent/file identity swap around an actual opened integration descriptor', async () => {
    program('rtk', "console.log('0.49.0')"); program('codex', "console.log('0.4.1')")
    const directory = join(root, '.codex'), path = join(directory, 'hooks.json'); mkdirSync(directory); writeFileSync(path, 'rtk hook codex')
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open; let swapped = false
    vi.spyOn(filesystem, 'open').mockImplementation(async (...args: Parameters<typeof original>) => {
      const descriptor = await original(...args)
      if (!swapped && args[0] === path) { swapped = true; renameSync(directory, directory + '-original'); mkdirSync(directory); writeFileSync(path, 'unconfigured replacement') }
      return descriptor
    })
    expect((await call()).rtk).toMatchObject({ configured: false, integrations: { codex: false } })
    expect(swapped).toBe(true); expect(readFileSync(join(directory + '-original', 'hooks.json'), 'utf8')).toBe('rtk hook codex')
    expect(owner.inflightCount).toBe(0)
  }, 20000)

  it('refuses caller-selected commands/env/paths, foreign epoch/identity and missing read grants before child effects', async () => {
    fixtures(); const controller = new AbortController(); controller.abort()
    await expect(call(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(call(undefined, { ...caller, engineEpoch: 'stale' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(call(undefined, { ...caller, origin: 'foreign://installer' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canManageConfiguration = () => false
    await expect(call()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canManageConfiguration = () => true
    for (const body of [{ command: 'arbitrary' }, { environment: { TOKEN: 'private' } }, { home: '/foreign' }] as JsonValue[]) await expect(backend.registry.invoke('agent-installer:detect', body, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    await expect(backend.registry.invoke('agent-installer:install', { agentName: 'pi' }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(receipts()).toEqual([]); expect(owner.childCount).toBe(0)
  })

  it('suppresses a late snapshot after configuration read authority is revoked, without replaying version probes', async () => {
    program('node', "setTimeout(()=>console.log('22.1.0'),300)")
    const pending = call(); await vi.waitFor(() => expect(receipts().some(row => row.name === 'node')).toBe(true))
    options.canManageConfiguration = () => false
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(receipts().filter(row => row.name === 'node')).toHaveLength(1); expect(owner.childCount).toBe(0)
  })

  it('bounds captured output and reports fixed failures for nonzero exits without exporting stderr', async () => {
    program('node', "process.stdout.write('private-token'.repeat(20000));setInterval(()=>{},1000)")
    program('git', "console.error('private-failure /profile');process.exit(17)")
    const value = await call()
    expect(value.nodejs).toEqual({ installed: false, version: null, reason: 'CLI detection failed.' })
    expect(value.git).toEqual({ installed: false, version: null, reason: 'CLI detection failed.' })
    expect(JSON.stringify(value)).not.toMatch(/private-token|private-failure|\/profile/); expect(owner.childCount).toBe(0)
  }, 20000)

  it('acknowledges actual per-probe timeout before returning a failed status', async () => {
    await backend.close(); await owner.close()
    owner = new PortableAgentDetectionOwner({ home: root, cwd: root, environment: { PATH: bin }, maxConcurrency: 1, probeTimeoutMs: 1000 })
    options.detection = owner; backend = new AgentInstallerBackend(options)
    program('node', "setInterval(()=>{},1000)")
    const value = await call()
    expect(value.nodejs).toEqual({ installed: false, version: null, reason: 'CLI detection timed out.' })
    expect(owner.childCount).toBe(0); expect(owner.inflightCount).toBe(0)
  }, 20000)

  it('retains raw ignored-cancel children through shutdown escalation and preserves an unrelated real child', async () => {
    await backend.close(); await owner.close()
    owner = new PortableAgentDetectionOwner({ home: root, cwd: root, environment: { PATH: bin }, maxConcurrency: 1 }); options.detection = owner; backend = new AgentInstallerBackend(options)
    program('node', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")
    const unrelated = childProcess.spawn(fixtureNode, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    const controller = new AbortController(), outcome = call(controller.signal).then(value => value, error => error)
    try {
      await vi.waitFor(() => expect(receipts().some(row => row.name === 'node')).toBe(true))
      controller.abort()
      await expect(owner.close(10)).rejects.toMatchObject({ code: 'AGENT_DETECTION_TIMEOUT' })
      expect(owner.childCount).toBeGreaterThan(0); expect(owner.inflightCount).toBeGreaterThan(0)
      await owner.close(); expect(owner.childCount).toBe(0); expect(owner.inflightCount).toBe(0)
      expect(await outcome).toMatchObject({ code: 'CANCELLED' })
      expect(unrelated.exitCode).toBeNull(); expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
    } finally {
      const closed = new Promise<void>(resolve => unrelated.once('close', () => resolve())); unrelated.kill('SIGKILL'); await closed
    }
  }, 20000)

  it('retains actual child/stream errors until the owned close receipt, with fixed output only', async () => {
    const original = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn, spawned: childProcess.ChildProcess[] = []
    vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof original>) => { const child = original(...args); spawned.push(child); return child }) as typeof original)
    program('node', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")
    const pending = call(); await vi.waitFor(() => expect(receipts().some(row => row.name === 'node')).toBe(true))
    const child = spawned.find(child => child.pid === receipts().find(row => row.name === 'node')!.pid)!
    child.stdout!.emit('error', new Error('private stream failure'))
    expect(owner.childCount).toBeGreaterThan(0)
    const result = await pending
    expect(result.nodejs).toEqual({ installed: false, version: null, reason: 'CLI detection failed.' }); expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private stream failure')
  }, 20000)

  it('bounds snapshot admission and fences the boundary during owned shutdown', async () => {
    program('node', "setTimeout(()=>console.log('22.1.0'),300)")
    const first = call().catch(error => error), second = call().catch(error => error)
    await expect(call()).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    await backend.close(); await Promise.all([first, second])
    await expect(call()).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(backend.inflightCount).toBe(0)
    await owner.close(); expect(owner.childCount).toBe(0)
  })

  it('validates the exact owner and finite host environment instead of inheriting injection settings', () => {
    for (const environment of [{ PATH: bin, NODE_OPTIONS: '--require private' }, { PATH: bin, ANTHROPIC_API_KEY: 'private' }, { PATH: '\0foreign' }]) expect(() => new PortableAgentDetectionOwner({ home: root, cwd: root, environment })).toThrow('AGENT_DETECTION_INVALID_OPTIONS')
    expect(() => new PortableAgentDetectionOwner({ home: root, cwd: root, environment: { PATH: bin }, platform: process.platform === 'linux' ? 'darwin' : 'linux' })).toThrow('AGENT_DETECTION_INVALID_OPTIONS')
    expect(() => new AgentInstallerBackend({ ...options, detection: {} as PortableAgentDetectionOwner })).toThrow('owner')
  })
})
