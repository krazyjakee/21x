import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalServiceCore, type PtyOptions, type TerminalProcessHost } from '../main/terminal-service-core'
import { TerminalBackend, type TerminalBackendOptions } from './terminal-backend'
import { TERMINAL_COMMAND_CODECS, TERMINAL_DESKTOP_LIMITS, type TerminalCommandCodec, type TerminalDesktopOperation } from '../shared/terminal-desktop-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'

const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'terminal-epoch', webviewId: 'main', origin: 'app://trusted-main' }
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const cleanups: Array<() => Promise<void>> = []
function fixture() {
  const profile = mkdtempSync(join(tmpdir(), '21x-terminal-backend-')), root = join(profile, 'root'), cwd = join(root, 'work'), outside = join(profile, 'outside')
  mkdirSync(cwd, { recursive: true }); mkdirSync(outside)
  const children: Array<{ options: PtyOptions; handle: { pid: number; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } }> = []
  let nextPid = 4242
  const host = {
    resolveShell: () => 'controlled-shell',
    create: vi.fn((options: PtyOptions) => {
      const handle = { pid: nextPid++, write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
      children.push({ options, handle }); return handle
    }),
    getCwd: vi.fn<TerminalProcessHost['getCwd']>().mockResolvedValue(cwd)
  }
  const core = new TerminalServiceCore(host), events: Array<{ operation: string; payload: JsonValue; recipient: DesktopCallerContext }> = [], releases: Array<() => void> = []
  const options: TerminalBackendOptions = {
    terminals: core, engineEpoch: caller.engineEpoch, assertAvailable() {},
    isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin?.startsWith('app://trusted') === true,
    canAccessTerminal: () => true, resolveDirectory: () => ({ root, cwd }),
    emit: (operation, payload, recipient) => { events.push({ operation, payload, recipient }) }, onFatalEvent: vi.fn()
  }
  const backend = new TerminalBackend(options)
  const child = (index = 0) => { const value = children[index]; if (!value) throw new Error('Missing controlled native handle'); return value }
  const exit = (index = 0) => { const value = child(index); value.options.onExit(value.handle.pid, 0, null) }
  async function call<K extends TerminalDesktopOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], identity = caller, signal = new AbortController().signal): Promise<DesktopCommandMap[K]['result']> {
    const codec = TERMINAL_COMMAND_CODECS[operation] as TerminalCommandCodec<K>
    const result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
    expect(codec.validateWireResult(result)).toBe(true)
    return codec.decodeResult((result as { value?: JsonValue }).value)
  }
  const value = { backend, core, host, options, events, releases, profile, root, cwd, outside, children, child, exit, call, setNextPid: (pid: number) => { nextPid = pid } }
  cleanups.push(async () => {
    releases.forEach(release => release())
    backend.shutdown()
    children.forEach((_child, index) => exit(index))
    await backend.close(); await core.close()
    rmSync(profile, { recursive: true, force: true })
  })
  return value
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

describe('production terminal backend with actual TerminalServiceCore', () => {
  it('reports failed native resize and reconnect resize without respawning or claiming an acknowledgement', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24])
    f.child().handle.resize.mockImplementation(() => { throw new Error('Controlled native resize failure') })
    await expect(f.call('terminal:resize', ['panel-1', 120, 50])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(f.call('terminal:create', ['panel-1', 120, 50])).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(f.host.create).toHaveBeenCalledOnce(); expect(f.core.identity('panel-1')).toEqual({ pid: 4242, generation: 1 })
    expect(f.child().handle.kill).not.toHaveBeenCalled()
  })
  it('creates in the selected directory and reconnects the current process without respawn or input replay', async () => {
    const f = fixture()
    expect(await f.call('terminal:create', ['panel-1', 80, 24, f.cwd])).toEqual({ pid: 4242 })
    expect(f.child().options).toMatchObject({ cwd: f.cwd, shellPath: 'controlled-shell', cols: 80, rows: 24 })
    f.child().options.onData('\x1b[31mready\x1b[0m\n')
    expect(await f.call('terminal:create', ['panel-1', 100, 40])).toEqual({ pid: 4242 })
    expect(f.host.create).toHaveBeenCalledOnce(); expect(f.child().handle.resize).toHaveBeenCalledWith(100, 40)
    expect(f.child().handle.kill).not.toHaveBeenCalled(); expect(f.child().handle.write).not.toHaveBeenCalled()
    expect(await f.call('terminal:getBuffer', ['panel-1', 200])).toEqual({ lines: ['ready'] })
    expect(await f.call('terminal:getCwd', ['panel-1', 4242])).toEqual({ cwd: f.cwd })
    await f.call('terminal:write', ['panel-1', 'echo ready\r']); await f.call('terminal:resize', ['panel-1', 120, 50])
    expect(f.child().handle.write).toHaveBeenCalledExactlyOnceWith('echo ready\r')
    expect(f.events).toEqual([{ operation: 'terminal:data', payload: { id: 'panel-1', data: '\x1b[31mready\x1b[0m\n' }, recipient: caller }])
    const schema = f.backend.operationSchemas(caller)['terminal:getBuffer']
    if (!schema?.handle) throw new Error('Missing terminal operation handler')
    expect(schema.validateResult(await schema.handle({ id: 'panel-1' }, new AbortController().signal))).toBe(true)
  })
  it('requires current trusted caller and owner authority before takeover, reads or process mutations', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24])
    const other = { ...caller, origin: 'app://trusted-other' }
    for (const operation of ['terminal:create', 'terminal:write', 'terminal:kill', 'terminal:getCwd', 'terminal:getBuffer'] as const) {
      const args = operation === 'terminal:create' ? ['panel-1', 80, 24] : operation === 'terminal:write' ? ['panel-1', 'bad'] : ['panel-1']
      await expect(f.call(operation, args as never, other)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    await expect(f.call('terminal:write', ['panel-1', 'bad'], { ...caller, engineEpoch: 'retired' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(f.call('terminal:create', ['panel-2', 80, 24], { ...caller, principal: 'service' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.backend.canReadEvent('terminal:data', { id: 'panel-1', data: 'private' }, other)).toBe(false)
    f.options.canAccessTerminal = () => false
    await expect(f.call('terminal:write', ['panel-1', 'bad'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.child().handle.write).not.toHaveBeenCalled(); expect(f.child().handle.kill).not.toHaveBeenCalled(); expect(f.host.getCwd).not.toHaveBeenCalled()
  })
  it('refuses arbitrary and symlink-escaping cwd before spawn, accepting only the canonical selected directory', async () => {
    const f = fixture()
    await expect(f.call('terminal:create', ['panel-1', 80, 24, f.outside])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const escape = join(f.root, 'escape'), alias = join(f.root, 'alias')
    symlinkSync(f.outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(f.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
    f.options.resolveDirectory = () => ({ root: f.root, cwd: escape })
    await expect(f.call('terminal:create', ['panel-1', 80, 24])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.host.create).not.toHaveBeenCalled()
    f.options.resolveDirectory = () => ({ root: f.root, cwd: f.cwd })
    expect(await f.call('terminal:create', ['panel-1', 80, 24, alias])).toEqual({ pid: 4242 })
    expect(f.child().options.cwd).toBe(f.cwd)
    f.host.getCwd.mockResolvedValue(f.outside)
    expect(await f.call('terminal:getCwd', ['panel-1', 4242])).toEqual({ cwd: null })
  })
  it('retires a newly spawned process if the server directory selection changes before acknowledgement', async () => {
    const f = fixture(), spawn = f.host.create.getMockImplementation()
    if (!spawn) throw new Error('Missing controlled process factory')
    f.host.create.mockImplementationOnce(options => { const handle = spawn(options); f.options.resolveDirectory = () => ({ root: f.outside, cwd: f.outside }); return handle })
    await expect(f.call('terminal:create', ['panel-1', 80, 24])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.child().options.cwd).toBe(f.cwd); expect(f.child().handle.kill).toHaveBeenCalledOnce()
    await expect(f.backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    f.exit(); await f.backend.close()
  })
  it('acknowledges kill only after actual native close and refuses live or retiring foreign IDs', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24])
    await f.call('terminal:kill', ['panel-1', 9999]); expect(f.child().handle.kill).not.toHaveBeenCalled()
    const killing = f.call('terminal:kill', ['panel-1', 4242])
    await vi.waitFor(() => expect(f.child().handle.kill).toHaveBeenCalledOnce())
    const secondKill = f.call('terminal:kill', ['panel-1', 4242])
    expect(f.events.filter(event => event.operation === 'terminal:exit')).toEqual([])
    await expect(f.call('terminal:create', ['panel-1', 80, 24])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.backend.inflightCount).toBeGreaterThan(0)
    f.exit(); await Promise.all([killing, secondKill])
    expect(f.events.filter(event => event.operation === 'terminal:exit')).toHaveLength(1)
    f.exit(); expect(f.events.filter(event => event.operation === 'terminal:exit')).toHaveLength(1)
    await f.call('terminal:create', ['panel-1', 80, 24]); expect(f.host.create).toHaveBeenCalledTimes(2)
    await f.call('terminal:kill', ['panel-1', 4242]); expect(f.child(1).handle.kill).not.toHaveBeenCalled()
    f.core.create({ id: 'foreign', cols: 80, rows: 24, cwd: f.cwd }, { data() {}, exit() {} })
    await expect(f.call('terminal:create', ['foreign', 80, 24])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    f.core.kill('foreign')
    await expect(f.call('terminal:create', ['foreign', 80, 24])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.host.create).toHaveBeenCalledTimes(3)
  })
  it('fences late cwd and old data/exit by captured generation across a same-ID restart', async () => {
    const f = fixture(), gate = held(); f.releases.push(gate.release)
    await f.call('terminal:create', ['panel-1', 80, 24])
    f.host.getCwd.mockImplementation(async (_pid, current) => { await gate.promise; expect(current()).toBe(false); return f.cwd })
    const probe = f.call('terminal:getCwd', ['panel-1', 4242])
    await vi.waitFor(() => expect(f.host.getCwd).toHaveBeenCalledOnce())
    f.exit(); await f.call('terminal:create', ['panel-1', 80, 24])
    const before = f.events.length
    f.child().options.onData('stale bytes'); f.exit()
    gate.release(); expect(await probe).toEqual({ cwd: null })
    expect(f.events).toHaveLength(before); expect(f.child(1).handle.kill).not.toHaveBeenCalled()
  })
  it('rechecks caller read authority after a raw cwd probe completes', async () => {
    const f = fixture(), gate = held(); f.releases.push(gate.release)
    await f.call('terminal:create', ['panel-1', 80, 24])
    f.host.getCwd.mockImplementation(async () => { await gate.promise; return f.cwd })
    const probe = f.call('terminal:getCwd', ['panel-1']), rejected = expect(probe).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await vi.waitFor(() => expect(f.host.getCwd).toHaveBeenCalledOnce())
    f.options.canAccessTerminal = () => false
    gate.release(); await rejected
    expect(f.child().handle.kill).not.toHaveBeenCalled()
  })
  it('refuses same-ID PID reuse without granting or killing a later accepted replacement', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24]); f.exit()
    f.setNextPid(4242)
    await expect(f.call('terminal:create', ['panel-1', 80, 24])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.child(1).handle.kill).toHaveBeenCalledOnce(); expect(f.options.onFatalEvent).toHaveBeenCalledOnce()
    await expect(f.call('terminal:kill', ['panel-1', 4242])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.child(1).handle.kill).toHaveBeenCalledOnce()
    await expect(f.backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    f.exit(1); await f.backend.close()
  })
  it('refuses controlling a foreign core replacement even when its real PID equals the old one', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24])
    f.setNextPid(4242)
    f.core.create({ id: 'panel-1', cols: 80, rows: 24, cwd: f.cwd }, { data() {}, exit() {} })
    expect(f.child().handle.kill).toHaveBeenCalledOnce()
    await expect(f.call('terminal:write', ['panel-1', 'must not reach replacement'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.call('terminal:kill', ['panel-1', 4242])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.call('terminal:create', ['panel-1', 80, 24])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.child(1).handle.write).not.toHaveBeenCalled(); expect(f.child(1).handle.kill).not.toHaveBeenCalled()
    f.child().options.onData('retired output'); f.exit()
    expect(f.events).toEqual([])
  })
  it('preserves the original caller reservation and PID history when a restart spawn fails', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24]); f.exit()
    f.host.create.mockImplementationOnce(() => { throw new Error('Controlled spawn failure') })
    await expect(f.call('terminal:create', ['panel-1', 80, 24])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(f.call('terminal:create', ['panel-1', 80, 24], { ...caller, origin: 'app://trusted-other' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await f.call('terminal:create', ['panel-1', 80, 24])).toEqual({ pid: 4243 })
    expect(f.host.create).toHaveBeenCalledTimes(3)
  })
  it('chunks real source strings without splitting Unicode or controls and preserves the exact data sequence', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24])
    const original = '\x1b[31m'.concat('💬'.repeat(20_000), '\x1b[0m\r\n\0')
    f.child().options.onData(original)
    const chunks = f.events.filter(event => event.operation === 'terminal:data').map(event => (event.payload as { data: string }).data)
    expect(chunks.length).toBeGreaterThan(1); expect(chunks.join('')).toBe(original)
    expect(chunks.every(chunk => new TextEncoder().encode(chunk).length <= TERMINAL_DESKTOP_LIMITS.eventBytes)).toBe(true)
    expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true)
  })
  it('latches publication overflow and retains the killed process until its actual close receipt', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24])
    let count = 0
    f.options.emit = (operation, payload, recipient) => { if (++count === 3) throw new Error('Controlled publisher overflow'); f.events.push({ operation, payload, recipient }) }
    f.child().options.onData('x'.repeat(4 * TERMINAL_DESKTOP_LIMITS.eventBytes))
    expect(f.events.filter(event => event.operation === 'terminal:data')).toHaveLength(2)
    expect(f.options.onFatalEvent).toHaveBeenCalledOnce(); expect(f.child().handle.kill).toHaveBeenCalledOnce()
    await expect(f.call('terminal:write', ['panel-1', 'must not run'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.child().handle.write).not.toHaveBeenCalled()
    await expect(f.backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    f.exit(); await f.backend.close()
  })
  it('keeps accepted input after a cancelled response without replaying it', async () => {
    const f = fixture(), controller = new AbortController(); await f.call('terminal:create', ['panel-1', 80, 24])
    f.child().handle.write.mockImplementation(() => { controller.abort() })
    await expect(f.call('terminal:write', ['panel-1', 'accepted once\r'], caller, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(f.child().handle.write).toHaveBeenCalledExactlyOnceWith('accepted once\r')
    await f.call('terminal:create', ['panel-1', 80, 24]); expect(f.host.create).toHaveBeenCalledOnce()
    f.child().handle.write.mockReturnValueOnce(false)
    await expect(f.call('terminal:write', ['panel-1', 'failed pipe'])).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })
  it('retains an accepted spawn after response cancellation and only attaches on the next create', async () => {
    const f = fixture(), controller = new AbortController(), spawn = f.host.create.getMockImplementation()
    if (!spawn) throw new Error('Missing controlled process factory')
    f.host.create.mockImplementationOnce(options => { const handle = spawn(options); controller.abort(); return handle })
    await expect(f.call('terminal:create', ['panel-1', 80, 24], caller, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(f.core.identity('panel-1')).toMatchObject({ pid: 4242 })
    expect(await f.call('terminal:create', ['panel-1', 80, 24])).toEqual({ pid: 4242 })
    expect(f.host.create).toHaveBeenCalledOnce(); expect(f.child().handle.kill).not.toHaveBeenCalled()
  })
  it('joins the raw cwd probe and native process after shutdown timeout without inventing exit', async () => {
    const f = fixture(), gate = held(); f.releases.push(gate.release)
    await f.call('terminal:create', ['panel-1', 80, 24])
    f.host.getCwd.mockImplementation(async () => { await gate.promise; return f.cwd })
    const probe = f.call('terminal:getCwd', ['panel-1']), rejected = expect(probe).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await vi.waitFor(() => expect(f.host.getCwd).toHaveBeenCalledOnce())
    await expect(f.backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    f.exit()
    await expect(f.backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(f.events.filter(event => event.operation === 'terminal:exit')).toEqual([])
    gate.release(); await rejected; await f.backend.close(); await f.core.close()
  })
  it('returns a wire-bounded recent suffix without changing the core log or forgetting identity tombstones', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24])
    const original = 'x'.repeat(TERMINAL_DESKTOP_LIMITS.bufferBytes)
    f.child().options.onData(original)
    const recent = await f.call('terminal:getBuffer', ['panel-1'])
    expect(recent.lines).toEqual(['x'.repeat(TERMINAL_DESKTOP_LIMITS.bufferBytes - 15)])
    expect(Buffer.byteLength(JSON.stringify(recent))).toBe(TERMINAL_DESKTOP_LIMITS.bufferBytes - 1)
    expect(f.core.getBuffer('panel-1').lines).toEqual([original])
    f.exit()
    for (let index = 1; index < 256; index++) { await f.call('terminal:create', [`panel-${index + 1}`, 80, 24]); f.exit(index) }
    await expect(f.call('terminal:create', ['no-more-identities', 80, 24])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    await expect(f.call('terminal:create', ['panel-1', 80, 24], { ...caller, origin: 'app://trusted-other' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.host.create).toHaveBeenCalledTimes(256)
  })

  it('keeps recent text readable after fragmented ANSI and JSON-expensive Unicode output', async () => {
    const f = fixture(); await f.call('terminal:create', ['panel-1', 80, 24])
    for (const value of ['\x1b[', '31', 'mBE', 'FORE\x1b[0', 'm\r\n', '🧭雪"\\\t'.repeat(100_000), 'LATEST']) f.child().options.onData(value)
    const recent = await f.call('terminal:getBuffer', ['panel-1', 500])
    expect(recent.lines.at(-1)?.endsWith('LATEST')).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(recent))).toBeLessThanOrEqual(TERMINAL_DESKTOP_LIMITS.bufferBytes)
    expect(recent.lines.join('')).not.toContain('\x1b')
    expect(f.options.onFatalEvent).not.toHaveBeenCalled()
    const chunks = f.events.filter(event => event.operation === 'terminal:data').map(event => (event.payload as { data: string }).data)
    expect(chunks.join('')).toBe('\x1b[31mBEFORE\x1b[0m\r\n' + '🧭雪"\\\t'.repeat(100_000) + 'LATEST')
    expect(await f.call('terminal:create', ['panel-1', 100, 40])).toEqual({ pid: 4242 })
    expect(f.host.create).toHaveBeenCalledOnce()
  })
})
