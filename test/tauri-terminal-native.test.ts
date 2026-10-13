import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStandaloneTerminalService } from '../src/main/terminal-service'

const stagedRequire = createRequire(join(process.cwd(), 'src-tauri/resources/service/package.json'))
const pty = stagedRequire('node-pty') as typeof import('node-pty')

describe('actual staged standalone terminal owner', () => {
  it('spawns the owning Node fixture, resizes, reattaches, buffers, guards stale kills and joins native exit', async () => {
    expect(process.versions.electron).toBeUndefined()
    expect(stagedRequire('node-pty/package.json').version).toBe('1.1.0')
    // macOS aliases /var to /private/var; cwd reports the physical path.
    const root = realpathSync(mkdtempSync(join(tmpdir(), '21x-terminal-native-')))
    const fixtureScript = `
      process.stdin.setRawMode(true);
      process.stdout.write('FIXTURE_READY\\n');
      let pending = '';
      process.stdin.on('data', data => {
        pending += data.toString();
        let newline;
        while ((newline = pending.search(/[\\r\\n]/)) >= 0) {
          const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
          if (line === 'size') process.stdout.write('FIXTURE_SIZE=' + process.stdout.columns + 'x' + process.stdout.rows + '\\n');
          if (line === 'cwd') process.stdout.write('FIXTURE_CWD=' + process.cwd() + '\\n');
        }
      });
    `
    // Exercise the real native PTY without reading any user's shell startup files.
    const owner = createStandaloneTerminalService({
      spawn: (_shell, _args, options) => pty.spawn(process.execPath, ['-e', fixtureScript], options)
    })
    let first = '', second = ''
    let pid = 0
    try {
      const result = owner.create({ id: 'native-fixture', cols: 80, rows: 24, cwd: root }, {
        data: (_id, data) => { first += data }, exit: () => {}
      })
      pid = result.pid
      expect(pid).toBeGreaterThan(0)
      await vi.waitFor(() => expect(first).toContain('FIXTURE_READY'), { timeout: 5000 })
      owner.resize('native-fixture', 120, 40)
      const attached = owner.attach('native-fixture', { data: (_id, data) => { second += data }, exit: () => {} })
      expect(attached?.pid).toBe(pid)
      expect(attached?.lines.join('\n')).toContain('FIXTURE_READY')
      owner.kill('native-fixture', pid + 1)
      expect(owner.write('native-fixture', 'size\rcwd\r')).toEqual({ alive: true })
      await vi.waitFor(() => {
        // ConPTY emits screen control sequences around otherwise ordinary output.
        const plain = second.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        // Windows delivers resize notifications while reading a raw TTY. The
        // first input can race that notification, so request another sample.
        if (!plain.includes('FIXTURE_SIZE=120x40')) owner.write('native-fixture', 'size\r')
        expect(plain, JSON.stringify({ raw: second, plain })).toContain('FIXTURE_SIZE=120x40')
        expect(plain, JSON.stringify({ raw: second, plain })).toContain('FIXTURE_CWD=' + root)
      }, { timeout: 5000 })
      expect(owner.getBuffer('native-fixture').lines.join('\n')).toContain('FIXTURE_SIZE=120x40')
      await owner.close(3000)
      expect(() => owner.write('native-fixture', 'late')).toThrow('TERMINAL_SERVICE_CLOSED')
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 })
    } finally {
      await owner.close(3000)
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
