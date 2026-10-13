import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TerminalServiceCore, type TerminalHandle, type PtyOptions } from '../src/main/terminal-service-core'
import { createNodePty, terminalProcessCwd } from '../src/main/terminal-process'
import { TerminalBackend } from '../src/service/terminal-backend'
import type { DesktopCallerContext } from '../src/service/transport/desktop-registry'
import type { DesktopCommandMap } from '../src/shared/desktop-operations'
import { TERMINAL_COMMAND_CODECS, TERMINAL_EVENT_CODECS, type TerminalCommandCodec, type TerminalDesktopOperation, type TerminalDesktopEvent } from '../src/shared/terminal-desktop-codecs'
import type { JsonValue } from '../src/shared/service-protocol'

const linux = process.platform === 'linux'
const enabled = process.env.TAURI_TERMINAL_PROOFS === '1'
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'terminal-proof-epoch', webviewId: 'main', origin: 'app://terminal-proof' }
interface NativeReceipt { pid: number; closed: Promise<void>; exited: boolean; code: unknown; signal: unknown; kills: number }
interface Event { operation: TerminalDesktopEvent; payload: JsonValue; recipient: DesktopCallerContext }
const owned: Array<{ root: string; core: TerminalServiceCore; backend: TerminalBackend; receipts: NativeReceipt[] }> = []

/** Receipt comes only from the real node-pty onExit callback. A kill request,
 * an empty buffer or a suppressed client reply never completes this receipt. */
function fixture() {
  expect(process.env.TAURI_TERMINAL_PROOFS).toBe('1')
  expect(process.versions.electron).toBeUndefined()
  const pins = JSON.parse(readFileSync(resolve('scripts/tauri-runtime.json'), 'utf8')) as { nodeVersion: string; nativeDependencies: { 'node-pty': string } }
  expect(process.version).toBe(`v${pins.nodeVersion}`)
  expect(realpathSync(process.execPath)).toBe(realpathSync(process.env.TAURI_NODE_RUNTIME!))
  const moduleRoot = realpathSync(process.env.TAURI_NODE_PTY_MODULE!)
  expect(moduleRoot).toBe(realpathSync(resolve('src-tauri/resources/service/node_modules/node-pty')))
  const packagePath = realpathSync(join(moduleRoot, 'package.json'))
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { name: string; version: string }
  expect(metadata).toMatchObject({ name: 'node-pty', version: pins.nativeDependencies['node-pty'] })
  const stagedRequire = createRequire(packagePath)
  const pty = stagedRequire(moduleRoot) as typeof import('node-pty')
  const root = realpathSync(mkdtempSync(join(tmpdir(), '21x-staged-terminal-proof-')))
  mkdirSync(join(root, 'nested'))
  const receipts: NativeReceipt[] = [], events: Event[] = [], fatal: string[] = []
  let onAcceptedKill: (() => void) | undefined
  const core = new TerminalServiceCore({
    resolveShell: () => '/bin/bash',
    create(options: PtyOptions): TerminalHandle {
      let finish!: () => void
      const receipt: NativeReceipt = { pid: 0, closed: new Promise<void>(done => { finish = done }), exited: false, code: undefined, signal: undefined, kills: 0 }
      // Use the real production PTY bridge and explicitly staged addon. Only
      // shell startup/environment policy differs: no profile, inherited key,
      // provider process, credential store or user startup file is invoked.
      const handle = createNodePty({ ...options, onExit: (pid, code, signal) => {
        receipt.pid = pid; receipt.code = code; receipt.signal = signal; receipt.exited = true
        options.onExit(pid, code, signal); finish()
      } }, { spawn: (shell, _args, settings) => pty.spawn(shell, ['--noprofile', '--norc'], {
        ...settings, env: { HOME: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', PS1: '', HISTFILE: '/dev/null' }
      }) })
      receipt.pid = handle.pid; receipts.push(receipt)
      return { ...handle, kill: () => { handle.kill(); receipt.kills++; onAcceptedKill?.() } }
    },
    getCwd: terminalProcessCwd
  })
  const backend = new TerminalBackend({ terminals: core, engineEpoch: caller.engineEpoch, assertAvailable() {
    if (!statSync(root).isDirectory()) throw new Error('The approved terminal fixture directory is unavailable')
  },
    isTrustedDesktop: value => value.webviewId === caller.webviewId && value.origin === caller.origin,
    canAccessTerminal: id => /^proof-[a-z]+$/.test(id), resolveDirectory: () => ({ cwd: root, root }),
    emit: (operation, payload, recipient) => {
      expect(TERMINAL_EVENT_CODECS[operation].validatePayload(payload)).toBe(true)
      events.push({ operation, payload, recipient: { ...recipient } })
    }, onFatalEvent: error => { fatal.push(error.code) }
  })
  owned.push({ root, core, backend, receipts })
  async function call<K extends TerminalDesktopOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
    const codec = TERMINAL_COMMAND_CODECS[operation] as TerminalCommandCodec<K>
    const result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
    expect(codec.validateWireResult(result)).toBe(true)
    return codec.decodeResult((result as { defined: boolean; value?: JsonValue }).value)
  }
  const text = (id: string): string => events.filter(event => event.operation === 'terminal:data' && (event.payload as { id: string }).id === id).map(event => (event.payload as { data: string }).data).join('')
  async function ready(id: string) {
    await call('terminal:write', [id, "stty -echo; printf '\\nPROOF_READY\\n'\r"])
    await vi.waitFor(() => expect(text(id)).toMatch(/\r?\nPROOF_READY\r?\n/), { timeout: 5000 })
  }
  return { root, core, backend, receipts, events, fatal, call, text, ready, setKillObserver: (observer: () => void) => { onAcceptedKill = observer } }
}

async function nativeClosed(receipts: NativeReceipt[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.all(receipts.map(receipt => receipt.closed)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned native PTY exit receipt did not arrive')), 3000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

afterEach(async () => {
  for (const item of owned.splice(0)) {
    // Never signal a numeric PID. The exact registered native handles own all
    // cleanup; retain the temporary directory until every native close.
    await item.backend.close(3000)
    await item.core.close(3000)
    await nativeClosed(item.receipts)
    expect(item.receipts.every(receipt => receipt.exited)).toBe(true)
    rmSync(item.root, { recursive: true, force: true })
  }
}, 12_000)

describe.skipIf(!enabled)('explicit staged terminal proof scope', () => {
  it('records the supported OS without claiming an all-platform terminal proof', () => {
    expect(process.env.TAURI_TERMINAL_PROOFS).toBe('1')
    console.info(JSON.stringify({ proof: 'production-terminal', platform: process.platform, scope: linux ? 'real-linux-shell-pty' : 'unsupported-os-no-pty-execution' }))
  })
})

describe.skipIf(!enabled || !linux)('real staged Linux PTY and production terminal boundary', () => {
  it('writes UTF8/control input, resizes, reads cwd, reconnects without respawn and observes native exit', async () => {
    const f = fixture(), result = await f.call('terminal:create', ['proof-shell', 80, 24, f.root])
    expect(result.pid).toBeGreaterThan(0); await f.ready('proof-shell')
    const initial = f.core.identity('proof-shell')!
    expect(await f.call('terminal:getCwd', ['proof-shell', result.pid])).toEqual({ cwd: f.root })
    await f.call('terminal:resize', ['proof-shell', 113, 37])
    await f.call('terminal:write', ['proof-shell', "printf '\\033[31mUTF8:%s\\033[0m\\n' '雪🧭'; printf 'SIZE:%s\\n' \"$(stty size)\"\r"])
    await vi.waitFor(() => {
      expect(f.text('proof-shell')).toContain('\x1b[31mUTF8:雪🧭\x1b[0m')
      expect(f.text('proof-shell')).toMatch(/\r?\nSIZE:37 113\r?\n/)
    }, { timeout: 5000 })
    // Ctrl-U erases unsubmitted terminal input; it must cross the codec intact.
    await f.call('terminal:write', ['proof-shell', "printf 'SHOULD_NOT_EXECUTE'\x15printf 'CONTROL_OK\\n'\r"])
    await vi.waitFor(() => expect(f.text('proof-shell')).toMatch(/\r?\nCONTROL_OK\r?\n/), { timeout: 5000 })
    expect(f.text('proof-shell')).not.toContain('SHOULD_NOT_EXECUTE')
    await f.call('terminal:write', ['proof-shell', "cd nested; printf 'CWD_CHANGED\\n'\r"])
    await vi.waitFor(() => expect(f.text('proof-shell')).toContain('CWD_CHANGED'), { timeout: 5000 })
    expect(await f.call('terminal:getCwd', ['proof-shell', result.pid])).toEqual({ cwd: join(f.root, 'nested') })
    expect(await f.call('terminal:create', ['proof-shell', 100, 30, f.root])).toEqual(result)
    expect(f.core.identity('proof-shell')).toEqual(initial); expect(f.receipts).toHaveLength(1)
    const buffer = (await f.call('terminal:getBuffer', ['proof-shell', 200])).lines.join('\n')
    expect(buffer).toContain('UTF8:雪🧭'); expect(buffer).toContain('SIZE:37 113'); expect(buffer).not.toContain('\x1b[31m')
    expect(f.events.every(event => event.recipient.webviewId === 'main' && event.recipient.origin === caller.origin)).toBe(true)
    await f.call('terminal:write', ['proof-shell', 'exit 7\r'])
    await vi.waitFor(() => expect(f.receipts[0].exited).toBe(true), { timeout: 5000 })
    await nativeClosed(f.receipts)
    expect(f.receipts[0].pid).toBe(result.pid); expect(f.receipts[0].code).toBe(7); expect(f.receipts[0].kills).toBe(0)
    expect(f.events.filter(event => event.operation === 'terminal:exit')).toEqual([{ operation: 'terminal:exit', payload: { id: 'proof-shell' }, recipient: caller }])
    expect(f.core.identity('proof-shell')).toBeNull(); expect(f.fatal).toEqual([])
  }, 25_000)

  it('rejects foreign scope and stale PID requests, acknowledges only the matching owned PTY and drains shutdown', async () => {
    const f = fixture(), first = await f.call('terminal:create', ['proof-first', 80, 24]), second = await f.call('terminal:create', ['proof-second', 80, 24])
    await f.ready('proof-first'); await f.ready('proof-second')
    await expect(f.call('terminal:write', ['proof-first', 'exit\r'], undefined, { ...caller, webviewId: 'foreign' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.call('terminal:create', ['proof-escape', 80, 24, tmpdir()])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.receipts).toHaveLength(2)
    await f.call('terminal:kill', ['proof-first', second.pid])
    expect(f.receipts.map(receipt => receipt.kills)).toEqual([0, 0])
    expect(await f.call('terminal:getCwd', ['proof-first', second.pid])).toEqual({ cwd: null })
    await f.call('terminal:write', ['proof-first', "printf 'STILL_OWNED\\n'\r"])
    await vi.waitFor(() => expect(f.text('proof-first')).toContain('STILL_OWNED'), { timeout: 5000 })
    await f.call('terminal:kill', ['proof-first', first.pid])
    expect(f.receipts[0].exited).toBe(true); expect(f.receipts[0].kills).toBe(1)
    expect(f.core.identity('proof-second')?.pid).toBe(second.pid); expect(f.receipts[1].exited).toBe(false)
    await f.call('terminal:kill', ['proof-first', first.pid])
    expect(f.receipts[0].kills).toBe(1)
    expect(f.events.filter(event => event.operation === 'terminal:exit' && (event.payload as { id: string }).id === 'proof-first')).toHaveLength(1)
    await f.backend.close(3000); await f.core.close(3000)
    expect(f.receipts[1].pid).toBe(second.pid); expect(f.receipts[1].exited).toBe(true); expect(f.receipts[1].kills).toBe(1)
    expect(f.backend.inflightCount).toBe(0); expect(f.fatal).toEqual([])
    console.info(JSON.stringify({ proof: 'production-terminal-owned-exit', nativeSpawns: f.receipts.length, nativeExitReceipts: f.receipts.filter(receipt => receipt.exited).length, stalePidKills: 0 }))
  }, 20_000)

  it('retains an accepted native kill through reply cancellation and does not replay the effect', async () => {
    const f = fixture(), active = await f.call('terminal:create', ['proof-cancel', 80, 24])
    await f.ready('proof-cancel')
    const controller = new AbortController()
    // Abort only after the actual registered handle has accepted kill. Native
    // exit remains unmodified and is still required before ownership drains.
    f.setKillObserver(() => controller.abort())
    await expect(f.call('terminal:kill', ['proof-cancel', active.pid], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await f.backend.close(3000); await f.core.close(3000); await nativeClosed(f.receipts)
    expect(f.receipts[0].exited).toBe(true); expect(f.receipts[0].kills).toBe(1); expect(f.backend.inflightCount).toBe(0)
    expect(f.fatal).toEqual([])
  }, 15_000)
})
