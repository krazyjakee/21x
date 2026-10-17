import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalServiceCore, type PtyOptions, type TerminalProcessHost } from './terminal-service-core'
import { TerminalTextBuffer } from './terminal-text-buffer'

function held() {
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  return { promise, finish }
}
function fixture() {
  const children: { options: PtyOptions; handle: { pid: number; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } }[] = []
  const host = {
    resolveShell: () => 'fixture-shell',
    create: vi.fn((options: PtyOptions) => {
      const handle = { pid: 4242, write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
      children.push({ options, handle })
      return handle
    }),
    getCwd: vi.fn<TerminalProcessHost['getCwd']>().mockResolvedValue('/fixture')
  }
  const events = { data: vi.fn(), exit: vi.fn() }
  const owner = new TerminalServiceCore(host)
  const create = (id = 'panel') => owner.create({ id, cols: 80, rows: 24 }, events)
  const exit = (index: number) => children[index].options.onExit(children[index].handle.pid, 0, null)
  return { owner, host, events, children, create, exit }
}

describe('portable terminal ownership', () => {
  afterEach(() => vi.restoreAllMocks())

  it('recovers identical logical text at every split inside Unicode, CSI, OSC and string escapes', async () => {
    const raw = '雪🧭\x1b[38;2;1;2;3mco\x1b[0mlour\r\n' +
      '\x1b]0;private title\x1b\\next\x1b]8;;https://example.invalid\x07 link\x1b]8;;\x07\n' +
      '\x1bPprivate payload\x1b\\\x1b_hidden payload\x1b\\\x1b(Btail\x07\x00\nlast'
    const f = fixture(); f.create()
    for (let split = 0; split <= raw.length; split++) {
      const log = new TerminalTextBuffer()
      log.append(raw.slice(0, split)); log.append(raw.slice(split))
      expect(log.snapshot(500), `split ${split}`).toEqual(['雪🧭colour', 'next link', 'tail', 'last'])
    }
    for (const character of raw) f.children[0].options.onData(character)
    expect(f.owner.attach('panel', { data: vi.fn(), exit: vi.fn() })?.lines).toEqual(['雪🧭colour', 'next link', 'tail', 'last'])
    // Raw live data is untouched; only the separately labeled text log is parsed.
    expect(f.events.data.mock.calls.map(call => call[1]).join('')).toBe(raw)
    f.exit(0); await f.owner.close()
  })

  it('retains a bounded recent suffix even for a single very long line and exact JSON escaping', async () => {
    const f = fixture(); f.create()
    const raw = 'old\n' + '雪🧭"\\\t'.repeat(200_000) + 'LATEST'
    // Vary callback sizes independently of logical lines.
    for (let i = 0; i < raw.length; i += 8191) f.children[0].options.onData(raw.slice(i, i + 8191))
    const result = f.owner.getBuffer('panel', 500, 512 * 1024)
    expect(result.lines).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024)
    expect(result.lines[0].endsWith('LATEST')).toBe(true)
    expect(raw.endsWith(result.lines[0])).toBe(true)
    expect(result.lines[0]).not.toMatch(/^[\uDC00-\uDFFF]/)
    f.children[0].options.onData('\nAFTER\n')
    expect(f.owner.getBuffer('panel', 1, 512 * 1024)).toEqual({ lines: ['AFTER'] })
    f.exit(0); await f.owner.close()
  })

  it('bounds unterminated escape bodies without leaking them on reconnect and resets parser per process', async () => {
    const f = fixture(); f.create()
    f.children[0].options.onData('before\n\x1b]title;')
    for (let i = 0; i < 20; i++) f.children[0].options.onData('private'.repeat(10_000))
    expect(f.owner.getBuffer('panel')).toEqual({ lines: ['before'] })
    f.children[0].options.onData('\x1b'); f.children[0].options.onData('\\after\n')
    expect(f.owner.getBuffer('panel')).toEqual({ lines: ['before', 'after'] })
    f.children[0].options.onData('\x1b['); f.create()
    f.children[1].options.onData('replacement\n')
    expect(f.owner.getBuffer('panel')).toEqual({ lines: ['replacement'] })
    f.exit(0); f.exit(1); await f.owner.close()
  })

  it('guards stale PID kills and isolates replaced handles even when native PIDs are equal', async () => {
    const f = fixture()
    f.create()
    f.owner.kill('panel', 9999)
    expect(f.children[0].handle.kill).not.toHaveBeenCalled()
    f.create()
    expect(f.children[0].handle.kill).toHaveBeenCalledOnce()
    f.children[0].options.onData('stale')
    f.exit(0)
    expect(f.events.data).not.toHaveBeenCalled()
    expect(f.events.exit).not.toHaveBeenCalled()
    expect(f.owner.write('panel', 'live')).toEqual({ alive: true })
    expect(f.children[1].handle.write).toHaveBeenCalledWith('live')
    f.exit(1)
    expect(f.events.exit).toHaveBeenCalledExactlyOnceWith('panel')
    await f.owner.close()
  })

  it('reconnects a renderer without spawning and retains bounded replay while the old host is gone', async () => {
    const f = fixture()
    f.create()
    f.events.data.mockImplementation(() => { throw new Error('old window destroyed') })
    f.children[0].options.onData('\x1b[31mready\x1b[0m\n')
    const next = { data: vi.fn(), exit: vi.fn() }
    expect(f.owner.attach('panel', next)).toEqual({ pid: 4242, lines: ['ready'] })
    f.children[0].options.onData('next')
    expect(next.data).toHaveBeenCalledExactlyOnceWith('panel', 'next')
    expect(f.host.create).toHaveBeenCalledOnce()
    f.exit(0)
    expect(next.exit).toHaveBeenCalledExactlyOnceWith('panel')
    await f.owner.close()
  })

  it('retains killed and replaced processes after failed close until actual close, with no late events', async () => {
    const f = fixture()
    f.create()
    f.create()
    f.owner.kill('panel', 4242)
    await expect(f.owner.close(5)).rejects.toThrow('TERMINAL_SHUTDOWN_INCOMPLETE')
    f.exit(0)
    await expect(f.owner.close(5)).rejects.toThrow('TERMINAL_SHUTDOWN_INCOMPLETE')
    f.children[1].options.onData('late')
    const retry = f.owner.close()
    f.exit(1)
    await retry
    expect(f.events.data).not.toHaveBeenCalled()
    expect(f.events.exit).not.toHaveBeenCalled()
    expect(f.children.map(child => child.handle.kill.mock.calls.length)).toEqual([1, 1])
    expect(() => f.create()).toThrow('TERMINAL_SERVICE_CLOSED')
  })

  it('joins a raw cwd probe after shutdown and discards its stale result', async () => {
    const f = fixture(), gate = held()
    f.create()
    f.host.getCwd.mockImplementation(async (_pid, isCurrent) => {
      await gate.promise
      expect(isCurrent()).toBe(false)
      return '/stale'
    })
    const request = f.owner.getCwd('panel', 4242)
    await Promise.resolve()
    f.owner.shutdown()
    f.exit(0)
    try {
      await expect(f.owner.close(5)).rejects.toThrow('TERMINAL_SHUTDOWN_INCOMPLETE')
      const retry = f.owner.close()
      gate.finish()
      expect(await request).toEqual({ cwd: null })
      await retry
    } finally { gate.finish(); await request; await f.owner.close() }
  })

  it('does not probe a stale PID or queued request after shutdown', async () => {
    const f = fixture()
    f.create()
    expect(await f.owner.getCwd('panel', 9999)).toEqual({ cwd: null })
    const request = f.owner.getCwd('panel')
    f.owner.shutdown()
    f.exit(0)
    await f.owner.close()
    expect(await request).toEqual({ cwd: null })
    expect(f.host.getCwd).not.toHaveBeenCalled()
  })

  it('bounds retained lines and characters, validates inputs, and handles write/resize after native exit races', async () => {
    const f = fixture()
    f.create()
    f.children[0].options.onData('line\n'.repeat(1000))
    expect(f.owner.getBuffer('panel', 1000).lines).toHaveLength(500)
    for (let n = 0; n < 3; n++) f.children[0].options.onData('x'.repeat(800_000))
    expect(f.owner.getBuffer('panel', 500).lines.join('').length).toBeLessThanOrEqual(1_000_000)
    expect(() => f.owner.getBuffer('panel', -1)).toThrow('Invalid terminal line count')
    expect(() => f.owner.resize('panel', 0, 24)).toThrow('Invalid terminal size')
    expect(() => f.owner.write('panel', 'x'.repeat(1_000_001))).toThrow('Invalid terminal input')
    f.children[0].handle.write.mockReturnValueOnce(false)
    expect(f.owner.write('panel', 'closed pipe')).toEqual({ alive: false })
    f.children[0].handle.write.mockImplementation(() => { throw new Error('gone') })
    f.children[0].handle.resize.mockImplementation(() => { throw new Error('gone') })
    expect(f.owner.write('panel', 'test')).toEqual({ alive: false })
    expect(() => f.owner.resize('panel', 80, 24)).not.toThrow()
    f.exit(0)
    await f.owner.close()
  })

  it('keeps retired handles counted against capacity until close and validates deadlines before shutdown', async () => {
    const f = fixture()
    for (let n = 0; n < 64; n++) f.create()
    expect(() => f.create()).toThrow('TERMINAL_CAPACITY_EXCEEDED')
    await expect(f.owner.close(0)).rejects.toBeInstanceOf(RangeError)
    f.exit(0)
    f.create()
    f.owner.shutdown()
    for (let n = 1; n < f.children.length; n++) f.exit(n)
    await f.owner.close()
  })

  it('releases a failed spawn and a synchronous exit without reviving the terminal', async () => {
    const f = fixture()
    f.host.create.mockImplementationOnce(() => { throw new Error('spawn failed') })
    expect(() => f.create()).toThrow('spawn failed')
    expect(f.owner.getBuffer('panel')).toEqual({ lines: [] })
    f.host.create.mockImplementationOnce(options => {
      options.onExit(4242, 0, null)
      return { pid: 4242, write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
    })
    f.create()
    expect(f.owner.write('panel', 'late')).toEqual({ alive: false })
    await f.owner.close()
  })

  it('retries a thrown kill on the owned handle and never emits duplicate exits', async () => {
    const f = fixture()
    f.create()
    f.children[0].handle.kill.mockImplementationOnce(() => { throw new Error('fixture transient failure') })
    f.owner.shutdown()
    const closing = f.owner.close()
    expect(f.children[0].handle.kill).toHaveBeenCalledTimes(2)
    f.exit(0)
    f.exit(0)
    await closing
    expect(f.events.exit).not.toHaveBeenCalled()
  })
})
