vi.mock('node:child_process', { spy: true })
vi.mock('node:fs/promises', { spy: true })
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PortableAgentDetectionOwner } from '../main/agent-installer/portable-detection'
import { PortableAgentInstallationOwner } from '../main/agent-installer/portable-installation'
import { AgentManager } from '../main/agent-manager-core'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { AGENT_INSTALLER_CODECS, AGENT_INSTALLER_PUBLIC_ERRORS, AGENT_INSTALLER_EVENT_CODECS } from '../shared/agent-installer-codecs'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import { AgentInstallerBackend, type AgentInstallerBackendOptions } from './agent-installer-backend'

let root: string, bin: string, fixtureNode: string, owner: PortableAgentDetectionOwner, backend: AgentInstallerBackend, options: AgentInstallerBackendOptions
let installation: PortableAgentInstallationOwner | undefined, manager: AgentManager | undefined, database: ReturnType<typeof createPortableTestDb> | undefined
let databaseRoot: string | undefined
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
  installation = undefined; manager = undefined; database = undefined; databaseRoot = undefined
  fixtureNode = standaloneNode()
  root = mkdtempSync(join(tmpdir(), '21x-cli-detection-')); bin = join(root, 'bin'); mkdirSync(bin)
  owner = new PortableAgentDetectionOwner({ home: root, cwd: root, environment: { PATH: bin, HOME: '/ignored-home' }, maxConcurrency: 3 })
  options = { detection: owner, engineEpoch: caller.engineEpoch, assertAvailable() { if (!existsSync(root)) throw new Error('Fixture owner root unavailable') }, assertOwners(actual) { if (actual.detection !== owner) throw new Error('Wrong actual detector owner') },
    isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin === caller.origin,
    canManageConfiguration: (_caller, access) => access === 'read' }
  backend = new AgentInstallerBackend(options)
})
afterEach(async () => { await backend.close(); await installation?.close(); await owner.close(); await manager?.stopAllSessions(); await manager?.stopServer(); database?.close(); if (databaseRoot) rmSync(databaseRoot, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

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
    expect(() => new AgentInstallerBackend({ ...options, detection: {} as PortableAgentDetectionOwner })).toThrow(ServiceProtocolError)
  })
})

/** The npm fixture is a synthetic, trusted JS program executed by actual Node.
 * It writes a real version-probe executable; it is not a downloaded package,
 * vendor SDK, live profile, or installed-native acceptance proof. */
describe.skipIf(process.platform === 'win32')('installation bindings borrowing actual SQLite, manager and process owners', () => {
  let npmCli: string, writeGrant: boolean, backendGrant: boolean, ownerValid: boolean, currentDocument: boolean
  let progress: Array<{ payload: { agentName: string; stage: string; output: string; percent: number }; recipient: DesktopCallerContext }>
  const identity = { ...caller, uiLeaseId: 'ui_installation_fixture' }
  const held = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
  const status = () => ({ success: false, error: AGENT_INSTALLER_PUBLIC_ERRORS.failed, newStatus: {
    ...Object.fromEntries(['nodejs', 'npm', 'pnpm', 'git', 'gh', 'glab', 'tea', 'claudeCode', 'opencode', 'codex', 'cursor'].map(name => [name, { installed: false, version: null }])),
    pi: { installed: false, version: null, supported: false, reason: 'Pi CLI is not installed.' },
    rtk: { installed: false, version: null, configured: false, integrations: { claudeCode: false, opencode: false, codex: false, cursor: false, pi: false } }
  } })
  async function install(name = 'opencode', signal = new AbortController().signal, recipient = identity) {
    const codec = AGENT_INSTALLER_CODECS['agent-installer:install']
    const wire = await backend.registry.invoke('agent-installer:install', codec.encodeArguments([name]), recipient, signal)
    expect(codec.validateWireResult(wire)).toBe(true)
    return codec.decodeResult((wire as { value: JsonValue }).value)
  }
  beforeEach(async () => {
    await backend.close()
    database = createPortableTestDb(); databaseRoot = dirname(dirname(database.getWorkspaceDir('installer-fixture')))
    manager = new AgentManager(database, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false })
    database.createAgent({ name: 'Actual configured backend', config: { coding_agent: 'opencode' } })
    writeGrant = backendGrant = ownerValid = currentDocument = true; progress = []
    program('node', "console.log('22.1.0')"); program('npm', "console.log('10.1.0')")
    const prefix = join(root, 'agent-cli'); mkdirSync(prefix)
    npmCli = join(bin, 'npm-cli.js')
    writeFileSync(npmCli, `const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);fs.writeFileSync(path.join(process.env.HOME,'install-receipt.json'),JSON.stringify({args,keys:Object.keys(process.env),cwd:process.cwd()}));const prefix=args[args.indexOf('--prefix')+1],pkg=path.join(prefix,'lib','node_modules','opencode-ai');fs.mkdirSync(pkg,{recursive:true});fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'opencode-ai',version:'1.2.3',bin:{opencode:'main.js'}}));fs.writeFileSync(path.join(pkg,'main.js'),'console.log("1.2.3")');const executable='#!'+process.execPath+'\\nconsole.log("1.2.3")\\n';fs.writeFileSync(path.join(process.env.HOME,'bin','opencode'),executable,{mode:0o700});console.log('PRIVATE_INSTALL_TOKEN');console.error('/private/profile secret');`)
    installation = new PortableAgentInstallationOwner({ home: root, cwd: root, environment: { PATH: bin }, detection: owner, nodeExecutable: fixtureNode, npm: { cliPath: npmCli, prefix }, assertCurrent() { if (!ownerValid || !database?.db.open) throw new ServiceProtocolError('DISCONNECTED') } })
    options = { ...options, installation,
      assertOwners(actual) { if (actual.detection !== owner || actual.installation !== installation || !ownerValid || !database?.db.open) throw new ServiceProtocolError('DISCONNECTED') },
      canManageConfiguration: (_caller, access) => access === 'read' || writeGrant,
      canInstallBackend: () => backendGrant,
      runInstallation: async (name, _caller, effect, beforeEffect) => {
        const run = async () => { beforeEffect(); const result = await effect(); beforeEffect(); return result }
        // System/cursor plans have no supported mutation owner. The actual
        // installer handles these as pre-effect failures plus read-only probes.
        return ['claudeCode', 'opencode', 'codex', 'pi', 'pnpm'].includes(name) ? manager!.runAgentInstallationMutation(name, run) : run()
      },
      isCurrentProgressRecipient: recipient => currentDocument && recipient.uiLeaseId === identity.uiLeaseId,
      emitProgress: (payload, recipient) => { progress.push({ payload, recipient }) }
    }
    backend = new AgentInstallerBackend(options)
  })
  it('runs a fixed package plan through actual Node and returns verified detection, private environment and fixed progress', async () => {
    const result = await install()
    expect(result).toMatchObject({ success: true, error: null, newStatus: { opencode: { installed: true, version: '1.2.3' } } })
    const receipt = JSON.parse(readFileSync(join(root, 'install-receipt.json'), 'utf8'))
    expect(receipt.args).toContain('opencode-ai'); expect(receipt.cwd).toBe(root)
    expect(receipt.keys).not.toEqual(expect.arrayContaining(['TASK_API_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS']))
    expect(progress.map(item => item.payload.stage)).toEqual(['starting', 'installing', 'verifying', 'complete'])
    expect(progress.every(item => AGENT_INSTALLER_EVENT_CODECS['agent-installer:progress'].validatePayload(item.payload))).toBe(true)
    expect(progress.every(item => item.recipient.uiLeaseId === identity.uiLeaseId)).toBe(true)
    expect(JSON.stringify({ result, progress })).not.toMatch(/PRIVATE_INSTALL_TOKEN|\/private\/profile|secret/)
    expect(installation!.childCount).toBe(0); expect(backend.inflightCount).toBe(0)
  }, 20000)
  it('returns typed unsupported status without installer effects, and refuses malformed or unauthorized requests before probes', async () => {
    const value = await install('cursor')
    expect(value).toMatchObject({ success: false, error: AGENT_INSTALLER_PUBLIC_ERRORS.unsupported })
    expect(existsSync(join(root, 'install-receipt.json'))).toBe(false)
    writeGrant = false
    const invoke = vi.spyOn(installation!, 'install')
    await expect(install()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    writeGrant = true; backendGrant = false
    await expect(install()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    backendGrant = true
    await expect(install('other')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    await expect(install('opencode', undefined, { ...identity, engineEpoch: 'old' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    expect(invoke).not.toHaveBeenCalled()
  }, 20000)
  it('holds the actual manager lease through a raw progress acknowledgement and refuses parallel install admission', async () => {
    const raw = held(), entered = held(), emit = options.emitProgress!
    options.emitProgress = async (payload, recipient) => { emit(payload, recipient); if (payload.stage === 'starting') { entered.release(); await raw.promise } }
    const pending = install().then(value => value, error => error)
    await entered.promise
    await expect(install()).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    expect(backend.inflightCount).toBe(1)
    await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(backend.inflightCount).toBe(1)
    raw.release(); expect(await pending).toMatchObject({ code: 'CANCELLED' })
    await backend.close(); expect(backend.inflightCount).toBe(0)
  }, 20000)
  it('refuses a selected actual live/cached backend before installer children and preserves its session', async () => {
    const agent = database!.getAgents()[0]!, task = database!.createTask({ title: 'Unrelated active user work' })!
    database!.updateTask(task.id, { agent_id: agent.id })
    const started = await manager!.requestSession(agent.id, task.id)
    expect(started.status).toBe('started')
    if (!('sessionId' in started)) throw new Error('Actual session fixture did not start')
    const invoke = vi.spyOn(installation!, 'install')
    await expect(install()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(invoke).not.toHaveBeenCalled(); expect(manager!.getSession(started.sessionId)).toBeDefined()
    expect(existsSync(join(root, 'install-receipt.json'))).toBe(false)
  })
  it('retains delayed accepted work on caller cancellation and applies current grants before later effects', async () => {
    const raw = held(), entered = held()
    vi.spyOn(installation!, 'install').mockImplementation(async (_name, controls) => {
      controls.onProgress?.({ stage: 'starting', output: 'private raw text is not forwarded', percent: -99 })
      entered.release(); await raw.promise; controls.beforeEffect(); return status()
    })
    const controller = new AbortController(), pending = install('opencode', controller.signal).then(value => value, error => error)
    await entered.promise; controller.abort()
    await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(backend.inflightCount).toBe(1); expect(existsSync(join(root, 'install-receipt.json'))).toBe(false)
    raw.release(); expect(await pending).toMatchObject({ code: 'CANCELLED' })
    expect(JSON.stringify(progress)).not.toContain('private raw text')
  })
  it('suppresses retired-document events and revokes completed inherited effect/progress callbacks without replay', async () => {
    const actual = installation!.install.bind(installation!)
    let captured: Parameters<PortableAgentInstallationOwner['install']>[1] | undefined
    vi.spyOn(installation!, 'install').mockImplementation((name, controls) => { captured = controls; return actual(name, controls) })
    currentDocument = false
    expect((await install()).success).toBe(true)
    expect(progress).toEqual([])
    currentDocument = true
    expect(captured).toBeDefined()
    expect(() => captured!.beforeEffect()).toThrow('Invalid')
    captured!.onProgress?.({ stage: 'complete', output: 'CLI installation complete.', percent: 100 })
    await Promise.resolve(); expect(progress).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'install-receipt.json'), 'utf8')).args.filter((value: string) => value === 'opencode-ai')).toHaveLength(1)
  }, 20000)
  it('refuses late grant withdrawal before later effects without changing stored config', async () => {
    const raw = held(), entered = held(), agents = database!.getAgents()
    vi.spyOn(installation!, 'install').mockImplementation(async (_name, controls) => { entered.release(); await raw.promise; controls.beforeEffect(); return status() })
    const pending = install().then(value => value, error => error)
    await entered.promise; backendGrant = false; raw.release()
    expect(await pending).toMatchObject({ code: 'INVALID_REQUEST' }); expect(database!.getAgents()).toEqual(agents)
    expect(existsSync(join(root, 'install-receipt.json'))).toBe(false)
  })
  it('rejects an owner replacement during accepted work while joining its exact raw acknowledgement', async () => {
    const raw = held(), entered = held()
    vi.spyOn(installation!, 'install').mockImplementation(async (_name, controls) => { entered.release(); await raw.promise; controls.beforeEffect(); return status() })
    const pending = install().then(value => value, error => error)
    await entered.promise; ownerValid = false
    expect(backend.inflightCount).toBe(1); raw.release()
    try { expect(await pending).toMatchObject({ code: 'DISCONNECTED' }) }
    finally { ownerValid = true }
    expect(existsSync(join(root, 'install-receipt.json'))).toBe(false)
  })
  it('refuses malformed successful snapshots without leaking logs or changing stored config', async () => {
    const agents = database!.getAgents()
    vi.spyOn(installation!, 'install').mockResolvedValue({ success: true, error: null, newStatus: { private: { installed: true, version: 'PRIVATE_TOKEN' } } })
    await expect(install()).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(database!.getAgents()).toEqual(agents)
  })
})
